// Direct PGS blocks using the selective EBML reader adapted from Subtitle Edit.
// See README.md and LICENSE.SubtitleEdit for provenance.
import type { Element } from './SelectiveMatroskaReader.ts';
import { open } from 'node:fs/promises';
import {
  Id,
  Reader,
  UnsupportedMatroskaError,
} from './SelectiveMatroskaReader.ts';

export type PgsBlock = {
  timestampNs: bigint;
  durationNs: bigint | null;
  data: Buffer;
};

export async function readPgsBlocks(
  inputPath: string,
  streamIndex: number,
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0)
    throw new Error('Expected a nonnegative stream index');
  const input = await open(inputPath, 'r');
  try {
    const size = (await input.stat()).size;
    const reader = new Reader(input, size, { signal });
    const header = await reader.element(0, size);
    if (header.id !== Id.ebml || header.unknown)
      throw new UnsupportedMatroskaError('Expected EBML header');
    const segment = await reader.element(header.end, size);
    if (segment.id !== Id.segment)
      throw new UnsupportedMatroskaError('Expected Matroska segment');
    let info: Element | undefined;
    let tracks: Element | undefined;
    for (let position = segment.data; position < segment.end; ) {
      const item = await reader.element(position, segment.end);
      if (item.unknown)
        throw new UnsupportedMatroskaError(
          'Conversion requires finite clusters',
        );
      if (item.id === Id.info) info = item;
      if (item.id === Id.tracks) tracks = item;
      if (info && tracks) break;
      position = item.end;
    }
    if (!info || !tracks) throw new Error('Missing Matroska metadata');
    let timestampScaleNs = 1_000_000n;
    for await (const field of reader.children(info)) {
      if (field.id === 0x2ad7b1)
        timestampScaleNs = BigInt(await reader.uint(field));
    }
    if (timestampScaleNs <= 0n) throw new Error('Invalid timestamp scale');
    let selectedTrack: number | undefined;
    const mediaTracks = new Set<number>();
    let index = 0;
    for await (const entry of reader.children(tracks)) {
      if (entry.id !== Id.trackEntry) continue;
      let number: number | undefined;
      let type: number | undefined;
      let codec: string | undefined;
      let codecDelay = 0;
      let hasTrackScale = false;
      let hasEncoding = false;
      for await (const field of reader.children(entry)) {
        if (field.id === Id.trackNumber) number = await reader.uint(field);
        if (field.id === Id.trackType) type = await reader.uint(field);
        if (field.id === Id.codecId)
          codec = (
            await reader.read(field.data, field.end - field.data)
          ).toString('utf8');
        if (field.id === 0x56aa) codecDelay = await reader.uint(field);
        if (field.id === 0x23314f) hasTrackScale = true;
        if (field.id === 0x6d80) hasEncoding = true;
      }
      if (number === undefined) throw new Error('Track has no number');
      if (
        (index === streamIndex || type === 1 || type === 2) &&
        (codecDelay !== 0 || hasTrackScale)
      ) {
        throw new UnsupportedMatroskaError(
          'Codec delay and track timestamp scaling are unsupported',
        );
      }
      if (type === 1 || type === 2) mediaTracks.add(number);
      if (index === streamIndex) {
        if (type !== 17 || codec !== 'S_HDMV/PGS' || hasEncoding) {
          throw new UnsupportedMatroskaError(
            'Conversion requires an unencoded PGS track',
          );
        }
        selectedTrack = number;
      }
      index++;
    }
    if (selectedTrack === undefined) throw new Error('PGS track is absent');
    const firstMediaTimes = new Map<number, bigint>();
    const blocks: PgsBlock[] = [];
    let payloadBytes = 0;
    for (let position = segment.data; position < segment.end; ) {
      const cluster = await reader.element(position, segment.end);
      position = cluster.end;
      if (cluster.unknown)
        throw new UnsupportedMatroskaError(
          'Conversion requires finite clusters',
        );
      if (cluster.id !== Id.cluster) continue;
      let clusterTimestamp: bigint | undefined;
      let clusterPayloadBytes = 0;
      for await (const child of reader.children(cluster)) {
        if (child.id === Id.timestamp)
          clusterTimestamp = BigInt(await reader.uint(child));
        if (child.id !== Id.simpleBlock && child.id !== Id.blockGroup) continue;
        if (clusterTimestamp === undefined)
          throw new UnsupportedMatroskaError(
            'Cluster timestamp must precede blocks',
          );
        let block = child.id === Id.simpleBlock ? child : undefined;
        let durationNs: bigint | null = null;
        if (child.id === Id.blockGroup) {
          for await (const field of reader.children(child)) {
            if (field.id === Id.block) block = field;
            if (field.id === 0x9b)
              durationNs = BigInt(await reader.uint(field)) * timestampScaleNs;
          }
        }
        if (!block) continue;
        const track = await reader.vint(block.data);
        const number = Number(track.value);
        const neededAnchor =
          mediaTracks.has(number) && !firstMediaTimes.has(number);
        if (number !== selectedTrack && !neededAnchor) continue;
        const fixedHeader = block.data + track.width;
        if (fixedHeader + 3 > block.end)
          throw new Error('Truncated block header');
        const bytes = await reader.read(fixedHeader, 3);
        const timestampNs =
          (clusterTimestamp + BigInt(bytes.readInt16BE(0))) * timestampScaleNs;
        if (neededAnchor) firstMediaTimes.set(number, timestampNs);
        if (number !== selectedTrack) continue;
        if ((bytes.readUInt8(2) & 0x06) !== 0)
          throw new UnsupportedMatroskaError('Laced PGS is unsupported');
        const length = block.end - fixedHeader - 3;
        payloadBytes += length;
        clusterPayloadBytes += length;
        if (
          payloadBytes > 256 * 1024 * 1024 ||
          clusterPayloadBytes > 64 * 1024 * 1024
        )
          throw new Error('PGS payload limit exceeded');
        const data = await reader.read(fixedHeader + 3, length);
        blocks.push({ timestampNs, durationNs, data });
      }
    }
    if (firstMediaTimes.size === 0)
      throw new UnsupportedMatroskaError('No audio/video timing anchor');
    const sourceOriginNs = [...firstMediaTimes.values()].reduce((a, b) =>
      a < b ? a : b,
    );
    return {
      sourceOriginNs,
      timestampScaleNs,
      firstMediaTimes: [...firstMediaTimes],
      blocks: blocks.map((block) => ({
        ...block,
        timestampNs: block.timestampNs - sourceOriginNs,
      })),
      bytesRead: reader.bytesRead,
      payloadBytes,
      sourceBytes: size,
    };
  } finally {
    await input.close();
  }
}

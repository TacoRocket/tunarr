// Selective block reading adapted from Subtitle Edit (MIT).
// See README.md and LICENSE.SubtitleEdit for provenance and differences.
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

const Id = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  info: 0x1549a966,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  crc: 0xbf,
};
const MaxElementBytes = 16 * 1024 * 1024;
const MaxClusterBytes = 64 * 1024 * 1024;
const MaxOutputBytes = 256 * 1024 * 1024;

export class UnsupportedMatroskaError extends Error {}

export type SelectiveMatroskaOptions = {
  signal?: AbortSignal;
  onProgress?: (position: number, bytesRead: number) => void;
};

type Element = {
  id: number;
  start: number;
  data: number;
  end: number;
  unknown: boolean;
};

class Reader {
  bytesRead = 0;
  private buffer = Buffer.alloc(4096);
  private bufferStart = -1;
  private bufferLength = 0;

  constructor(
    readonly file: FileHandle,
    readonly size: number,
    readonly options: SelectiveMatroskaOptions,
  ) {}

  async read(position: number, length: number): Promise<Buffer> {
    this.options.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MaxElementBytes ||
      position < 0 ||
      position + length > this.size
    ) {
      throw new Error('Invalid or oversized Matroska element');
    }
    const result = Buffer.alloc(length);
    let copied = 0;
    while (copied < length) {
      this.options.signal?.throwIfAborted();
      const offset = position + copied;
      if (
        offset < this.bufferStart ||
        offset >= this.bufferStart + this.bufferLength
      ) {
        const read = await this.file.read(
          this.buffer,
          0,
          Math.min(this.buffer.length, this.size - offset),
          offset,
        );
        this.options.signal?.throwIfAborted();
        if (read.bytesRead === 0) throw new Error('Truncated Matroska input');
        this.bufferStart = offset;
        this.bufferLength = read.bytesRead;
        this.bytesRead += read.bytesRead;
      }
      const start = offset - this.bufferStart;
      const count = Math.min(length - copied, this.bufferLength - start);
      this.buffer.copy(result, copied, start, start + count);
      copied += count;
    }
    this.options.onProgress?.(position + length, this.bytesRead);
    return result;
  }

  async vint(position: number, keepMarker = false) {
    const first = (await this.read(position, 1)).readUInt8(0);
    if (first === 0)
      throw new Error('Invalid Matroska variable-length integer');
    let width = 1;
    while ((first & (0x80 >> (width - 1))) === 0) width++;
    if (keepMarker && width > 4) throw new Error('Invalid Matroska element ID');
    const bytes = await this.read(position, width);
    let value = BigInt(keepMarker ? first : first & (0xff >> width));
    for (let i = 1; i < width; i++)
      value = (value << 8n) | BigInt(bytes.readUInt8(i));
    return {
      value,
      width,
      unknown: !keepMarker && value === (1n << BigInt(width * 7)) - 1n,
    };
  }

  async element(position: number, parentEnd: number): Promise<Element> {
    const id = await this.vint(position, true);
    const size = await this.vint(position + id.width);
    const data = position + id.width + size.width;
    if (size.value > BigInt(Number.MAX_SAFE_INTEGER) && !size.unknown)
      throw new Error('Matroska size exceeds safe integer range');
    const end = size.unknown ? parentEnd : data + Number(size.value);
    if (data > parentEnd || end > parentEnd || end < data)
      throw new Error('Matroska element exceeds its parent');
    return {
      id: Number(id.value),
      start: position,
      data,
      end,
      unknown: size.unknown,
    };
  }

  async *children(parent: Element) {
    let position = parent.data;
    while (position < parent.end) {
      const child = await this.element(position, parent.end);
      if (child.unknown)
        throw new UnsupportedMatroskaError('Unknown-sized Matroska child');
      yield child;
      position = child.end;
    }
  }

  raw(element: Element) {
    return this.read(element.start, element.end - element.start);
  }

  async uint(element: Element) {
    const length = element.end - element.data;
    if (length < 1 || length > 8)
      throw new Error('Invalid Matroska unsigned integer');
    const bytes = await this.read(element.data, length);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Matroska integer exceeds safe range');
    return Number(value);
  }
}

function encodeElement(id: number, payload: Buffer) {
  const hex = id.toString(16);
  const idBytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  let width = 1;
  while (payload.length >= 2 ** (width * 7) - 1) width++;
  let value = BigInt(payload.length) | (1n << BigInt(width * 7));
  const sizeBytes = Buffer.alloc(width);
  for (let i = width - 1; i >= 0; i--) {
    sizeBytes[i] = Number(value & 255n);
    value >>= 8n;
  }
  return Buffer.concat([idBytes, sizeBytes, payload]);
}

/** Read only headers and selected subtitle payloads, then leave format conversion to FFmpeg. */
export async function createSubtitleMatroska(
  inputPath: string,
  outputPath: string,
  streamIndexes: number[],
  options: SelectiveMatroskaOptions = {},
): Promise<{
  streamIndexes: Map<number, number>;
  bytesRead: number;
  sourceSizeBytes: number;
}> {
  if (
    streamIndexes.length === 0 ||
    streamIndexes.some((index) => !Number.isSafeInteger(index) || index < 0)
  ) {
    throw new Error('At least one valid subtitle stream index is required');
  }
  const input = await open(inputPath, 'r');
  let output: FileHandle | undefined;
  try {
    const size = (await input.stat()).size;
    const reader = new Reader(input, size, options);
    const header = await reader.element(0, size);
    if (header.id !== Id.ebml || header.unknown)
      throw new UnsupportedMatroskaError(
        'Input is not a supported Matroska file',
      );
    const segment = await reader.element(header.end, size);
    if (segment.id !== Id.segment)
      throw new UnsupportedMatroskaError('Missing Matroska segment');

    // Metadata can appear after clusters. Locate it without reading cluster payloads.
    let info: Element | undefined;
    let tracks: Element | undefined;
    for (let position = segment.data; position < segment.end; ) {
      const element = await reader.element(position, segment.end);
      if (element.unknown)
        throw new UnsupportedMatroskaError('Unknown-sized Matroska cluster');
      if (element.id === Id.info) info = element;
      if (element.id === Id.tracks) tracks = element;
      if (info && tracks) break;
      position = element.end;
    }
    if (!info || !tracks) throw new Error('Matroska metadata is incomplete');
    if (
      info.end - info.start > MaxElementBytes ||
      tracks.end - tracks.start > MaxElementBytes
    ) {
      throw new Error('Matroska metadata exceeds 16 MiB');
    }
    const selectedTrackNumbers = new Set<number>();
    const trackEntries: Buffer[] = [];
    const mapping = new Map<number, number>();
    let index = 0;
    for await (const entry of reader.children(tracks)) {
      if (entry.id !== Id.trackEntry) continue;
      if (streamIndexes.includes(index)) {
        let number: number | undefined;
        let type: number | undefined;
        let codec: string | undefined;
        for await (const field of reader.children(entry)) {
          if (field.id === Id.trackNumber) number = await reader.uint(field);
          if (field.id === Id.trackType) type = await reader.uint(field);
          if (field.id === Id.codecId)
            codec = (
              await reader.read(field.data, field.end - field.data)
            ).toString('utf8');
        }
        if (
          type !== 17 ||
          number === undefined ||
          number < 1 ||
          !codec?.startsWith('S_TEXT/')
        ) {
          throw new UnsupportedMatroskaError(
            'Requested stream is not a Matroska text subtitle track',
          );
        }
        mapping.set(index, index);
        selectedTrackNumbers.add(number);
      }
      trackEntries.push(await reader.raw(entry));
      index++;
    }
    if (mapping.size !== new Set(streamIndexes).size)
      throw new UnsupportedMatroskaError('Requested subtitle stream is absent');

    output = await open(outputPath, 'wx');
    let outputBytes = 0;
    const write = async (buffer: Buffer) => {
      options.signal?.throwIfAborted();
      outputBytes += buffer.length;
      if (outputBytes > MaxOutputBytes)
        throw new Error('Extracted Matroska subtitles exceed 256 MiB');
      if (!output) throw new Error('Subtitle output is closed');
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await output.write(
          buffer,
          offset,
          buffer.length - offset,
        );
        if (bytesWritten === 0)
          throw new Error('Unable to write subtitle output');
        offset += bytesWritten;
      }
    };
    await write(await reader.raw(header));
    // Unknown-length Segment avoids a second output pass to patch its length.
    await write(Buffer.from('1853806701ffffffffffffff', 'hex'));
    const infoParts: Buffer[] = [];
    for await (const field of reader.children(info)) {
      if (field.id !== Id.crc) infoParts.push(await reader.raw(field));
    }
    await write(encodeElement(Id.info, Buffer.concat(infoParts)));
    await write(encodeElement(Id.tracks, Buffer.concat(trackEntries)));

    // The first packet of every other track preserves FFmpeg's source start-time
    // calculation. A subtitle-only file would otherwise rebase its first cue to zero.
    const anchoredTracks = new Set<number>();
    const includeBlock = async (block: Element) => {
      const track = await reader.vint(block.data);
      if (block.data + track.width + 3 > block.end)
        throw new Error('Truncated Matroska block header');
      const number = Number(track.value);
      if (selectedTrackNumbers.has(number)) return true;
      if (anchoredTracks.has(number)) return false;
      anchoredTracks.add(number);
      return true;
    };
    for (let position = segment.data; position < segment.end; ) {
      const cluster = await reader.element(position, segment.end);
      if (cluster.unknown)
        throw new UnsupportedMatroskaError('Unknown-sized Matroska cluster');
      position = cluster.end;
      if (cluster.id !== Id.cluster) continue;
      const parts: Buffer[] = [];
      let timestamp: Buffer | undefined;
      let clusterBytes = 0;
      for await (const element of reader.children(cluster)) {
        if (element.id === Id.timestamp) {
          timestamp = await reader.raw(element);
          continue;
        }
        let selected = false;
        if (element.id === Id.simpleBlock)
          selected = await includeBlock(element);
        if (element.id === Id.blockGroup) {
          for await (const child of reader.children(element)) {
            if (child.id === Id.block) selected = await includeBlock(child);
          }
        }
        if (selected) {
          clusterBytes += element.end - element.start;
          if (clusterBytes > MaxClusterBytes)
            throw new Error('Subtitle cluster exceeds 64 MiB');
          parts.push(await reader.raw(element));
        }
      }
      if (parts.length > 0) {
        if (!timestamp) throw new Error('Matroska cluster has no timestamp');
        await write(
          encodeElement(Id.cluster, Buffer.concat([timestamp, ...parts])),
        );
      }
      options.onProgress?.(position, reader.bytesRead);
    }
    return {
      streamIndexes: mapping,
      bytesRead: reader.bytesRead,
      sourceSizeBytes: size,
    };
  } finally {
    await output?.close();
    await input.close();
  }
}

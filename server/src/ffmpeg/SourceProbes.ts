import { ChildProcessHelper } from '../util/ChildProcessHelper.ts';
import { LoggerFactory } from '../util/logging/LoggerFactory.ts';
import { FrameSize } from './builder/types.ts';

// Facts about a local source file that some FFmpeg arguments need before the
// transcode starts. They used to come from a deployment-side FFmpeg wrapper;
// Tunarr now probes them where it decides on those arguments.

const logger = LoggerFactory.child({ className: 'SourceProbes' });

export type FfprobeRunner = (
  args: string[],
  timeoutMs: number,
) => Promise<string>;

type StreamBitrateProbe = {
  streams?: { codec_type?: string; bit_rate?: string }[];
  format?: { bit_rate?: string };
};

/**
 * Bits per second to label an HLS stream copy with, or undefined when it
 * needs no label. FFmpeg's HLS muxer fills the master playlist's BANDWIDTH
 * from the streams' bitrates. Containers such as Matroska usually store none,
 * so a stream copy gets no BANDWIDTH, which some players reject. With stream
 * copy, `-b:v` only sets that label; nothing is encoded.
 */
export function hlsCopyBandwidth(
  probe: StreamBitrateProbe,
): number | undefined {
  const streamBitrateKnown = (probe.streams ?? []).some(
    (stream) =>
      (stream.codec_type === 'video' || stream.codec_type === 'audio') &&
      Number(stream.bit_rate ?? 0) > 0,
  );
  if (streamBitrateKnown) {
    return;
  }
  const total = Number(probe.format?.bit_rate ?? 0);
  return total > 0 ? Math.round(total) : undefined;
}

/**
 * Canvas size from the presentation composition segment in a PGS packet,
 * given as ffprobe's `-show_data` hex dump.
 */
export function pgsCanvasFromHexDump(dump: string): FrameSize | undefined {
  const hex = dump
    .split('\n')
    .filter((line) => line.includes(':'))
    .map((line) => line.slice(line.indexOf(':') + 1).split('  ')[0]!)
    .join('')
    .replace(/\s/g, '');
  const data = Buffer.from(hex, 'hex');
  let offset = 0;
  while (offset + 3 <= data.length) {
    const kind = data[offset]!;
    const length = data.readUInt16BE(offset + 1);
    if (offset + 3 + length > data.length) {
      throw new Error('Truncated PGS segment');
    }
    if (kind === 0x16 && length >= 4) {
      const width = data.readUInt16BE(offset + 3);
      const height = data.readUInt16BE(offset + 5);
      if (width <= 0 || height <= 0) {
        throw new Error('Invalid PGS canvas');
      }
      return FrameSize.create({ width, height });
    }
    offset += 3 + length;
  }
  return;
}

export class SourceProbes {
  constructor(
    private run: FfprobeRunner,
    private canvasCache: PgsCanvasCache,
  ) {}

  /** Probes with the configured ffprobe, sharing one canvas cache. */
  static forFfprobe(ffprobePath: string) {
    return new SourceProbes(
      (args, timeout) =>
        new ChildProcessHelper().getStdout(ffprobePath, args, {
          swallowError: false,
          isPath: true,
          timeout,
        }),
      sharedCanvasCache,
    );
  }

  /** See {@link hlsCopyBandwidth}. Undefined when the probe fails. */
  async hlsCopyBandwidth(path: string): Promise<number | undefined> {
    try {
      const output = await this.run(
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,bit_rate:format=bit_rate',
          '-of',
          'json',
          path,
        ],
        30_000,
      );
      return hlsCopyBandwidth(JSON.parse(output) as StreamBitrateProbe);
    } catch (e) {
      logger.warn(e, 'Could not probe stream bitrates of %s', path);
      return;
    }
  }

  /**
   * Canvas of the PGS track at `streamIndex`. Undefined when it can't be read;
   * the transcode then runs without `-canvas_size`, as before.
   */
  pgsCanvas(path: string, streamIndex: number): Promise<FrameSize | undefined> {
    return this.canvasCache.get(path, streamIndex, () =>
      this.probePgsCanvas(path, streamIndex),
    );
  }

  private async probePgsCanvas(path: string, streamIndex: number) {
    try {
      // Read from the start of the file: probing at the tune-in position
      // timed out on some files.
      const output = await this.run(
        [
          '-v',
          'error',
          '-select_streams',
          `${streamIndex}`,
          '-read_intervals',
          '0%+#1',
          '-show_packets',
          '-show_data',
          '-show_entries',
          'packet=data',
          '-of',
          'json',
          path,
        ],
        20_000,
      );
      const packets =
        (JSON.parse(output) as { packets?: { data?: string }[] }).packets ?? [];
      for (const packet of packets) {
        const canvas = packet.data
          ? pgsCanvasFromHexDump(packet.data)
          : undefined;
        if (canvas) {
          return canvas;
        }
      }
      logger.warn('No PGS canvas found in track %d of %s', streamIndex, path);
    } catch (e) {
      logger.warn(e, 'Could not probe the PGS canvas of %s', path);
    }
    return;
  }
}

/**
 * Canvas per file and track, so only the first tune-in of an item pays for
 * the probe. Capped at {@link PgsCanvasCache.Limit} entries, oldest dropped
 * first. A miss is retried after {@link PgsCanvasCache.MissRetryMs}, so a
 * failing probe doesn't delay every tune-in.
 */
export class PgsCanvasCache {
  static Limit = 256;
  static MissRetryMs = 60 * 60 * 1000;

  readonly #entries = new Map<
    string,
    { canvas: FrameSize | undefined; at: number }
  >();

  async get(
    path: string,
    streamIndex: number,
    probe: () => Promise<FrameSize | undefined>,
    now: number = Date.now(),
  ): Promise<FrameSize | undefined> {
    const key = `${streamIndex}:${path}`;
    const entry = this.#entries.get(key);
    if (
      entry &&
      (entry.canvas || now - entry.at < PgsCanvasCache.MissRetryMs)
    ) {
      // Re-insert so the oldest entry is the least recently used.
      this.#entries.delete(key);
      this.#entries.set(key, entry);
      return entry.canvas;
    }
    const canvas = await probe();
    this.#entries.delete(key);
    this.#entries.set(key, { canvas, at: now });
    while (this.#entries.size > PgsCanvasCache.Limit) {
      this.#entries.delete(this.#entries.keys().next().value!);
    }
    return canvas;
  }
}

// Stream factories are created per stream, so the cache lives here.
const sharedCanvasCache = new PgsCanvasCache();

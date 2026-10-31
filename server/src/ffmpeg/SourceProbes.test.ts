import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameSize } from './builder/types.ts';
import {
  hlsCopyBandwidth,
  PgsCanvasCache,
  pgsCanvasFromHexDump,
  SourceProbes,
} from './SourceProbes.ts';

// ffprobe's `-show_data` layout: offset, eight 2-byte groups, ASCII column.
function hexDump(bytes: number[]): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const groups: string[] = [];
    for (let j = 0; j < chunk.length; j += 2) {
      groups.push(
        chunk
          .slice(j, j + 2)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(''),
      );
    }
    const ascii = chunk
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
      .join('');
    lines.push(
      `${i.toString(16).padStart(8, '0')}: ${groups.join(' ').padEnd(39)}  ${ascii}`,
    );
  }
  return `\n${lines.join('\n')}\n`;
}

// Presentation composition segment: type, 2-byte length, then width, height.
const pcs = (width: number, height: number) => [
  0x16,
  0x00,
  0x13,
  width >> 8,
  width & 0xff,
  height >> 8,
  height & 0xff,
  0x10,
  ...Array<number>(14).fill(0),
];
const palette = [0x14, 0x00, 0x02, 0x00, 0x00];

describe('hlsCopyBandwidth', () => {
  it("uses the container's bitrate when no stream has one", () => {
    expect(
      hlsCopyBandwidth({
        streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
        format: { bit_rate: '26261316' },
      }),
    ).toBe(26_261_316);
  });

  it('leaves the label off when a stream already has a bitrate', () => {
    expect(
      hlsCopyBandwidth({
        streams: [{ codec_type: 'video', bit_rate: '22357006' }],
        format: { bit_rate: '26261316' },
      }),
    ).toBeUndefined();
  });

  it('ignores subtitle bitrates', () => {
    expect(
      hlsCopyBandwidth({
        streams: [{ codec_type: 'subtitle', bit_rate: '1000' }],
        format: { bit_rate: '5000' },
      }),
    ).toBe(5000);
  });

  it('gives no label when the bitrate is unknown', () => {
    expect(
      hlsCopyBandwidth({ streams: [], format: { bit_rate: 'N/A' } }),
    ).toBeUndefined();
  });
});

describe('pgsCanvasFromHexDump', () => {
  it('reads the canvas from a presentation composition segment', () => {
    expect(pgsCanvasFromHexDump(hexDump(pcs(1920, 1080)))).toEqual(
      FrameSize.create({ width: 1920, height: 1080 }),
    );
  });

  it('reads real ffprobe output, even with ":" and double spaces in its text column', () => {
    // ffprobe 8.1.2 `-show_data` of a palette segment, a composition segment
    // and the bytes ":  A".
    const dump =
      '\n00000000: 1400 0200 0016 0013 0780 0438 1000 0000  ...........8....\n' +
      '00000010: 0000 0000 0000 0000 0000 003a 2020 41    ...........:  A\n';
    expect(pgsCanvasFromHexDump(dump)).toEqual(
      FrameSize.create({ width: 1920, height: 1080 }),
    );
  });

  it('skips segments before the composition segment', () => {
    expect(
      pgsCanvasFromHexDump(hexDump([...palette, ...pcs(3840, 2160)])),
    ).toEqual(FrameSize.create({ width: 3840, height: 2160 }));
  });

  it('finds nothing without a composition segment', () => {
    expect(pgsCanvasFromHexDump(hexDump(palette))).toBeUndefined();
  });

  it('rejects a truncated segment', () => {
    expect(() =>
      pgsCanvasFromHexDump(hexDump([0x16, 0x00, 0x13, 0x07, 0x80])),
    ).toThrow('Truncated PGS segment');
  });
});

describe('PgsCanvasCache', () => {
  const originalLimit = PgsCanvasCache.Limit;
  afterEach(() => {
    PgsCanvasCache.Limit = originalLimit;
  });

  it('probes each file and track once', async () => {
    const cache = new PgsCanvasCache();
    const probe = vi.fn().mockResolvedValue(FrameSize.FHD);
    await cache.get('/movie.mkv', 3, probe);
    expect(await cache.get('/movie.mkv', 3, probe)).toBe(FrameSize.FHD);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('retries a miss only after an hour', async () => {
    const cache = new PgsCanvasCache();
    const probe = vi.fn().mockResolvedValue(undefined);
    await cache.get('/movie.mkv', 3, probe, 0);
    await cache.get('/movie.mkv', 3, probe, PgsCanvasCache.MissRetryMs - 1);
    expect(probe).toHaveBeenCalledOnce();
    await cache.get('/movie.mkv', 3, probe, PgsCanvasCache.MissRetryMs);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('drops the least recently used entry past the limit', async () => {
    PgsCanvasCache.Limit = 2;
    const cache = new PgsCanvasCache();
    const probe = vi.fn().mockResolvedValue(FrameSize.FHD);
    await cache.get('/a.mkv', 1, probe);
    await cache.get('/b.mkv', 1, probe);
    await cache.get('/a.mkv', 1, probe);
    await cache.get('/c.mkv', 1, probe);
    expect(probe).toHaveBeenCalledTimes(3);
    await cache.get('/a.mkv', 1, probe);
    expect(probe).toHaveBeenCalledTimes(3);
    await cache.get('/b.mkv', 1, probe);
    expect(probe).toHaveBeenCalledTimes(4);
  });
});

describe('SourceProbes', () => {
  it('shares one canvas cache across stream factories', () => {
    const cacheOf = (probes: SourceProbes) =>
      (probes as unknown as { canvasCache: PgsCanvasCache }).canvasCache;
    expect(cacheOf(SourceProbes.forFfprobe('/usr/bin/ffprobe'))).toBe(
      cacheOf(SourceProbes.forFfprobe('/usr/bin/ffprobe')),
    );
  });

  it('probes the PGS track from the start of the file', async () => {
    const run = vi
      .fn()
      .mockResolvedValue(
        JSON.stringify({ packets: [{ data: hexDump(pcs(1920, 1080)) }] }),
      );
    const probes = new SourceProbes(run, new PgsCanvasCache());

    expect(await probes.pgsCanvas('/movie.mkv', 5)).toEqual(
      FrameSize.create({ width: 1920, height: 1080 }),
    );
    const [args] = run.mock.calls[0]!;
    expect(args.slice(args.indexOf('-select_streams'), -1)).toEqual(
      expect.arrayContaining([
        '-select_streams',
        '5',
        '-read_intervals',
        '0%+#1',
      ]),
    );
    expect(args.at(-1)).toBe('/movie.mkv');
  });

  it('fails open when a probe fails', async () => {
    const run = vi.fn().mockRejectedValue(new Error('timed out'));
    const probes = new SourceProbes(run, new PgsCanvasCache());

    expect(await probes.pgsCanvas('/movie.mkv', 5)).toBeUndefined();
    expect(await probes.hlsCopyBandwidth('/movie.mkv')).toBeUndefined();
  });

  it('labels bandwidth from the probed container', async () => {
    const run = vi.fn().mockResolvedValue(
      JSON.stringify({
        streams: [{ codec_type: 'video' }],
        format: { bit_rate: '26261316' },
      }),
    );
    const probes = new SourceProbes(run, new PgsCanvasCache());

    expect(await probes.hlsCopyBandwidth('/movie.mkv')).toBe(26_261_316);
  });
});

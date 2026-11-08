import { expect, test } from 'vitest';
import { SeedWatchTimeline } from './SeedWatchTimeline.ts';

test('Next read-ahead and repeated requests do not credit the following program', () => {
  const start = Date.now();
  const timeline = new SeedWatchTimeline();
  const program = {
    programUuid: 'first',
    airingStartMs: start,
    airingDurationMs: 8_000,
    sourceOffsetMs: 0,
    contentEndMs: 6_000,
  };
  timeline.replaceFrom(start, [
    { startMs: start, finishMs: start + 8_000, program },
    {
      startMs: start + 8_000,
      finishMs: start + 16_000,
      program: {
        ...program,
        programUuid: 'second',
        airingStartMs: start + 8_000,
      },
    },
  ]);
  const files = [
    'live000000.ts',
    'live000001.ts',
    'live000002.ts',
    'live000003.ts',
  ];
  timeline.readPlaylist(
    files
      .map((file, i) =>
        [
          '#EXTINF:4.000,',
          '#EXT-X-PROGRAM-DATE-TIME:' +
            new Date(start + i * 4000).toISOString(),
          file,
        ].join('\n'),
      )
      .join('\n'),
  );

  expect(timeline.delivered(files[0]!, 'TV', 0)).toEqual([]);
  expect(timeline.delivered(files[1]!, 'TV', 4_000)).toMatchObject([
    { programUuid: 'first', fromMs: 0, toMs: 4_000 },
  ]);
  expect(timeline.delivered(files[1]!, 'TV', 5_000)).toEqual([]);
  expect(timeline.delivered(files[2]!, 'TV', 8_000)).toMatchObject([
    { programUuid: 'first', fromMs: 4_000, toMs: 6_000 },
  ]);
  expect(timeline.delivered(files[3]!, 'TV', 12_000)).toMatchObject([
    { programUuid: 'second', fromMs: 0, toMs: 4_000 },
  ]);
});

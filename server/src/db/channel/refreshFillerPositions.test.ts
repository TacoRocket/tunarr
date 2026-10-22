import { describe, expect, test } from 'vitest';
import type { ContentItem } from '../derived_types/Lineup.ts';
import { refreshFillerPositions } from './refreshFillerPositions.ts';

const clip = (id: string, durationMs: number): ContentItem => ({
  type: 'content',
  id,
  durationMs,
});

describe('refresh saved filler positions', () => {
  test('protects the next ad when playback has entered the one-second tail slack', () => {
    const original = [
      clip('show', 10_000),
      clip('playing-ad', 30_000),
      clip('other-ad', 30_000),
    ];
    const result = refreshFillerPositions(
      original,
      new Map([
        [1, clip('replacement1', 15_000)],
        [2, clip('replacement2', 20_000)],
      ]),
      1000,
      10_500,
    );
    expect(result.items[1]).toBe(original[1]);
    expect(result.preservedCurrentIndex).toBe(1);
    expect(result.refreshedPositions).toBe(1);
    expect(result.startTime).toBe(1000);
  });
  // Pool growth previously left old selections in place; the external refresh
  // had to replace them and compensate for different ad durations.
  test('changes only named positions and preserves the current program across loop cycles', () => {
    const original = [
      clip('show1', 1000),
      clip('old-ad', 100),
      clip('show2', 1000),
      clip('closer', 50),
    ];
    const now = 10_000 + 2 * 2150 + 1300;
    const result = refreshFillerPositions(
      original,
      new Map([[1, clip('new-ad', 250)]]),
      10_000,
      now,
    );
    expect(result.items).toEqual([
      original[0],
      clip('new-ad', 250),
      original[2],
      original[3],
    ]);
    expect(result.durationMs).toBe(2300);
    expect(now - result.startTime - 1250).toBe(200);
    expect(result.preservedCurrentIndex).toBe(2);
  });

  test('keeps an ad already playing while replacing the other selected positions', () => {
    const original = [
      clip('show', 1000),
      clip('playing-ad', 100),
      clip('other-ad', 50),
    ];
    const result = refreshFillerPositions(
      original,
      new Map([
        [1, clip('replacement1', 200)],
        [2, clip('replacement2', 300)],
      ]),
      1000,
      2050,
    );
    expect(result.items).toEqual([
      original[0],
      original[1],
      clip('replacement2', 300),
    ]);
    expect(result.refreshedPositions).toBe(1);
    expect(result.matchedPositions).toBe(2);
    expect(2050 - result.startTime - 1000).toBe(50);
  });
});

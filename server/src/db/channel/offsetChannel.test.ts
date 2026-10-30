import { describe, expect, test } from 'vitest';
import { offsetStartTime } from './offsetChannel.ts';

const Hour = 60 * 60 * 1000;
const Day = 24 * Hour;

describe('offsetStartTime', () => {
  test('adds the offset to a source start in the past', () => {
    const now = 100 * Day;
    expect(offsetStartTime(now - 2 * Day, 3, Day, now)).toBe(
      now - 2 * Day + 3 * Hour,
    );
  });

  test('moves a shifted start that lands in the future back by whole loops', () => {
    const now = 100 * Day;
    // Rebased an hour ago with a 3-hour offset: two hours ahead of now.
    const start = offsetStartTime(now - Hour, 3, 10 * Hour, now);
    expect(start).toBe(now + 2 * Hour - 10 * Hour);
    expect(start).toBeLessThanOrEqual(now);
    // Same place in the loop as the unshifted-by-loops start.
    expect((now - start) % (10 * Hour)).toBe(8 * Hour);
  });

  test('leaves an empty lineup’s start alone', () => {
    const now = 100 * Day;
    expect(offsetStartTime(now, 3, 0, now)).toBe(now + 3 * Hour);
  });
});

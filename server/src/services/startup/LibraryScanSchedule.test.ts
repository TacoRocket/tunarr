import { describe, expect, it } from 'vitest';
import { dailyLibraryScanRule } from './LibraryScanSchedule.ts';

describe('daily library scan schedule', () => {
  it('leaves the existing interval schedule in place when unset', () => {
    expect(dailyLibraryScanRule(null, null)).toBeUndefined();
  });

  it.each([
    ['2026-07-01T00:00:00Z', '2026-07-01T08:00:00.000Z'],
    ['2026-12-01T00:00:00Z', '2026-12-01T09:00:00.000Z'],
    ['2026-03-08T00:00:00Z', '2026-03-08T08:00:00.000Z'],
    ['2026-11-01T00:00:00Z', '2026-11-01T09:00:00.000Z'],
  ])(
    'runs at 03:00 Chicago from %s, independent of host timezone',
    (start, expected) => {
      const rule = dailyLibraryScanRule('03:00', 'America/Chicago');
      expect(rule?.nextInvocationDate(new Date(start))?.toISOString()).toBe(
        expected,
      );
    },
  );
});

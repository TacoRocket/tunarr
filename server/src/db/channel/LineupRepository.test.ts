import { describe, expect, test } from 'vitest';
import type { Lineup } from '../derived_types/Lineup.ts';
import { LineupRepository } from './LineupRepository.ts';

const lineup = (scheduleSeed?: number[]): Lineup => ({
  version: 6,
  lastUpdated: 0,
  items: [],
  startTimeOffsets: [0],
  scheduleSeed,
});

describe('LineupRepository.applyUpdateLineupRequest scheduleSeed', () => {
  test('stores a new seed', () => {
    const data = lineup();
    LineupRepository.applyUpdateLineupRequest(
      { items: [], scheduleSeed: [4, 5] },
      data,
    );
    expect(data.scheduleSeed).toEqual([4, 5]);
  });

  test('clears the seed on null', () => {
    const data = lineup([1]);
    LineupRepository.applyUpdateLineupRequest(
      { items: [], scheduleSeed: null },
      data,
    );
    expect(data.scheduleSeed).toBeUndefined();
  });

  test('keeps the seed when the request omits it', () => {
    const data = lineup([1]);
    LineupRepository.applyUpdateLineupRequest({ items: [] }, data);
    expect(data.scheduleSeed).toEqual([1]);
  });
});

describe('LineupRepository.applyUpdateLineupRequest scheduleDetached', () => {
  test('marks a lineup detached', () => {
    const data = lineup();
    LineupRepository.applyUpdateLineupRequest(
      { items: [], scheduleDetached: true },
      data,
    );
    expect(data.scheduleDetached).toBe(true);
  });

  test('clears the mark on false', () => {
    const data = { ...lineup(), scheduleDetached: true };
    LineupRepository.applyUpdateLineupRequest(
      { items: [], scheduleDetached: false },
      data,
    );
    expect(data.scheduleDetached).toBeUndefined();
  });

  test('keeps the mark when the request omits it', () => {
    const data = { ...lineup(), scheduleDetached: true };
    LineupRepository.applyUpdateLineupRequest({ items: [] }, data);
    expect(data.scheduleDetached).toBe(true);
  });
});

describe('live relay programming conflict', () => {
  test.each([
    {
      items: [
        { type: 'content' as const, id: 'new-program', durationMs: 60000 },
      ],
    },
    {
      schedule: {
        type: 'time' as const,
        flexPreference: 'end' as const,
        latenessMs: 0,
        maxDays: 1,
        padMs: 1,
        period: 'day' as const,
        slots: [],
        timeZoneOffset: 0,
        overflow: { type: 'duration' as const, maxMs: 0 },
      },
    },
  ])('refuses programming before changing the saved relay lineup', (update) => {
    const data: Lineup = {
      ...lineup(),
      liveRelay: { source: 'toonami-aftermath' },
    };
    const before = structuredClone(data);
    expect(() =>
      LineupRepository.applyUpdateLineupRequest(update, data),
    ).toThrow('Disable the live relay before changing programming');
    expect(data).toEqual(before);
  });
});

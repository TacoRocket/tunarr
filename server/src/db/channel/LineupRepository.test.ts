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

describe('generated lineup playback', () => {
  test('refuses enrollment when the assigned profile cannot play on Next', () => {
    expect(() =>
      LineupRepository.generatedPlaybackSettings('hls_direct', [
        { field: 'audioFormat', value: 'eac3', reason: 'unsupported codec' },
      ]),
    ).toThrow(/transcode profile.*eac3/i);
  });

  test('preserves direct playback when switching to Next', () => {
    expect(
      LineupRepository.generatedPlaybackSettings('hls_direct', []),
    ).toEqual({
      useEtvNext: true,
      streamMode: 'hls_direct_v2',
    });
  });
});

describe('LineupRepository.applyOnDemandRequest', () => {
  test('keeps the existing config when on-demand stays enabled', () => {
    const existing = {
      state: 'playing' as const,
      cursor: 12_345,
      lastPaused: 1_700_000_000_000,
      lastResumed: 1_700_000_001_000,
    };
    const data: Pick<Lineup, 'onDemandConfig'> = {
      onDemandConfig: { ...existing },
    };

    LineupRepository.applyOnDemandRequest({ enabled: true }, data);

    expect(data.onDemandConfig).toEqual(existing);
  });

  test('initializes the config when on-demand is enabled for the first time', () => {
    const data: Pick<Lineup, 'onDemandConfig'> = {};

    LineupRepository.applyOnDemandRequest({ enabled: true }, data);

    expect(data.onDemandConfig).toEqual({ state: 'paused', cursor: 0 });
  });

  test('removes the config when on-demand is disabled', () => {
    const data: Pick<Lineup, 'onDemandConfig'> = {
      onDemandConfig: { state: 'paused', cursor: 500 },
    };

    LineupRepository.applyOnDemandRequest({ enabled: false }, data);

    expect(data.onDemandConfig).toBeUndefined();
  });

  test('leaves the config alone when the request omits on-demand', () => {
    const existing = { state: 'playing' as const, cursor: 500 };
    const data: Pick<Lineup, 'onDemandConfig'> = {
      onDemandConfig: { ...existing },
    };

    LineupRepository.applyOnDemandRequest(undefined, data);

    expect(data.onDemandConfig).toEqual(existing);
  });
});

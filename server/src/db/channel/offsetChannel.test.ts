import { describe, expect, test } from 'vitest';
import {
  offsetStartTime,
  offsetChannelCrt,
  mirrorCrtUpdateError,
} from './offsetChannel.ts';

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

// Source refresh used to overwrite every mirror's CRT settings.
describe('mirror picture selection', () => {
  const source = {
    enabled: true,
    look: 'dvd-broadcast',
    processing: 'quality',
  } as const;
  const custom = {
    enabled: true,
    look: 'tv-broadcast',
    processing: 'quality',
  } as const;

  test('follows source changes unless an independent picture is selected', () => {
    expect(offsetChannelCrt(source, null)).toEqual(source);
    expect(offsetChannelCrt(custom, { mode: 'source' })).toEqual(custom);
    expect(offsetChannelCrt(source, { mode: 'custom', crt: custom })).toEqual(
      custom,
    );
    expect(offsetChannelCrt(null, { mode: 'custom', crt: custom })).toEqual(
      custom,
    );
    expect(offsetChannelCrt(source, { mode: 'off' })).toBeNull();
  });
});

describe('ordinary mirror CRT updates', () => {
  const channel = {
    uuid: 'mirror',
    offsetSourceChannelId: 'source',
    crt: {
      enabled: true,
      look: 'tv-broadcast',
      processing: 'quality',
    } as const,
  };

  test('rejects the changed picture that sync would otherwise silently discard', () => {
    expect(
      mirrorCrtUpdateError(channel, { ...channel.crt, look: 'dvd-broadcast' }),
    ).toBe(
      'This channel mirrors source; change its picture with PUT /api/channels/mirror/offset.',
    );
    expect(mirrorCrtUpdateError(channel, null)).toBeDefined();
  });

  test('accepts omitted CRT and an unchanged GET response, including defaults on older rows', () => {
    expect(mirrorCrtUpdateError(channel, undefined)).toBeUndefined();
    expect(mirrorCrtUpdateError(channel, { ...channel.crt })).toBeUndefined();
    const stored = JSON.parse('{"enabled":true,"look":"tv-broadcast"}');
    expect(
      mirrorCrtUpdateError({ ...channel, crt: stored }, channel.crt),
    ).toBeUndefined();
    expect(
      mirrorCrtUpdateError({ ...channel, crt: null }, null),
    ).toBeUndefined();
  });

  test('leaves ordinary channels free to change their CRT settings', () => {
    expect(
      mirrorCrtUpdateError({ ...channel, offsetSourceChannelId: null }, null),
    ).toBeUndefined();
  });
});

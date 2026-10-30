import { describe, expect, it } from 'vitest';
import {
  continueDegradations,
  StreamDegradations,
} from './StreamDegradations.ts';

describe('StreamDegradations', () => {
  it('keeps the first report for each code', () => {
    const degradations = new StreamDegradations();
    degradations.add('crt_hdr_bypassed', 'first', 1);
    degradations.add('crt_hdr_bypassed', 'second', 2);
    degradations.add('vaapi_low_power_unavailable', 'low power', 3);

    expect(degradations.list()).toEqual([
      { code: 'crt_hdr_bypassed', message: 'first', firstSeen: 1 },
      {
        code: 'vaapi_low_power_unavailable',
        message: 'low power',
        firstSeen: 3,
      },
    ]);
  });
});

describe('continueDegradations', () => {
  it('keeps firstSeen for a degradation that continues into the next item', () => {
    const previous = [
      { code: 'vaapi_low_power_unavailable', message: 'old', firstSeen: 10 },
    ] as const;
    const next = [
      { code: 'vaapi_low_power_unavailable', message: 'new', firstSeen: 99 },
      { code: 'crt_hdr_bypassed', message: 'hdr', firstSeen: 99 },
    ] as const;

    expect(continueDegradations(previous, next)).toEqual([
      { code: 'vaapi_low_power_unavailable', message: 'new', firstSeen: 10 },
      { code: 'crt_hdr_bypassed', message: 'hdr', firstSeen: 99 },
    ]);
  });

  it('drops degradations the new item no longer has', () => {
    const previous = [
      { code: 'crt_hdr_bypassed', message: 'hdr', firstSeen: 10 },
    ] as const;

    expect(continueDegradations(previous, [])).toEqual([]);
  });
});

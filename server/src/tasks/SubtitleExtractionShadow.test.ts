import { describe, expect, it } from 'vitest';
import { evaluateSubtitleExtractionShadow } from './SubtitleExtractionShadow.ts';

function sample(seconds: number, gb = 1) {
  return {
    elapsedSeconds: seconds,
    bytesRead: gb * 1e9,
    secondsPerGB: seconds / gb,
    longestProgressPauseSeconds: 1,
  };
}

describe('adaptive subtitle shadow comparison', () => {
  it('compares file-normalized rates so a large healthy read is not a wall-clock timeout', () => {
    const history = Array.from({ length: 20 }, () => sample(10));
    expect(
      evaluateSubtitleExtractionShadow(history, sample(20, 2)).decision,
    ).toBe('within_budget');
    expect(
      evaluateSubtitleExtractionShadow(history, sample(600, 60)).decision,
    ).toBe('within_budget');
    expect(
      evaluateSubtitleExtractionShadow(history, sample(1801, 60)).decision,
    ).toBe('would_have_stopped');
  });

  it('uses the p95 rather than the single slowest read and does not mutate history', () => {
    const history = [
      sample(1000),
      ...Array.from({ length: 19 }, () => sample(10)),
    ];
    expect(
      evaluateSubtitleExtractionShadow(history, sample(100, 3)),
    ).toMatchObject({ decision: 'would_have_stopped', budgetSeconds: 90 });
    expect(history[0]?.elapsedSeconds).toBe(1000);
  });

  it('refuses a decision when input byte measurements are unavailable', () => {
    const history = Array.from({ length: 19 }, () => sample(10));
    const unavailable = { ...sample(10), bytesRead: 0, secondsPerGB: null };
    expect(
      evaluateSubtitleExtractionShadow([...history, unavailable], sample(100))
        .decision,
    ).toBe('insufficient_history');
    expect(
      evaluateSubtitleExtractionShadow(history, unavailable).decision,
    ).toBe('invalid_measurement');
  });
});

import { describe, expect, it } from 'vitest';
import { subtitleExtractionPolicy } from './SubtitleExtractionPolicy.ts';
const history = Array.from({ length: 20 }, () => ({
  elapsedSeconds: 10,
  fileSizeBytes: 1e9,
}));
describe('adaptive subtitle deadline', () => {
  it('scales the deadline by the catalog file size, not a fixed total duration', () => {
    expect(subtitleExtractionPolicy(history, 2e9)).toMatchObject({
      mode: 'adaptive',
      budgetSeconds: 60,
    });
    expect(subtitleExtractionPolicy(history, 60e9)).toMatchObject({
      mode: 'adaptive',
      budgetSeconds: 1800,
    });
  });
  it('uses prior p95 without letting one slowest read set the budget', () => {
    const samples = [
      { elapsedSeconds: 1000, fileSizeBytes: 1e9 },
      ...history.slice(1),
    ];
    expect(subtitleExtractionPolicy(samples, 3e9)).toMatchObject({
      budgetSeconds: 90,
    });
    expect(samples[0]?.elapsedSeconds).toBe(1000);
  });
  it('falls back for unavailable size, insufficient history, or a recovery attempt', () => {
    expect(subtitleExtractionPolicy(history)).toMatchObject({
      mode: 'fixed',
      reason: 'missing_file_size',
    });
    expect(subtitleExtractionPolicy(history.slice(1), 1e9)).toMatchObject({
      mode: 'fixed',
      reason: 'insufficient_history',
    });
    expect(subtitleExtractionPolicy(history, 1e9, true)).toMatchObject({
      mode: 'fixed',
      reason: 'recovery_retry',
    });
  });
});

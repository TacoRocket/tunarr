import type { SubtitleExtractionSample } from './SubtitleExtractionProcess.ts';

export function isUsableExtractionSample(sample: SubtitleExtractionSample) {
  return (
    Number.isFinite(sample.elapsedSeconds) &&
    sample.elapsedSeconds > 0 &&
    Number.isFinite(sample.bytesRead) &&
    sample.bytesRead > 0 &&
    sample.secondsPerGB !== null &&
    Number.isFinite(sample.secondsPerGB) &&
    sample.secondsPerGB > 0
  );
}

// Retrospective nearest-rank p95 over prior successful reads. AVIO input bytes
// are only known at exit; the live progress counter measures a different thing
// (one copied stream), so using it here would bias the rate by the file's tracks.
export function evaluateSubtitleExtractionShadow(
  history: readonly SubtitleExtractionSample[],
  sample?: SubtitleExtractionSample,
) {
  const rates = history
    .filter(isUsableExtractionSample)
    .map((entry) => entry.secondsPerGB as number)
    .slice(-20)
    .sort((a, b) => a - b);
  const sampleCount = rates.length;
  if (!sample)
    return { decision: 'incomplete_extraction' as const, sampleCount };
  if (!isUsableExtractionSample(sample)) {
    return { decision: 'invalid_measurement' as const, sampleCount };
  }
  if (sampleCount < 20)
    return { decision: 'insufficient_history' as const, sampleCount };
  const p95SecondsPerGB = rates[Math.ceil(sampleCount * 0.95) - 1];
  if (p95SecondsPerGB === undefined)
    throw new Error('Missing subtitle extraction percentile');
  const budgetSeconds = Math.max(
    60,
    (3 * p95SecondsPerGB * sample.bytesRead) / 1e9,
  );
  return {
    decision:
      sample.elapsedSeconds > budgetSeconds
        ? ('would_have_stopped' as const)
        : ('within_budget' as const),
    sampleCount,
    p95SecondsPerGB,
    budgetSeconds,
  };
}

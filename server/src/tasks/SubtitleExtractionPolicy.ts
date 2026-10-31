export type SubtitleExtractionHistorySample = {
  elapsedSeconds: number;
  fileSizeBytes: number;
};

export function isValidFileSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

// Nearest-rank p95 of prior completed reads, normalized by the same catalog
// file size available before launch. FFmpeg's AVIO bytes include seeks/probing
// and must not be mixed with catalog sizes in this deadline calculation.
export function subtitleExtractionPolicy(
  history: readonly SubtitleExtractionHistorySample[],
  fileSizeBytes?: number,
  fixedOnlyRetry = false,
) {
  const rates = history
    .filter(
      (entry) =>
        isValidFileSize(entry.fileSizeBytes) &&
        Number.isFinite(entry.elapsedSeconds) &&
        entry.elapsedSeconds > 0,
    )
    .slice(-20)
    .map((entry) => entry.elapsedSeconds / (entry.fileSizeBytes / 1e9))
    .sort((a, b) => a - b);
  const sampleCount = rates.length;
  const fixed = (reason: string) => ({
    mode: 'fixed' as const,
    reason,
    sampleCount,
  });
  if (fixedOnlyRetry) return fixed('recovery_retry');
  if (!isValidFileSize(fileSizeBytes)) return fixed('missing_file_size');
  if (sampleCount < 20) return fixed('insufficient_history');
  const p95SecondsPerGB = rates[Math.ceil(sampleCount * 0.95) - 1];
  if (p95SecondsPerGB === undefined) return fixed('insufficient_history');
  const budgetSeconds = Math.max(
    60,
    3 * p95SecondsPerGB * (fileSizeBytes / 1e9),
  );
  // Node-compatible timers overflow above this delay; fallback must not become
  // an immediate timeout for an unusually large or slow input.
  if (!Number.isFinite(budgetSeconds) || budgetSeconds * 1000 > 2_147_483_647)
    return fixed('invalid_budget');
  return {
    mode: 'adaptive' as const,
    sampleCount,
    p95SecondsPerGB,
    budgetSeconds,
  };
}

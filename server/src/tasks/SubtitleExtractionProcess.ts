import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type SubtitleExtractionSample = {
  elapsedSeconds: number;
  bytesRead: number;
  secondsPerGB: number | null;
  longestProgressPauseSeconds: number;
};

export class SubtitleExtractionStallError extends Error {}
export class SubtitleExtractionDeadlineError extends Error {}

// One media stream is copied to the OS null device to observe input progress. Subtitle
// timestamps/output can stand still for minutes while a healthy read continues.
export class SubtitleExtractionProcess {
  async run(
    executable: string,
    args: string[],
    budgetSeconds?: number,
  ): Promise<SubtitleExtractionSample> {
    const started = performance.now();
    let lastProgress = started;
    let longestPause = 0;
    let lastBytes = 0;
    let bytesRead = 0;
    let stderr = '';
    let stopReason: 'stall' | 'deadline' | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(
      executable,
      [
        '-nostdin',
        '-y',
        '-hide_banner',
        '-loglevel',
        'verbose',
        '-nostats',
        '-stats_period',
        '1',
        '-progress',
        'pipe:1',
        ...args,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const stop = (reason: 'stall' | 'deadline') => {
      if (stopReason) return;
      stopReason = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    const watchdog = setTimeout(() => stop('stall'), 60_000);
    const deadline =
      budgetSeconds !== undefined &&
      Number.isFinite(budgetSeconds) &&
      budgetSeconds >= 60 &&
      budgetSeconds * 1000 <= 2_147_483_647
        ? setTimeout(() => stop('deadline'), budgetSeconds * 1000)
        : undefined;
    const progress = createInterface({ input: child.stdout });
    progress.on('line', (line) => {
      if (!line.startsWith('total_size=')) return;
      const bytes = Number(line.slice(11));
      if (!Number.isFinite(bytes) || bytes <= lastBytes || stopReason) return;
      const now = performance.now();
      longestPause = Math.max(longestPause, now - lastProgress);
      lastProgress = now;
      lastBytes = bytes;
      watchdog.refresh();
    });
    const diagnostics = createInterface({ input: child.stderr });
    diagnostics.on('line', (line) => {
      stderr = (stderr + line + '\n').slice(-16_384);
      // One input: AVIO reports actual bytes read, including probing/seeks,
      // independently of the tiny subtitle output size or HTTP Content-Length.
      const match = /Statistics: (\d+) bytes read/.exec(line);
      if (match) bytesRead = Math.max(bytesRead, Number(match[1]));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          if (stopReason === 'stall')
            reject(
              new SubtitleExtractionStallError(
                'Subtitle extraction made no media input progress for 60 seconds',
              ),
            );
          else if (stopReason === 'deadline')
            reject(
              new SubtitleExtractionDeadlineError(
                `Subtitle extraction exceeded adaptive deadline of ${budgetSeconds} seconds`,
              ),
            );
          else if (code !== 0)
            reject(
              new Error(
                `Subtitle extraction exited ${code ?? signal}: ${stderr}`,
              ),
            );
          else resolve();
        });
      });
      const ended = performance.now();
      const elapsedSeconds = (ended - started) / 1000;
      return {
        elapsedSeconds,
        bytesRead,
        secondsPerGB: bytesRead > 0 ? elapsedSeconds / (bytesRead / 1e9) : null,
        longestProgressPauseSeconds:
          Math.max(longestPause, ended - lastProgress) / 1000,
      };
    } finally {
      clearTimeout(watchdog);
      clearTimeout(deadline);
      clearTimeout(killTimer);
      progress.close();
      diagnostics.close();
    }
  }
}

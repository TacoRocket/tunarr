import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from 'zod';
import { isDev } from '../../util/index.ts';

const OcrResult = z.object({
  imageCues: z.number().int().positive(),
  srtCues: z.number().int().positive(),
  blankCues: z.number().int().nonnegative(),
  bytesRead: z.number().nonnegative(),
  payloadBytes: z.number().nonnegative(),
  sourceBytes: z.number().positive(),
  sourceOriginMs: z.number(),
});

export async function runPgsOcrProcess(options: {
  inputPath: string;
  outputPath: string;
  streamIndex: number;
  cacheFolder: string;
  signal: AbortSignal;
}) {
  if (process.platform !== 'linux')
    throw new Error(
      'OCR cache preparation currently requires the Linux container',
    );
  options.signal.throwIfAborted();
  const entry = process.argv[1];
  if (!entry) throw new Error('Missing Tunarr entry point');
  const workerArgs = isDev
    ? [
        ...process.execArgv,
        fileURLToPath(new URL('../../cli/PgsOcrWorker.ts', import.meta.url)),
      ]
    : [path.join(path.dirname(entry), 'pgs-ocr-worker.cjs')];
  const child = spawn(
    'flock',
    [
      '--nonblock',
      '--no-fork',
      '--conflict-exit-code',
      '75',
      path.join(options.cacheFolder, '.pgs-ocr.lock'),
      process.execPath,
      ...workerArgs,
      '--input',
      options.inputPath,
      '--output',
      options.outputPath,
      '--stream',
      String(options.streamIndex),
    ],
    { detached: true, stdio: ['pipe', 'pipe', 'inherit'] },
  );
  let output = '';
  let failure: Error | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
      )
        throw error;
    }
  };
  const stop = () => {
    killGroup('SIGTERM');
    killTimer ??= setTimeout(() => killGroup('SIGKILL'), 5_000);
  };
  const abort = () => {
    failure = new Error('PGS OCR canceled or its 30-minute deadline expired', {
      cause: options.signal.reason,
    });
    stop();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString('utf8');
        if (output.length > 16_384) {
          failure = new Error('OCR worker returned too much output');
          stop();
        }
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (failure) {
          killGroup('SIGKILL');
          reject(failure);
        } else if (code === 75)
          reject(
            new Error(
              'Another PGS OCR job is running for this Tunarr cache; retry after it finishes',
            ),
          );
        else if (code !== 0)
          reject(
            new Error(
              `PGS OCR worker failed (${signal ?? code}); see its error above`,
            ),
          );
        else resolve();
      });
    });
    return OcrResult.parse(JSON.parse(output));
  } finally {
    options.signal.removeEventListener('abort', abort);
    clearTimeout(killTimer);
    child.stdin.destroy();
  }
}

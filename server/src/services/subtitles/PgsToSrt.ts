import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { decodePgs, preparePgsForOcr } from './PgsDecoder.ts';
import { readPgsBlocks } from './PgsMatroskaReader.ts';
import { fixPgsOcrText } from './PgsOcrText.ts';

import { spawnPgsChild } from './PgsOcrProcess.ts';

function timestamp(milliseconds: number) {
  const value = Math.round(milliseconds);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid SRT timestamp');
  const pad = (n: number, width = 2) => n.toString().padStart(width, '0');
  return `${pad(Math.floor(value / 3_600_000))}:${pad(Math.floor(value / 60_000) % 60)}:${pad(Math.floor(value / 1000) % 60)},${pad(value % 1000, 3)}`;
}

/** Local preparation only: does not modify media, scan libraries, or register a subtitle. */
export async function pgsToSrt(options: {
  inputPath: string;
  outputPath: string;
  streamIndex: number;
  language: string;
  signal?: AbortSignal;
  bindToWorker?: boolean;
  onReadProgress?: (
    position: number,
    bytesRead: number,
    sourceSize: number,
  ) => void;
  onProgress?: (completed: number, total: number) => void;
}) {
  if (!/^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$/.test(options.language))
    throw new Error('Expected an explicit Tesseract language, for example eng');
  await runTesseract(
    ['--version'],
    undefined,
    options.signal,
    options.bindToWorker,
    30_000,
  );
  const source = await readPgsBlocks(
    options.inputPath,
    options.streamIndex,
    options.signal,
    options.onReadProgress,
  );
  const cues = decodePgs(source.blocks);
  if (cues.length === 0) throw new Error('No PGS pictures found');
  for (const cue of cues) {
    if (
      cue.endMs === null ||
      cue.startMs < 0 ||
      Math.round(cue.endMs) <= Math.round(cue.startMs)
    )
      throw new Error(`PGS cue at ${cue.startMs} ms has no valid end time`);
  }
  const paragraphs: string[] = [];
  let blankCues = 0;
  for (const [index, cue] of cues.entries()) {
    options.signal?.throwIfAborted();
    const rawText = await runTesseract(
      ['stdin', 'stdout', '-l', options.language, '--psm', '6'],
      preparePgsForOcr(cue),
      options.signal,
      options.bindToWorker,
    );
    const text = fixPgsOcrText(rawText, options.language);
    if (text.length > 0) {
      if (cue.endMs === null) throw new Error('Missing cue end time');
      paragraphs.push(
        `${paragraphs.length + 1}\n${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n${text}`,
      );
    } else blankCues++;
    options.onProgress?.(index + 1, cues.length);
  }
  if (paragraphs.length === 0) throw new Error('OCR returned no text');
  options.signal?.throwIfAborted();
  // Exclusive creation protects existing sidecars and the source, including symlinks.
  await writeFile(
    options.outputPath,
    '\uFEFF' + paragraphs.join('\n\n') + '\n',
    { flag: 'wx' },
  );
  return {
    imageCues: cues.length,
    srtCues: paragraphs.length,
    blankCues,
    bytesRead: source.bytesRead,
    payloadBytes: source.payloadBytes,
    sourceBytes: source.sourceBytes,
    sourceOriginMs: Number(source.sourceOriginNs) / 1_000_000,
  };
}

function runTesseract(
  args: string[],
  image?: Buffer,
  signal?: AbortSignal,
  bindToWorker = false,
  timeout = 60_000,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = bindToWorker
      ? spawnPgsChild('tesseract', args)
      : spawn('tesseract', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    const abort = () =>
      stop(new Error('PGS OCR canceled', { cause: signal?.reason }));
    const timer = setTimeout(
      () => stop(new Error(`Tesseract timeout after ${timeout}ms`)),
      timeout,
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', (error) => {
      failure ??= error;
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      stdout += data;
      if (Buffer.byteLength(stdout, 'utf8') > 1024 * 1024)
        stop(new Error('Tesseract output exceeded 1 MiB'));
    });
    child.stderr.on('data', (data: string) => {
      stderr += data;
      if (Buffer.byteLength(stderr, 'utf8') > 1024 * 1024)
        stop(new Error('Tesseract error output exceeded 1 MiB'));
    });
    // AbortSignal's execFile callback can reject before the native child exits.
    // Settle only on close so cache cleanup and the next job cannot race it.
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(`Tesseract failed (${exitSignal ?? code}): ${stderr}`),
        );
      else resolve(stdout.trim());
    });
    child.stdin.on('error', stop);
    child.stdin.end(image);
  });
}

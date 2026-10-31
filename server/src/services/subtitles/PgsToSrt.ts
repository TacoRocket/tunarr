import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { decodePgs, preparePgsForOcr } from './PgsDecoder.ts';
import { readPgsBlocks } from './PgsMatroskaReader.ts';
import { fixPgsOcrText } from './PgsOcrText.ts';

const execute = promisify(execFile);

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
  onReadProgress?: (
    position: number,
    bytesRead: number,
    sourceSize: number,
  ) => void;
  onProgress?: (completed: number, total: number) => void;
}) {
  if (!/^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$/.test(options.language))
    throw new Error('Expected an explicit Tesseract language, for example eng');
  await execute('tesseract', ['--version'], {
    signal: options.signal,
    timeout: 30_000,
  });
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
    const rawText = await recognize(
      preparePgsForOcr(cue),
      options.language,
      options.signal,
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

function recognize(
  image: Buffer,
  language: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'tesseract',
      ['stdin', 'stdout', '-l', language, '--psm', '6'],
      { signal, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error !== null)
          reject(
            new Error(`Tesseract OCR failed: ${error.message}`, {
              cause: error,
            }),
          );
        else resolve(stdout.trim());
      },
    );
    if (child.stdin === null) {
      child.kill();
      reject(new Error('Tesseract stdin is unavailable'));
      return;
    }
    child.stdin.on('error', (error) => {
      child.kill();
      reject(error);
    });
    child.stdin.end(image);
  });
}

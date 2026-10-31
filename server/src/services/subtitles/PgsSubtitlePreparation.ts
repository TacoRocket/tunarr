import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquiredSubtitleDirectory } from '../../util/subtitles.ts';
import {
  removePgsTemporaryDirectories,
  withPgsOcrLock,
  sweepPgsTemporaryDirectories,
} from './PgsOcrProcess.ts';
import { pgsToSrt } from './PgsToSrt.ts';
import type { WorkerPgsOcrRequest } from '../../types/worker_schemas.ts';
import {
  acquiredSubtitles,
  admitAcquiredSubtitleCache,
  retireReplacedSubtitleCache,
  subtitleSourceIdentity,
} from './SubtitleCache.ts';

export async function prepareCachedPgsSubtitle(
  options: WorkerPgsOcrRequest['request'] & {
    signal: AbortSignal;
    onProgress?: (message: string) => void;
  },
) {
  if (process.platform !== 'linux')
    throw new Error(
      'OCR cache preparation currently requires the Linux container',
    );
  options.signal.throwIfAborted();
  await fs.mkdir(options.cacheFolder, { recursive: true });
  const cached = await lookupCache(options);
  if (cached.existing) {
    await sweepPgsTemporaryDirectories(options.cacheFolder);
    return { status: 'cached' as const, path: cached.existing.path };
  }
  const result = await withPgsOcrLock(options.cacheFolder, async () => {
    options.signal.throwIfAborted();
    await removePgsTemporaryDirectories(options.cacheFolder);
    return prepare(options);
  });
  if (result === undefined)
    throw new Error(
      'Another PGS OCR job is running for this Tunarr cache; retry after it finishes',
    );
  return result;
}

async function prepare(
  options: WorkerPgsOcrRequest['request'] & {
    signal: AbortSignal;
    onProgress?: (message: string) => void;
  },
) {
  const { source, identity, acquisition, existing } =
    await lookupCache(options);
  if (existing) return { status: 'cached' as const, path: existing.path };

  await fs.mkdir(options.cacheFolder, { recursive: true });
  const working = await fs.mkdtemp(path.join(options.cacheFolder, '.pgs-ocr-'));
  try {
    const temporary = path.join(working, 'subtitle.srt');
    let lastPercent = -5;
    const result = await pgsToSrt({
      inputPath: options.inputPath,
      outputPath: temporary,
      streamIndex: options.streamIndex,
      language: 'eng',
      bindToWorker: true,
      signal: options.signal,
      onReadProgress: (position, _bytes, size) => {
        const percent = Math.floor((position * 100) / size);
        if (percent >= lastPercent + 5) {
          lastPercent = percent;
          options.onProgress?.(`Reading PGS: ${percent}%`);
        }
      },
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total)
          options.onProgress?.(`OCR: ${done}/${total}`);
      },
    });
    options.signal.throwIfAborted();
    const key = crypto
      .createHash('sha256')
      .update(JSON.stringify([identity, acquisition]))
      .digest('hex');
    const output = path.join(
      options.cacheFolder,
      acquiredSubtitleDirectory(options.programId),
      `${key}.srt`,
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.rename(temporary, output);
    await admitAcquiredSubtitleCache(
      output,
      options.programId,
      identity,
      acquisition,
      source,
      options.revision,
    );
    await retireReplacedSubtitleCache(
      options.cacheFolder,
      options.programId,
      identity,
    );
    return { status: 'prepared' as const, path: output, ...result };
  } finally {
    await fs.rm(working, { recursive: true, force: true });
  }
}

async function lookupCache(options: WorkerPgsOcrRequest['request']) {
  const source = { type: 'file', path: options.inputPath };
  const identity = await subtitleSourceIdentity(source, options.revision);
  const acquisition = {
    provider: 'pgs-ocr' as const,
    language: 'eng',
    forced: options.forced,
    sdh: options.sdh,
    streamIndex: options.streamIndex,
    recipeVersion: 1 as const,
  };
  const existing = (
    await acquiredSubtitles(options.cacheFolder, options.programId, identity)
  ).find(
    (entry) =>
      entry.provider === 'pgs-ocr' &&
      entry.streamIndex === acquisition.streamIndex &&
      entry.recipeVersion === acquisition.recipeVersion &&
      entry.language === acquisition.language &&
      entry.forced === acquisition.forced &&
      entry.sdh === acquisition.sdh,
  );
  return { source, identity, acquisition, existing };
}

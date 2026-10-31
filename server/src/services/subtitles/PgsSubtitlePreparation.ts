import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquiredSubtitleDirectory } from '../../util/subtitles.ts';
import { runPgsOcrProcess } from './PgsOcrProcess.ts';
import {
  acquiredSubtitles,
  admitAcquiredSubtitleCache,
  retireReplacedSubtitleCache,
  subtitleSourceIdentity,
} from './SubtitleCache.ts';

export async function prepareCachedPgsSubtitle(options: {
  programId: string;
  inputPath: string;
  revision: string | null;
  streamIndex: number;
  forced: boolean;
  sdh: boolean;
  cacheFolder: string;
  signal: AbortSignal;
}) {
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
  if (existing) return { status: 'cached' as const, path: existing.path };

  await fs.mkdir(options.cacheFolder, { recursive: true });
  const working = await fs.mkdtemp(path.join(options.cacheFolder, '.pgs-ocr-'));
  try {
    const temporary = path.join(working, 'subtitle.srt');
    const result = await runPgsOcrProcess({
      inputPath: options.inputPath,
      outputPath: temporary,
      streamIndex: options.streamIndex,
      cacheFolder: options.cacheFolder,
      signal: options.signal,
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

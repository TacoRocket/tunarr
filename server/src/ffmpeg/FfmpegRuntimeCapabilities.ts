import { readFile } from 'node:fs/promises';

export type FfmpegRuntimeCapabilities = {
  source: 'bundled' | 'custom' | 'unknown';
  preservesConcatTimestamps?: boolean;
  nativeNv12Output?: boolean;
};

export function parseRuntimeCapabilities(
  help: string,
  source: 'bundled' | 'custom',
): FfmpegRuntimeCapabilities {
  if (!/^AVCodecContext AVOptions:/m.test(help)) {
    throw new Error('FFmpeg full help did not contain codec options');
  }
  const filterOptions = (name: string) =>
    help.match(
      new RegExp(
        `^${name} AVOptions:\\r?\\n((?:[ \\t].*\\r?\\n|\\r?\\n)*)`,
        'm',
      ),
    )?.[1] ?? '';
  const nativeOption = filterOptions('libplacebo').match(
    /^\s+nv12_output\s+<int>[^\n]*\n((?:(?!\s+\S+\s+<)[ \t].*\n)*)/m,
  );
  return {
    source,
    preservesConcatTimestamps: /^\s+preserve_ts\s+<boolean>/m.test(
      filterOptions('concat'),
    ),
    nativeNv12Output: /^\s+native\s+\d+\s/m.test(nativeOption?.[1] ?? ''),
  };
}

// This is a fast-path record, not an executable allowlist. A different build
// is inspected normally and keeps every capability it advertises.
export async function bundledFfmpegHelp(
  version: string,
): Promise<string | undefined> {
  try {
    const bundledVersion = await readFile(
      '/opt/tunarr/ffmpeg-version.txt',
      'utf8',
    );
    if (version.trim() !== bundledVersion.trim()) return;
    return await readFile('/opt/tunarr/ffmpeg-help.txt', 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
}

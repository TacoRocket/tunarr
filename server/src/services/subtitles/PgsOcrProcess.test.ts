import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { removePgsTemporaryDirectories } from './PgsOcrProcess.ts';

test('reclaims the temporary folder a hard-killed OCR job leaves behind, preserving admitted subtitles', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pgs-cleanup-'));
  try {
    const abandoned = path.join(folder, '.pgs-ocr-abandoned');
    const acquired = path.join(folder, 'acquired');
    await fs.mkdir(abandoned);
    await fs.mkdir(acquired);
    await fs.writeFile(path.join(abandoned, 'subtitle.srt'), 'incomplete');
    await fs.writeFile(path.join(acquired, 'subtitle.srt'), 'completed');
    expect(await removePgsTemporaryDirectories(folder)).toBe(1);
    expect(await fs.readdir(folder)).toEqual(['acquired']);
    expect(await fs.readFile(path.join(acquired, 'subtitle.srt'), 'utf8')).toBe(
      'completed',
    );
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

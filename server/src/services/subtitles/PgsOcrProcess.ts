import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Linux binds native child lifetime to its creating thread, including hard exits. */
export function spawnPgsChild(command: string, args: string[]) {
  return spawn(
    'setpriv',
    [
      '--pdeathsig',
      'SIGKILL',
      'sh',
      '-c',
      // Close the race where the parent died before setpriv registered the signal.
      '[ "$PPID" = "$1" ] || exit 1; shift; exec "$@"',
      'pgs-child',
      String(process.pid),
      command,
      ...args,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

export async function withPgsOcrLock<T>(
  folder: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  const child = spawnPgsChild('flock', [
    '--nonblock',
    '--no-fork',
    '--conflict-exit-code',
    '75',
    path.join(folder, '.pgs-ocr.lock'),
    'sh',
    '-c',
    'printf ready; exec cat >/dev/null',
  ]);
  let ready = false;
  let stderr = '';
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  const acquired = new Promise<boolean>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => {
      ready = true;
      resolve(true);
    });
    child.once('close', (code) => {
      if (ready) return;
      if (code === 75) resolve(false);
      else
        reject(new Error(`Could not acquire PGS OCR lock: ${stderr || code}`));
    });
  });
  try {
    if (!(await acquired)) return undefined;
    return await run();
  } finally {
    child.stdin.end();
    await closed;
  }
}

export async function removePgsTemporaryDirectories(folder: string) {
  let removed = 0;
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.pgs-ocr-')) continue;
    await fs.rm(path.join(folder, entry.name), { recursive: true });
    removed++;
  }
  return removed;
}

/** Called by recurring cache maintenance; a held lock means the folder is live. */
export async function sweepPgsTemporaryDirectories(folder: string) {
  if (process.platform !== 'linux') return 0;
  const entries = await fs.readdir(folder, { withFileTypes: true });
  if (!entries.some((e) => e.isDirectory() && e.name.startsWith('.pgs-ocr-')))
    return 0;
  return (
    (await withPgsOcrLock(folder, () =>
      removePgsTemporaryDirectories(folder),
    )) ?? 0
  );
}

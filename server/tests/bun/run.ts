// Runs the test files listed in green-files.txt under Bun, the runtime the
// fork's containers use. Every listed file must pass; a file is added once it
// passes under Bun, so the list only grows.
//
//   bun tests/bun/run.ts               run the listed files
//   bun tests/bun/run.ts --candidates  run each unlisted file on its own and
//                                      report which now pass
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const serverDir = path.resolve(import.meta.dir, '../..');
const listPath = path.join(import.meta.dir, 'green-files.txt');
const listed = readFileSync(listPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

const allFiles = [
  ...new Glob('{src,tests}/**/*.test.ts').scanSync({ cwd: serverDir }),
]
  .filter((file) => !file.endsWith('.local.test.ts'))
  .sort();

const missing = listed.filter((file) => !allFiles.includes(file));
if (missing.length > 0) {
  console.error(
    `green-files.txt lists files that no longer exist; remove them:\n  ${missing.join('\n  ')}`,
  );
  process.exit(1);
}

const run = (args: string[], timeoutMs?: number) =>
  Bun.spawnSync(['bun', ...args], {
    cwd: serverDir,
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: timeoutMs,
  });

// vitest.config.ts `globalSetup`: build the template database once, before
// parallel workers would race to create it.
const setup = run(['tests/bun/globalSetup.ts']);
if (setup.exitCode !== 0) process.exit(setup.exitCode ?? 1);

if (process.argv.includes('--candidates')) {
  const passing: string[] = [];
  for (const file of allFiles.filter((f) => !listed.includes(f))) {
    const result = Bun.spawnSync(['bun', 'test', `./${file}`], {
      cwd: serverDir,
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 90_000,
    });
    if (result.exitCode === 0) passing.push(file);
  }
  console.log(
    passing.length > 0
      ? `Now passing under Bun; add to green-files.txt:\n  ${passing.join('\n  ')}`
      : 'No unlisted file passes under Bun yet.',
  );
  process.exit(0);
}

const tests = run(['test', '--parallel', ...listed.map((file) => `./${file}`)]);
process.exit(tests.exitCode ?? 1);

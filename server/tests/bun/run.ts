// Runs the test files listed in green-files.txt under Bun, the runtime the
// fork's containers use. Every listed file must pass; a file is added once it
// passes under Bun, so the list only grows.
//
//   bun tests/bun/run.ts               run the listed files
//   bun tests/bun/run.ts --node-fallback  also run unlisted files on Node
//   bun tests/bun/run.ts --candidates  run each unlisted file on its own and
//                                      report which now pass
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'node-fallback': { type: 'boolean' },
    candidates: { type: 'boolean' },
  },
  allowPositionals: true,
});

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

const selected = allFiles.filter(
  (file) =>
    positionals.length === 0 ||
    positionals.some((filter) => file.includes(filter.replace(/^\.\//, ''))),
);
const bunFiles = selected.filter((file) => listed.includes(file));
const nodeFiles = selected.filter((file) => !listed.includes(file));
if (selected.length === 0) {
  throw new Error('No test files match the supplied paths');
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

if (values.candidates) {
  const passing: string[] = [];
  for (const file of nodeFiles) {
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

console.log(
  `Server tests: ${bunFiles.length} files on Bun; ${nodeFiles.length} ${values['node-fallback'] ? 'on Node' : 'require Node (not run in Bun-only mode)'}`,
);
let exitCode = 0;
if (bunFiles.length > 0) {
  const tests = run([
    'test',
    '--parallel',
    ...bunFiles.map((file) => `./${file}`),
  ]);
  exitCode = tests.exitCode ?? 1;
}
if (values['node-fallback'] && nodeFiles.length > 0) {
  const vitestDir = path.dirname(
    createRequire(import.meta.url).resolve('vitest/package.json'),
  );
  const tests = Bun.spawnSync(
    [
      'node',
      path.join(vitestDir, 'vitest.mjs'),
      '--typecheck.tsconfig',
      'tsconfig.test.json',
      '--run',
      ...nodeFiles.map((file) => `./${file}`),
    ],
    { cwd: serverDir, stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (tests.exitCode !== 0) exitCode = tests.exitCode ?? 1;
}
process.exit(exitCode);

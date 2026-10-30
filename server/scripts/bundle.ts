import dotenv from '@dotenvx/dotenvx';
dotenv.config({ debug: false, quiet: true, ignore: ['MISSING_ENV_FILE'] });

import esbuild from 'esbuild';
import fs from 'node:fs';
import { format } from 'node:util';
import { dirname } from 'node:path';
import { rimraf } from 'rimraf';
import { nodeProtocolPlugin } from '../esbuild/node-protocol.ts';

import { trimStart } from 'lodash-es';
import { createRequire } from 'node:module';
import { generateEnvModule } from './generateEnvModule.ts';
const __require = createRequire(import.meta.url);
const esbuildPluginPino = __require('esbuild-plugin-pino');

const DIST_DIR = 'dist';

if (fs.existsSync(DIST_DIR)) {
  console.log('Deleting old build...');
  await rimraf(DIST_DIR);
}

fs.mkdirSync(DIST_DIR);

console.log('Copying images...');
fs.cpSync('src/resources/images', `${DIST_DIR}/resources/images`, {
  recursive: true,
});

const isEdgeBuild = process.env.TUNARR_EDGE_BUILD === 'true';

// TODO: Do we want to hard-code any TUNARR_ prefixed environment variables at build time?
await generateEnvModule([
  'NODE_ENV',
  'TUNARR_VERSION',
  'TUNARR_BUILD',
  'TUNARR_EDGE_BUILD',
]);
const define = {
  'process.env.NODE_ENV': '"production"',
  'process.env.TUNARR_VERSION': `"${trimStart(process.env.TUNARR_VERSION, 'v')}"`,
  'process.env.TUNARR_BUILD': `"${process.env.TUNARR_BUILD}"`,
  'process.env.TUNARR_EDGE_BUILD': `"${isEdgeBuild}"`,
  'import.meta.url': '__import_meta_url',
};

console.debug(format('Building with Tunarr env: %O', define));

console.log('Bundling app...');
const result = await esbuild.build({
  entryPoints: {
    bundle: 'src/index.ts',
  },
  outExtension: {
    '.js': '.cjs',
  },
  bundle: true,
  minify: true,
  outdir: DIST_DIR,
  logLevel: 'info',
  format: 'cjs',
  platform: 'node',
  target: 'es2023',
  inject: [
    './esbuild/bundlerPathsOverrideShim.ts',
    './esbuild/importMetaUrlShim.ts',
  ],
  tsconfig: './tsconfig.build.json',
  external: [
    'better-sqlite3',
    'mysql',
    'mysql2',
    'sqlite3',
    'pg',
    'tedious',
    'pg-query-stream',
    'oracledb',
    'mariadb',
    'libsql',
  ],
  mainFields: ['module', 'main'],
  plugins: [
    nodeProtocolPlugin(),
    // copy({
    //   resolveFrom: 'cwd',
    //   assets: {
    //     from: ['node_modules/@fastify/swagger-ui/static/*'],
    //     to: ['build/static'],
    //   },
    // }),
    esbuildPluginPino({
      transports: ['pino-pretty', 'pino-roll'],
    }),
  ],
  keepNames: true, // This is to ensure that Entity class names remain the same
  metafile: true,
  define,
});

fs.writeFileSync(`${DIST_DIR}/meta.json`, JSON.stringify(result.metafile));

fs.cpSync('package.json', `${DIST_DIR}/package.json`);

// Keep the Node-API loader beside its prebuilds for Bun and native packaging.
const sqlitePackage = __require.resolve('better-sqlite3/package.json');
fs.cpSync(dirname(sqlitePackage), `${DIST_DIR}/node_modules/better-sqlite3`, {
  recursive: true,
});

console.log('Done bundling!');
process.exit(0);

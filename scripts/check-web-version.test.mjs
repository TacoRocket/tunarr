import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkWebVersion } from './check-web-version.mjs';

test('rejects the observed reused marker-probe UI with the Bun candidate backend', (t) => {
  const web = mkdtempSync(path.join(os.tmpdir(), 'tunarr-web-version-'));
  t.after(() => rmSync(web, { recursive: true, force: true }));
  writeFileSync(
    path.join(web, 'version.json'),
    JSON.stringify({ version: '2026.10.4-marker-probe' }),
  );
  assert.throws(
    () => checkWebVersion(web, '2026.10.4-bun-candidate.1'),
    /Web\/backend version mismatch/,
  );
  writeFileSync(
    path.join(web, 'version.json'),
    JSON.stringify({ version: '2026.10.4-bun-candidate.1' }),
  );
  assert.equal(
    checkWebVersion(web, '2026.10.4-bun-candidate.1'),
    '2026.10.4-bun-candidate.1',
  );
});

test('refuses legacy web assets without build version metadata', (t) => {
  const web = mkdtempSync(path.join(os.tmpdir(), 'tunarr-web-version-'));
  t.after(() => rmSync(web, { recursive: true, force: true }));
  assert.throws(
    () => checkWebVersion(web, '2026.10.4-bun-candidate.1'),
    /Web build has no version\.json.*rebuild the web bundle from this checkout/,
  );
});

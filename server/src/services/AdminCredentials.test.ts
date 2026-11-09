import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { AdminCredentialsFilename } from '../util/constants.ts';
import { AdminCredentials } from './AdminCredentials.ts';

let directory: string;
let credentials: AdminCredentials;

beforeEach(async () => {
  directory = await mkdtemp(join(os.tmpdir(), 'tunarr-admin-'));
  credentials = new AdminCredentials(directory);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function currentCode() {
  const file = await readFile(join(directory, 'setup-code.txt'), 'utf8');
  const match = /^Code: (\S+)$/m.exec(file);
  if (!match?.[1]) throw new Error('No code in the local setup file');
  return match[1];
}

test('the local setup code expires, can be used once, and cannot replace an administrator', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  await credentials.load();
  await credentials.requestSetupCode();
  const expired = await currentCode();
  now.mockReturnValue(1_000_000 + 10 * 60_000);
  await expect(credentials.claim(expired, 'owner', 'a')).rejects.toMatchObject({
    statusCode: 403,
  });
  await credentials.requestSetupCode();
  const first = await currentCode();
  await credentials.requestSetupCode();
  const latest = await currentCode();
  await expect(credentials.claim(first, 'owner', 'a')).rejects.toMatchObject({
    statusCode: 403,
  });
  const attempts = await Promise.allSettled([
    credentials.claim(latest, 'owner', 'a'),
    credentials.claim(latest, 'different', 'b'),
  ]);
  expect(attempts.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  await expect(credentials.requestSetupCode()).rejects.toMatchObject({
    statusCode: 409,
  });
  await expect(
    credentials.claim(latest, 'different', 'b'),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(currentCode()).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await credentials.verify('owner', 'a')).toBe(true);
});

test('a damaged account stays locked through restart and can be replaced only with a recovery code', async () => {
  await mkdir(join(directory, 'auth'));
  await writeFile(join(directory, AdminCredentialsFilename), '{');
  await credentials.load();
  expect(credentials.state).toBe('damaged');
  expect(await credentials.verify('owner', 'anything')).toBe(false);
  await expect(credentials.requestSetupCode()).rejects.toMatchObject({
    statusCode: 409,
  });
  await expect(
    credentials.recover('wrong', 'owner', 'new'),
  ).rejects.toMatchObject({ statusCode: 403 });
  await credentials.requestRecoveryCode();
  const code = await currentCode();
  await credentials.recover(code, 'owner', 'new');
  expect(credentials.state).toBe('configured');
  const restarted = new AdminCredentials(directory);
  await restarted.load();
  expect(restarted.state).toBe('configured');
  expect(await restarted.verify('owner', 'new')).toBe(true);
  await expect(
    restarted.recover(code, 'someone', 'else'),
  ).rejects.toMatchObject({ statusCode: 403 });
});

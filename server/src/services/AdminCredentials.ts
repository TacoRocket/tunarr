import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod/v4';
import { safeEqual } from '../util/basicAuth.ts';
import { AdminCredentialsFilename } from '../util/constants.ts';

const accountSchema = z.object({
  version: z.literal(1),
  username: z.string().min(1),
  scope: z.enum(['extensions', 'global']),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
type Account = z.infer<typeof accountSchema>;

const setupLifetimeMs = 10 * 60_000;
const maxConcurrentVerifications = 2;

function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(salt, 'hex'),
      32,
      {
        N: 1 << 15,
        r: 8,
        p: 3,
        maxmem: 40 * 1024 * 1024,
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
}

export class AdminCredentialError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class AdminCredentials {
  private readonly file: string;
  private account?: Account;
  private setup?: { code: string; expires: number };
  private verifications = 0;
  private saving = false;
  private readonly cacheKey = randomBytes(32);
  private lastProof?: Buffer;

  constructor(databaseDirectory: string) {
    this.file = join(databaseDirectory, AdminCredentialsFilename);
  }

  get scope() {
    return this.account?.scope;
  }

  async load() {
    try {
      this.account = accountSchema.parse(
        JSON.parse(await readFile(this.file, 'utf8')),
      );
    } catch (error) {
      // A damaged or unreadable record must never reopen registration.
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
      this.account = undefined;
    }
    this.lastProof = undefined;
  }

  private requireUnclaimed() {
    if (this.account)
      throw new AdminCredentialError(409, 'An administrator already exists.');
  }

  requestSetupCode() {
    this.requireUnclaimed();
    if (this.setup && Date.now() < this.setup.expires) return;
    const code = randomBytes(16).toString('base64url');
    this.setup = { code, expires: Date.now() + setupLifetimeMs };
    // The application log is visible through the web API. Only the process
    // console (container logs or native service output) may show this code.
    process.stderr.write(
      `Tunarr administrator setup code (valid for 10 minutes): ${code}\n`,
    );
  }

  async claim(code: string, username: string, password: string) {
    this.requireUnclaimed();
    if (
      !this.setup ||
      this.setup.expires <= Date.now() ||
      !safeEqual(code, this.setup.code)
    ) {
      throw new AdminCredentialError(
        403,
        'The setup code is incorrect or has expired.',
      );
    }
    if (
      !username ||
      username !== username.trim() ||
      username.length > 128 ||
      /[:\p{Cc}]/u.test(username)
    ) {
      throw new AdminCredentialError(
        400,
        'Choose a username of up to 128 characters without a colon, control characters or surrounding spaces.',
      );
    }
    if (password.length < 12 || password.length > 1024) {
      throw new AdminCredentialError(
        400,
        'Choose a password between 12 and 1024 characters.',
      );
    }
    this.setup = undefined;
    await this.save(username, password, 'extensions', false);
  }

  /** The HTTP caller must already be authenticated with these environment credentials. */
  async migrate(username: string, password: string) {
    await this.save(username, password, 'global', this.account !== undefined);
  }

  async verify(username: string, password: string) {
    const account = this.account;
    if (!account || !safeEqual(username, account.username)) return false;
    // Basic authentication resends the same proof on every protected request.
    // Remember one process-keyed digest after a successful password check.
    const proof = createHmac('sha256', this.cacheKey).update(password).digest();
    if (this.lastProof && timingSafeEqual(proof, this.lastProof)) return true;
    if (this.verifications >= maxConcurrentVerifications) {
      throw new AdminCredentialError(
        429,
        'Too many sign-in attempts. Try again shortly.',
      );
    }
    this.verifications++;
    try {
      const actual = await derive(password, account.salt);
      if (
        account !== this.account ||
        !timingSafeEqual(actual, Buffer.from(account.hash, 'hex'))
      )
        return false;
      this.lastProof = proof;
      return true;
    } finally {
      this.verifications--;
    }
  }

  /** Local CLI only. The running server picks up the replacement on restart. */
  async resetPassword() {
    const account = this.account;
    if (!account)
      throw new Error(
        'There is no saved administrator in this data directory.',
      );
    const password = randomBytes(24).toString('base64url');
    await this.save(account.username, password, account.scope, true);
    return { username: account.username, password };
  }

  private async save(
    username: string,
    password: string,
    scope: Account['scope'],
    replace: boolean,
  ) {
    if (this.saving)
      throw new AdminCredentialError(
        409,
        'Administrator credentials are being saved.',
      );
    this.saving = true;
    try {
      await this.writeAccount(username, password, scope, replace);
    } finally {
      this.saving = false;
    }
  }

  private async writeAccount(
    username: string,
    password: string,
    scope: Account['scope'],
    replace: boolean,
  ) {
    const salt = randomBytes(16).toString('hex');
    const hash = (await derive(password, salt)).toString('hex');
    const account: Account = { version: 1, username, scope, salt, hash };
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const directory = await lstat(dir);
    if (
      !directory.isDirectory() ||
      (process.geteuid && directory.uid !== process.geteuid())
    ) {
      throw new Error(
        'Use the same operating system account as the Tunarr server to save administrator credentials.',
      );
    }
    const tmp = join(dir, '.admin-' + randomBytes(12).toString('hex'));
    const handle = await open(tmp, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(JSON.stringify(account) + '\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Linking a complete record is an atomic first-claim operation across
      // processes. Replacing an existing password instead uses atomic rename.
      if (replace) await rename(tmp, this.file);
      else {
        try {
          await link(tmp, this.file);
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'EEXIST'
          ) {
            throw new AdminCredentialError(
              409,
              'An administrator already exists.',
            );
          }
          throw error;
        }
      }
      this.account = account;
      this.lastProof = undefined;
    } finally {
      await rm(tmp, { force: true });
    }
  }
}

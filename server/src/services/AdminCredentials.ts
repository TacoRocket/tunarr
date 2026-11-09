import { Mutex } from 'async-mutex';
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

// Publish only complete, owner-readable files. First claim must never overwrite
// an account that another claimant managed to create.
async function writePrivateFile(
  file: string,
  contents: string,
  createOnly = false,
) {
  const tmp = join(dirname(file), '.admin-' + randomBytes(12).toString('hex'));
  const handle = await open(tmp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (createOnly) await link(tmp, file);
    else await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

type CodePurpose = 'setup' | 'recovery';

export class AdminCredentials {
  private readonly file: string;
  private account?: Account;
  private damaged = false;
  private setup?: { purpose: CodePurpose; code: string; expires: number };
  readonly setupCodePath: string;
  private readonly changes = new Mutex();
  private sessionSecret: Buffer = randomBytes(32);
  private verifications = 0;
  private readonly cacheKey = randomBytes(32);
  private lastProof?: Buffer;

  constructor(databaseDirectory: string) {
    this.file = join(databaseDirectory, AdminCredentialsFilename);
    this.setupCodePath = join(databaseDirectory, 'setup-code.txt');
  }

  get state(): 'configured' | 'damaged' | 'unclaimed' {
    if (this.damaged) return 'damaged';
    return this.account ? 'configured' : 'unclaimed';
  }

  // A new salt changes this signing key in the same atomic write as the
  // password, even when the owner chooses the same password during recovery.
  get signingKey(): Buffer {
    return createHmac('sha256', this.sessionSecret)
      .update(this.account?.salt ?? 'no-local-account')
      .digest();
  }

  async load() {
    this.lastProof = undefined;
    this.setup = undefined;
    this.account = undefined;
    this.damaged = false;
    await this.removeCodeFile();
    try {
      const entry = await lstat(this.file);
      if (!entry.isFile()) this.damaged = true;
      else
        this.account = accountSchema.parse(
          JSON.parse(await readFile(this.file, 'utf8')),
        );
    } catch (error) {
      this.damaged = !(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      );
    }
    const keyFile = join(dirname(this.file), 'session.key');
    try {
      const key = await readFile(keyFile, 'utf8');
      if (/^[a-f0-9]{64}$/.test(key)) {
        this.sessionSecret = Buffer.from(key, 'hex');
        return;
      }
    } catch {
      // Missing or unreadable signing keys invalidate sessions, never accounts.
    }
    this.sessionSecret = randomBytes(32);
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writePrivateFile(keyFile, this.sessionSecret.toString('hex'));
    } catch {
      process.stderr.write(
        'Tunarr could not save its session key. Browser sign-ins will expire on restart.\n',
      );
    }
  }

  private async removeCodeFile() {
    try {
      await rm(this.setupCodePath, { force: true });
    } catch {
      // Stale files are never read as authority; only the current process
      // can recognize an outstanding code.
      process.stderr.write(
        'Tunarr could not remove the expired administrator code file.\n',
      );
    }
  }

  private checkPurpose(purpose: CodePurpose) {
    if (purpose === 'setup' && this.state !== 'unclaimed')
      throw new AdminCredentialError(
        409,
        'An administrator already exists. Use account recovery.',
      );
    if (purpose === 'recovery' && this.state === 'unclaimed')
      throw new AdminCredentialError(409, 'Set up the administrator first.');
  }

  requestSetupCode() {
    return this.issueCode('setup');
  }

  requestRecoveryCode() {
    return this.issueCode('recovery');
  }

  private issueCode(purpose: CodePurpose) {
    return this.changes.runExclusive(async () => {
      this.checkPurpose(purpose);
      const code = randomBytes(16).toString('base64url');
      const expires = Date.now() + setupLifetimeMs;
      const contents = `Tunarr administrator ${purpose}
Code: ${code}
Expires: ${new Date(expires).toISOString()}
`;
      await writePrivateFile(this.setupCodePath, contents);
      this.setup = { purpose, code, expires };
      // The application log is also exposed by HTTP. Use process stderr only.
      process.stderr.write(contents);
    });
  }

  claim(code: string, username: string, password: string) {
    return this.saveWithCode('setup', code, username, password);
  }

  recover(code: string, username: string, password: string) {
    return this.saveWithCode('recovery', code, username, password);
  }

  private saveWithCode(
    purpose: CodePurpose,
    code: string,
    username: string,
    password: string,
  ) {
    return this.changes.runExclusive(async () => {
      this.checkPurpose(purpose);
      if (
        !this.setup ||
        this.setup.purpose !== purpose ||
        this.setup.expires <= Date.now() ||
        !safeEqual(code, this.setup.code)
      )
        throw new AdminCredentialError(
          403,
          'The code is incorrect or has expired.',
        );
      if (!username || /[:\p{Cc}]/u.test(username))
        throw new AdminCredentialError(
          400,
          'Choose a username without a colon or control characters.',
        );
      if (!password) throw new AdminCredentialError(400, 'Enter a password.');

      const salt = randomBytes(16).toString('hex');
      const hash = (await derive(password, salt)).toString('hex');
      const account: Account = { version: 1, username, salt, hash };
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      try {
        await writePrivateFile(
          this.file,
          JSON.stringify(account) + '\n',
          purpose === 'setup',
        );
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        )
          throw new AdminCredentialError(
            409,
            'An administrator already exists.',
          );
        throw error;
      }
      this.account = account;
      this.damaged = false;
      this.lastProof = undefined;
      this.setup = undefined;
      await this.removeCodeFile();
    });
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
}

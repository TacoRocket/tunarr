import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  readBasicCredentials,
  safeEqual,
  validateBasicAuth,
} from '../util/basicAuth.ts';
import type { AdminCredentials } from './AdminCredentials.ts';

const cookieName = 'tunarr_admin';
const sessionLifetimeSeconds = 12 * 60 * 60;
const maxSessions = 32;

export function isSameOriginWrite(req: FastifyRequest) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const site = req.headers['sec-fetch-site'];
  if (site === 'same-origin') return true;
  if (site === 'cross-site' || site === 'same-site') return false;
  // Some LAN browsers omit Fetch Metadata on HTTP. Non-browser API clients
  // normally send neither header.
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  const url = URL.parse(origin);
  return (
    !!url && url.origin === URL.parse(`${req.protocol}://${req.host}`)?.origin
  );
}

export class AdminAccess {
  private readonly sessions = new Map<string, number>();
  private environmentSaved = false;

  constructor(
    readonly credentials: AdminCredentials,
    private readonly environment:
      | { username: string; password: string }
      | undefined,
    readonly trustedLan: boolean,
  ) {}

  async load() {
    await this.credentials.load();
    this.environmentSaved =
      !!this.environment &&
      this.credentials.scope === 'global' &&
      (await this.credentials.verify(
        this.environment.username,
        this.environment.password,
      ));
  }

  get mode(): 'environment' | 'global' | 'extensions' | 'setup' {
    if (this.environment && !this.environmentSaved) return 'environment';
    return this.credentials.scope ?? 'setup';
  }

  get global() {
    return !!this.environment || this.credentials.scope === 'global';
  }

  private sessionToken(req: FastifyRequest) {
    return /(?:^|;\s*)tunarr_admin=([A-Za-z0-9_-]{43})(?:;|$)/.exec(
      req.headers.cookie ?? '',
    )?.[1];
  }

  signedIn(req: FastifyRequest) {
    const token = this.sessionToken(req);
    if (!token) return false;
    const end = this.sessions.get(token);
    if (end === undefined) return false;
    if (end > Date.now()) return true;
    this.sessions.delete(token);
    return false;
  }

  canManage(req: FastifyRequest) {
    // Global installations already passed the HTTP auth hook on these routes.
    return this.global || this.trustedLan || this.signedIn(req);
  }

  async checkBasic(req: FastifyRequest) {
    if (this.signedIn(req)) return true;
    if (this.environment) {
      return validateBasicAuth(
        req.headers.authorization,
        this.environment.username,
        this.environment.password,
      );
    }
    const pair = readBasicCredentials(req.headers.authorization);
    return !!pair && this.verify(pair.username, pair.password);
  }

  async verify(username: string, password: string) {
    if (this.environment) {
      const userMatches = safeEqual(username, this.environment.username);
      const passwordMatches = safeEqual(password, this.environment.password);
      return userMatches && passwordMatches;
    }
    return this.credentials.verify(username, password);
  }

  private cookie(req: FastifyRequest, token: string, maxAge: number) {
    const secure = req.protocol === 'https' ? '; Secure' : '';
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  signIn(req: FastifyRequest, reply: FastifyReply) {
    const previous = this.sessionToken(req);
    if (previous) this.sessions.delete(previous);
    if (this.sessions.size >= maxSessions) {
      const oldest = this.sessions.keys().next();
      if (!oldest.done) this.sessions.delete(oldest.value);
    }
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, Date.now() + sessionLifetimeSeconds * 1000);
    reply.header('Set-Cookie', this.cookie(req, token, sessionLifetimeSeconds));
  }

  signOut(req: FastifyRequest, reply: FastifyReply) {
    const previous = this.sessionToken(req);
    if (previous) this.sessions.delete(previous);
    reply.header('Set-Cookie', this.cookie(req, '', 0));
  }

  async migrate(username: string, password: string) {
    if (this.mode !== 'environment' || !(await this.verify(username, password)))
      return false;
    await this.credentials.migrate(username, password);
    this.environmentSaved = true;
    this.sessions.clear();
    return true;
  }
}

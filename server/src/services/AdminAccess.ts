import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  createTunarrBasicAuthHook,
  readBasicCredentials,
  safeEqual,
  isAuthorized,
} from '../util/basicAuth.ts';
import type { AdminCredentials } from './AdminCredentials.ts';

const cookieName = 'tunarr_admin';
const sessionLifetimeSeconds = 12 * 60 * 60;

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
  constructor(
    readonly credentials: AdminCredentials,
    private readonly environment:
      | { username: string; password: string }
      | undefined,
    readonly trustedLan: boolean,
  ) {}

  get mode(): 'environment' | 'saved' | 'damaged' | 'setup' {
    if (this.environment) return 'environment';
    switch (this.credentials.state) {
      case 'unclaimed':
        return 'setup';
      case 'configured':
        return 'saved';
      case 'damaged':
        return 'damaged';
    }
  }

  private signature(expires: string) {
    return createHmac('sha256', this.credentials.signingKey)
      .update(expires)
      .digest('base64url');
  }

  signedIn(req: FastifyRequest) {
    if (this.mode !== 'saved') return false;
    const token =
      /(?:^|;\s*)tunarr_admin=(\d{13})\.([A-Za-z0-9_-]{43})(?:;|$)/.exec(
        req.headers.cookie ?? '',
      );
    if (!token?.[1] || !token[2]) return false;
    const [, expires, signature] = token;
    return (
      Number(expires) > Date.now() &&
      safeEqual(signature, this.signature(expires))
    );
  }

  get canManage() {
    // Protected store routes already passed the server-wide auth hook.
    return (
      this.mode === 'environment' ||
      this.mode === 'saved' ||
      (this.mode === 'setup' && this.trustedLan)
    );
  }

  private async verifyBasic(req: FastifyRequest) {
    if (this.environment) {
      return isAuthorized(req.headers.authorization, this.environment);
    }
    const pair = readBasicCredentials(req.headers.authorization);
    return !!pair && this.credentials.verify(pair.username, pair.password);
  }

  async canViewPrivate(req: FastifyRequest) {
    return this.mode === 'setup' || this.signedIn(req) || this.verifyBasic(req);
  }

  authHook() {
    const basic = createTunarrBasicAuthHook(
      (req) => this.verifyBasic(req),
      () => this.mode !== 'environment',
    );

    return async (req: FastifyRequest, reply: FastifyReply) => {
      // Setup takes effect on the very next request, including on existing connections.
      if (
        this.mode === 'setup' ||
        req.routeOptions.config?.authRequired === false
      )
        return;
      if (this.signedIn(req)) {
        if (!isSameOriginWrite(req))
          return reply
            .code(403)
            .send({ message: 'Open Tunarr directly to make changes.' });
        return;
      }
      return basic(req, reply);
    };
  }

  private cookie(req: FastifyRequest, token: string, maxAge: number) {
    const secure = req.protocol === 'https' ? '; Secure' : '';
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  signIn(req: FastifyRequest, reply: FastifyReply) {
    const expires = String(Date.now() + sessionLifetimeSeconds * 1000);
    const token = expires + '.' + this.signature(expires);
    reply.header('Set-Cookie', this.cookie(req, token, sessionLifetimeSeconds));
  }

  signOut(req: FastifyRequest, reply: FastifyReply) {
    reply.header('Set-Cookie', this.cookie(req, '', 0));
  }
}

import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnvVar, TUNARR_ENV_VARS } from './env.ts';

export interface BasicAuthConfig {
  username: string;
  password: string;
}

export function basicAuthConfigFromEnv(): BasicAuthConfig | undefined {
  const username = getEnvVar(TUNARR_ENV_VARS.BASIC_AUTH_USER_ENV_VAR);
  const password = getEnvVar(TUNARR_ENV_VARS.BASIC_AUTH_PASSWORD_ENV_VAR);
  if (!username || !password) {
    return;
  }
  return { username, password };
}

function unauthorized(reply: FastifyReply) {
  reply.header('WWW-Authenticate', 'Basic realm="Tunarr"');
  return reply.status(401).send('Authentication required');
}

function hash(value: string) {
  return crypto.createHash('sha256').update(value).digest();
}

export function safeEqual(a: string, b: string) {
  return crypto.timingSafeEqual(hash(a), hash(b));
}

export function readBasicCredentials(authHeader: string | undefined) {
  if (!authHeader?.startsWith('Basic ')) return;
  const encoded = authHeader.slice(6).trim();
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const idx = decoded.indexOf(':');

  if (idx < 0) return;
  return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

export function validateBasicAuth(
  authHeader: string | undefined,
  expectedUser: string,
  expectedPass: string,
) {
  const pair = readBasicCredentials(authHeader);
  if (!pair) return false;
  const userMatches = safeEqual(pair.username, expectedUser);
  const passMatches = safeEqual(pair.password, expectedPass);
  return userMatches && passMatches;
}

// True when basic auth is off or the header carries valid credentials. Routes
// marked `authRequired: false` use it to hold back private data.
export function isAuthorized(
  authHeader: string | undefined,
  config: BasicAuthConfig | undefined,
) {
  return (
    !config || validateBasicAuth(authHeader, config.username, config.password)
  );
}

export function createTunarrBasicAuthHook(
  verify: (request: FastifyRequest) => Promise<boolean>,
  loginPage?: () => boolean,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.routeOptions.config?.authRequired === false) return;
    if (await verify(request)) return;
    if (
      loginPage?.() &&
      request.method === 'GET' &&
      request.headers.accept?.includes('text/html') &&
      /^\/(?:web(?:[/?]|$)|$)/.test(request.url)
    ) {
      const next = request.url === '/' ? '/web' : request.url;
      return reply
        .header('Cache-Control', 'no-store')
        .redirect('/admin?next=' + encodeURIComponent(next));
    }
    return unauthorized(reply);
  };
}

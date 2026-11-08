import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

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

export function createTunarrBasicAuthHook(
  verify: (request: FastifyRequest) => Promise<boolean>,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.routeOptions.config?.authRequired === false) return;
    if (!(await verify(request))) return unauthorized(reply);
  };
}

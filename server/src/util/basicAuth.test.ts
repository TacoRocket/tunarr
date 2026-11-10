import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import {
  createTunarrBasicAuthHook,
  isAuthorized,
  safeEqual,
  validateBasicAuth,
} from './basicAuth.ts';

function basicAuthHeader(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function createRequest(
  authorization?: string,
  authRequired?: boolean,
): FastifyRequest {
  return {
    headers: {
      authorization,
    },
    routeOptions: {
      config: authRequired === undefined ? {} : { authRequired },
    },
  } as unknown as FastifyRequest;
}

type MockReply = FastifyReply & {
  header: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function createReply(): MockReply {
  const reply = {} as MockReply;

  reply.header = vi.fn(() => reply);
  reply.status = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);

  return reply;
}

describe('basicAuth', () => {
  describe('safeEqual', () => {
    test('returns true for matching strings', () => {
      expect(safeEqual('tunarr', 'tunarr')).toBe(true);
    });

    test('returns false for non-matching strings with different lengths', () => {
      expect(safeEqual('tunarr', 'tunarr-password')).toBe(false);
    });
  });

  describe('validateBasicAuth', () => {
    test('returns false when the authorization header is missing', () => {
      expect(validateBasicAuth(undefined, 'user', 'pass')).toBe(false);
    });

    test('returns false when the authorization header is not basic auth', () => {
      expect(validateBasicAuth('Bearer token', 'user', 'pass')).toBe(false);
    });

    test('returns false when the credentials are malformed', () => {
      expect(validateBasicAuth('Basic bm9jb2xvbg==', 'user', 'pass')).toBe(
        false,
      );
    });

    test('returns false when the credentials do not match', () => {
      expect(
        validateBasicAuth(basicAuthHeader('wrong', 'creds'), 'user', 'pass'),
      ).toBe(false);
    });

    test('returns true when the credentials match', () => {
      expect(
        validateBasicAuth(basicAuthHeader('user', 'pass'), 'user', 'pass'),
      ).toBe(true);
    });
  });

  describe('createTunarrBasicAuthHook', () => {
    const hook = createTunarrBasicAuthHook(async (req) =>
      validateBasicAuth(req.headers.authorization, 'user', 'pass'),
    );

    test('skips auth when route config marks authRequired false', async () => {
      const reply = createReply();

      await hook(createRequest(undefined, false), reply);

      expect(reply.status).not.toHaveBeenCalled();
      expect(reply.send).not.toHaveBeenCalled();
    });

    test('rejects protected routes when credentials are missing', async () => {
      const reply = createReply();

      await hook(createRequest(), reply);

      expect(reply.header).toHaveBeenCalledWith(
        'WWW-Authenticate',
        'Basic realm="Tunarr"',
      );
      expect(reply.status).toHaveBeenCalledWith(401);
      expect(reply.send).toHaveBeenCalledWith('Authentication required');
    });

    test('rejects protected routes when credentials are invalid', async () => {
      const reply = createReply();

      await hook(createRequest(basicAuthHeader('user', 'wrong')), reply);

      expect(reply.status).toHaveBeenCalledWith(401);
      expect(reply.send).toHaveBeenCalledWith('Authentication required');
    });

    test('allows protected routes when credentials are valid', async () => {
      const reply = createReply();

      await hook(createRequest(basicAuthHeader('user', 'pass')), reply);

      expect(reply.status).not.toHaveBeenCalled();
      expect(reply.send).not.toHaveBeenCalled();
    });
  });
});

describe('isAuthorized', () => {
  const config = { username: 'admin', password: 'secret' };

  test('allows any request when basic auth is off', () => {
    expect(isAuthorized(undefined, undefined)).toBe(true);
  });

  test('allows a request with valid credentials', () => {
    expect(isAuthorized(basicAuthHeader('admin', 'secret'), config)).toBe(true);
  });

  test('rejects a request with missing or wrong credentials', () => {
    expect(isAuthorized(undefined, config)).toBe(false);
    expect(isAuthorized(basicAuthHeader('admin', 'wrong'), config)).toBe(false);
  });
});

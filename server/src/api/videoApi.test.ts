import { container } from '@/container.js';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { videoApiRouter } from './videoApi.ts';

vi.mock('@/container.js', () => ({ container: { get: vi.fn() } }));
vi.mock('@/stream/VideoStream.js', () => ({ VideoStream: class {} }));

describe('media request reporting lifetime', () => {
  it.each(['channel lookup', 'timestamp lookup', 'already closed'])(
    'passes an aborted reporting signal after disconnect during %s',
    async (stage) => {
      type Handler = (request: unknown, response: unknown) => Promise<unknown>;
      let handler: Handler | undefined;
      const routes = {
        addHook: vi.fn(),
        get: (url: string, _options: unknown, callback: Handler) => {
          if (url.startsWith('/stream:')) handler = callback;
        },
      };
      await videoApiRouter(
        routes as unknown as Parameters<typeof videoApiRouter>[0],
        {},
      );
      if (!handler) throw new Error('Missing raw stream handler');

      const reachedLookup = Promise.withResolvers<void>();
      const releaseLookup = Promise.withResolvers<void>();
      const request = {
        query: { channel: 'channel', mode: 'mpegts' },
        ip: '127.0.0.1',
        headers: {},
        serverCtx: {
          channelDB: {
            getChannel: async () => {
              if (stage === 'channel lookup') {
                reachedLookup.resolve();
                await releaseLookup.promise;
              }
              return { uuid: 'channel' };
            },
          },
          onDemandChannelService: {
            getLiveTimestamp: async () => {
              if (stage === 'timestamp lookup') {
                reachedLookup.resolve();
                await releaseLookup.promise;
              }
              return 123;
            },
          },
        },
      };
      const raw = Object.assign(new EventEmitter(), {
        destroyed: stage === 'already closed',
      });
      const response = { raw, status: vi.fn().mockReturnThis(), send: vi.fn() };
      const startStream = vi
        .fn<(options: { requestSignal: AbortSignal }) => Promise<unknown>>()
        .mockResolvedValue({
          type: 'error',
          httpStatus: 500,
          message: 'unit boundary',
        });
      vi.mocked(container.get).mockReturnValue({ startStream });

      const pending = handler(request, response);
      if (stage !== 'already closed') {
        await reachedLookup.promise;
        raw.destroyed = true;
        raw.emit('close');
        releaseLookup.resolve();
      }
      await pending;
      expect(startStream).toHaveBeenCalledTimes(1);
      expect(startStream.mock.calls[0]?.[0].requestSignal.aborted).toBe(true);
    },
  );
});

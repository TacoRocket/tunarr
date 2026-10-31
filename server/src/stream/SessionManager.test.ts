import type { IChannelDB } from '@/db/interfaces/IChannelDB.js';
import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { HlsOptions } from '@/ffmpeg/builder/constants.js';
import type { EventService } from '@/services/EventService.js';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import type { Logger } from '@/util/logging/LoggerFactory.js';
import type { StreamDegradation } from '@tunarr/types';
import type { DeepRequired } from 'ts-essentials';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelSessionsResponseSchema } from '@tunarr/types/api';
import { sessionToApiSession } from '../db/converters/sessionConverter.ts';
import type { ConcatSessionFactory } from './ConcatSession.ts';
import type { SessionConcatStreamMode } from '@tunarr/types/schemas';
import { SessionConcatStreamModes } from '@tunarr/types/schemas';
import type { HlsSessionOptions } from './hls/HlsSession.ts';

// Mock modules that create circular dependency chains through Inversify
vi.mock('@/services/EventService.js', () => ({
  EventService: vi.fn(),
}));

vi.mock('@/services/OnDemandChannelService.js', () => ({
  OnDemandChannelService: vi.fn(),
}));

// Must be imported after the mocks are set up
const { SessionManager } = await import('./SessionManager.ts');
const { BaseHlsSession } = await import('./hls/BaseHlsSession.ts');
const { ConcatSession } = await import('./ConcatSession.ts');

// ---------------------------------------------------------------------------
// Stub session: a minimal HlsSession-like object that lets us control
// start/stop behaviour and manually emit events.
// ---------------------------------------------------------------------------

class StubHlsSession extends BaseHlsSession<HlsSessionOptions> {
  public readonly sessionType: 'hls' | 'hls_direct_v2';

  constructor(
    channel: ChannelOrmWithTranscodeConfig,
    options: HlsSessionOptions,
  ) {
    super(channel, options);
    this.sessionType = options.streamMode;
  }

  protected getHlsOptions(): DeepRequired<HlsOptions> {
    return {
      hlsDeleteThreshold: 3,
      streamNameFormat: 'stream.m3u8',
      subtitleStreamNameFormat: 'subs.m3u8',
      segmentNameFormat: 'data%06d.ts',
      segmentBaseDirectory: '/tmp/test-sessions',
      streamBasePath: 'test',
      streamBaseUrl: '/test/',
      hlsTime: 4,
      hlsListSize: 0,
      deleteThreshold: null,
      appendSegments: true,
    };
  }

  // Skip all real startup work — just mark as started
  protected override async startInternal() {
    this.state = 'started';
  }

  protected override async stopInternal() {
    this.state = 'stopped';
  }

  // Skip waiting for stream files
  protected override async waitForStreamReady() {
    const { Result } = await import('@/types/result.js');
    return Result.success(void 0);
  }

  // Use the real Session.isStale() implementation so staleness
  // tests exercise the actual threshold logic.
}

/** A session whose stream never becomes ready. */
class NeverReadySession extends StubHlsSession {
  protected override async waitForStreamReady() {
    const { Result } = await import('@/types/result.js');
    const { GenericError } = await import('@/types/errors.js');
    return Result.failure<void>(new GenericError('stream never became ready'));
  }
}

/** A session that throws out of startInternal. */
class FailingStartSession extends StubHlsSession {
  protected override async startInternal() {
    throw new Error('ffmpeg could not be spawned');
  }
}

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

const noopLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
  setBindings: vi.fn(),
  child: () => noopLogger,
  bindings: () => ({}),
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const channelUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeChannel(): ChannelOrmWithTranscodeConfig {
  return {
    uuid: channelUuid,
    number: 1,
    transcodeConfig: {},
  } as unknown as ChannelOrmWithTranscodeConfig;
}

function makeSessionManager(
  hlsFactory: (
    channel: ChannelOrmWithTranscodeConfig,
    options: HlsSessionOptions,
  ) => StubHlsSession,
  concatSessionFactory: ConcatSessionFactory = vi.fn(),
) {
  const channelDB: Partial<IChannelDB> = {
    getChannelOrm: vi.fn().mockResolvedValue(makeChannel()),
  };

  const onDemandService: Partial<OnDemandChannelService> = {
    resumeChannel: vi.fn().mockResolvedValue(undefined),
    pauseChannel: vi.fn().mockResolvedValue(undefined),
  };

  const eventService: Partial<EventService> = {
    push: vi.fn(),
  };

  const settingsDB: Partial<ISettingsDB> = {
    ffmpegSettings: vi.fn().mockReturnValue({
      transcodeDirectory: '/tmp/test-sessions',
    }),
  };

  // Construct SessionManager directly, bypassing Inversify
  const manager = new (SessionManager as any)(
    channelDB,
    onDemandService,
    hlsFactory,
    vi.fn(), // hlsSlowerSessionFactory — not used in these tests
    concatSessionFactory,
    vi.fn(), // etvNextSessionFactory
    eventService,
    settingsDB,
  ) as SessionManager;

  // Override the @InjectLogger() property with a noop mock so
  // tests don't require an initialized LoggerFactory.
  (manager as any).logger = noopLogger;

  return manager;
}

const connection = { ip: '127.0.0.1' };

describe('SessionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A session that never became ready must not be handed to a client. Both
  // failure paths have to leave the session in 'error', because that is what
  // getOrCreateSession reads to decide whether to serve it.
  describe('readiness and startup failures', () => {
    it('does not report a session started when the stream never becomes ready', async () => {
      const manager = makeSessionManager(
        (channel, options) => new NeverReadySession(channel, options),
      );

      const result = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-a',
        connection,
        { streamMode: 'hls' },
      );

      expect(result.isFailure()).toBe(true);
      expect(result.error.message).toContain('stream never became ready');
    });

    it('surfaces the error a session threw while starting', async () => {
      const manager = makeSessionManager(
        (channel, options) => new FailingStartSession(channel, options),
      );

      const result = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-a',
        connection,
        { streamMode: 'hls' },
      );

      expect(result.isFailure()).toBe(true);
      expect(result.error.message).toContain('ffmpeg could not be spawned');
    });

    // HLS sessions never emit 'stop', so the failed session stays in the map.
    // The next request must replace it rather than reuse it.
    it('replaces a session that failed to start on the next request', async () => {
      const created: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const session =
          created.length === 0
            ? new FailingStartSession(channel, options)
            : new StubHlsSession(channel, options);
        created.push(session);
        return session;
      });

      const first = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-a',
        connection,
        { streamMode: 'hls' },
      );
      expect(first.isFailure()).toBe(true);

      await vi.advanceTimersByTimeAsync(0);

      const second = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-b',
        connection,
        { streamMode: 'hls' },
      );

      expect(second.isSuccess()).toBe(true);
      expect(created).toHaveLength(2);
    });
  });

  describe('session replacement race condition', () => {
    it('replaces a stopping session with one that has its own directory', async () => {
      class SlowStopHlsSession extends StubHlsSession {
        readonly stopGate = Promise.withResolvers<void>();

        protected override async stopInternal() {
          await this.stopGate.promise;
        }
      }

      const sessions: SlowStopHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new SlowStopHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0];
      expect(sessionA).toBeDefined();
      if (!sessionA) return;

      // Simulates an ffmpeg that has not exited yet.
      const stopA = sessionA.stop();
      await vi.waitFor(() => expect(sessionA.state).toBe('stopping'));

      await manager.getOrCreateHlsSession(channelUuid, 'token-b', connection, {
        streamMode: 'hls',
      });
      const sessionB = sessions[1];
      expect(sessionB).toBeDefined();
      if (!sessionB) return;

      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);
      expect(sessionB.workingDirectory).not.toBe(sessionA.workingDirectory);

      sessionA.stopGate.resolve();
      await stopA;
      expect(sessionA.state).toBe('stopped');
      sessionA.emit('cleanup');
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);
    });

    it('endSession does not block a tune-in while the old session stops', async () => {
      class SlowStopHlsSession extends StubHlsSession {
        readonly stopGate = Promise.withResolvers<void>();

        protected override async stopInternal() {
          await this.stopGate.promise;
        }
      }

      const sessions: SlowStopHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new SlowStopHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0];
      expect(sessionA).toBeDefined();
      if (!sessionA) return;

      const endA = manager.endSession(channelUuid, 'hls');
      await vi.waitFor(() => expect(sessionA.state).toBe('stopping'));
      expect(manager.getHlsSession(channelUuid)).toBeUndefined();

      // Must resolve while Session A's stop is still pending.
      const resultB = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-b',
        connection,
        { streamMode: 'hls' },
      );
      expect(resultB.isSuccess()).toBe(true);
      expect(manager.getHlsSession(channelUuid)).toBe(sessions[1]);

      sessionA.stopGate.resolve();
      await endA;
      expect(sessionA.state).toBe('stopped');
      expect(manager.getHlsSession(channelUuid)).toBe(sessions[1]);
    });

    it('endSessionInBackground resolves before the session finishes stopping', async () => {
      class SlowStopHlsSession extends StubHlsSession {
        readonly stopGate = Promise.withResolvers<void>();

        protected override async stopInternal() {
          await this.stopGate.promise;
        }
      }

      const sessions: SlowStopHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new SlowStopHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0];
      expect(sessionA).toBeDefined();
      if (!sessionA) return;

      // Would hang if this awaited the stop, which is gated below.
      await manager.endSessionInBackground(sessionA);

      expect(manager.getHlsSession(channelUuid)).toBeUndefined();
      await vi.waitFor(() => expect(sessionA.state).toBe('stopping'));

      sessionA.stopGate.resolve();
      await vi.waitFor(() => expect(sessionA.state).toBe('stopped'));
    });

    it('stop event from Session A does not delete Session B at the same key', async () => {
      // Track which sessions the factory creates so we can reference them
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      // Create Session A
      const resultA = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-a',
        connection,
        { streamMode: 'hls' },
      );
      expect(resultA.isSuccess()).toBe(true);
      const sessionA = sessions[0]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionA);

      // End Session A through the manager (simulates user stopping stream)
      await manager.endSession(channelUuid, 'hls');
      expect(manager.getHlsSession(channelUuid)).toBeUndefined();

      // Create Session B at the same key (user starts stream again)
      const resultB = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-b',
        connection,
        { streamMode: 'hls' },
      );
      expect(resultB.isSuccess()).toBe(true);
      const sessionB = sessions[1]!;
      expect(sessionB).not.toBe(sessionA);
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);

      // Session A's delayed 'stop' event fires (stale event from the old session)
      sessionA.emit('stop');

      // Session B must still be in the map — the identity guard prevents deletion
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);
    });

    it('cleanup event from Session A does not delete Session B at the same key', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      // Create Session A
      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0]!;

      // End Session A
      await manager.endSession(channelUuid, 'hls');

      // Create Session B
      await manager.getOrCreateHlsSession(channelUuid, 'token-b', connection, {
        streamMode: 'hls',
      });
      const sessionB = sessions[1]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);

      // Session A's delayed 'cleanup' event fires
      sessionA.emit('cleanup');

      // Session B must still be in the map
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);
    });

    it('stop event from the current session DOES remove it from the map', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionA);

      // The session's own stop event should still clean up normally
      sessionA.emit('stop');

      expect(manager.getHlsSession(channelUuid)).toBeUndefined();
    });

    it('cleanup event from the current session DOES remove it from the map', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionA);

      sessionA.emit('cleanup');

      expect(manager.getHlsSession(channelUuid)).toBeUndefined();
    });
  });

  describe('connection staleness and recovery', () => {
    it('session is not stale when heartbeat is within threshold', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Heartbeat was just recorded by getOrCreateHlsSession → addConnection
      expect(session.isStale()).toBe(false);

      // Advance 60 seconds — well within the 120s default threshold
      vi.advanceTimersByTime(60_000);
      session.recordHeartbeat('10.0.0.1');
      expect(session.isStale()).toBe(false);
    });

    it('session becomes stale when heartbeat exceeds threshold', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past the 120s default threshold
      vi.advanceTimersByTime(121_000);
      expect(session.isStale()).toBe(true);
    });

    it('ghost heartbeat: recordHeartbeat after staleness removal does not prevent cleanup', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past staleness threshold
      vi.advanceTimersByTime(121_000);

      // removeStaleConnections drops the connection
      expect(session.isStale()).toBe(true);
      // Connection is now gone from #connections
      expect(session.isKnownConnection('10.0.0.1')).toBe(false);

      // Client sends a segment request → recordHeartbeat is called
      // but this is a "ghost heartbeat" — it updates #heartbeats only
      session.recordHeartbeat('10.0.0.1');

      // Session is STILL stale because #connections is empty
      expect(session.isStale()).toBe(true);
    });

    it('addConnection after staleness removal restores the session', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past staleness threshold
      vi.advanceTimersByTime(121_000);

      // Connection removed by staleness check
      expect(session.isStale()).toBe(true);
      expect(session.isKnownConnection('10.0.0.1')).toBe(false);

      // The fix: fragment route checks isKnownConnection and re-adds
      session.addConnection('10.0.0.1', { ip: '10.0.0.1' });
      session.recordHeartbeat('10.0.0.1');

      // Session is no longer stale
      expect(session.isStale()).toBe(false);
      expect(session.isKnownConnection('10.0.0.1')).toBe(true);
    });

    it('cleanupStaleSessions does not kill session with re-added connection', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past staleness threshold
      vi.advanceTimersByTime(121_000);

      // First cleanup pass: marks as stale, removes connection
      manager.cleanupStaleSessions();

      // Simulate the fix: client requests a segment, connection is re-added
      session.addConnection('10.0.0.1', { ip: '10.0.0.1' });
      session.recordHeartbeat('10.0.0.1');

      // Grace period elapses (15s default)
      vi.advanceTimersByTime(16_000);

      // Session should still be in the manager — cleanup was aborted
      // because #connections is non-empty when the timer fires
      expect(manager.getHlsSession(channelUuid)).toBe(session);
    });
  });

  describe('degradations (#68)', () => {
    it('a concat session reports the degradations of the session it reads from', async () => {
      class StubConcatSession extends ConcatSession {
        protected override async startInternal() {
          this.state = 'started';
        }

        protected override async stopInternal() {
          this.state = 'stopped';
        }
      }

      const hlsSessions: StubHlsSession[] = [];
      const manager = makeSessionManager(
        (channel, options) => {
          const session = new StubHlsSession(channel, options);
          hlsSessions.push(session);
          return session;
        },
        (channel, options) => new StubConcatSession(channel, options, vi.fn()),
      );

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const concat = (
        await manager.getOrCreateConcatSession(
          channelUuid,
          'token-b',
          connection,
          { sessionType: 'hls_concat', audioOnly: false },
        )
      ).get();
      expect(concat.degradations()).toEqual([]);

      const degradation: StreamDegradation = {
        code: 'crt_hdr_bypassed',
        message: 'hdr',
        firstSeen: 1,
      };
      (
        hlsSessions[0] as unknown as {
          setDegradations(next: StreamDegradation[]): void;
        }
      ).setDegradations([degradation]);

      // Read live, so the concat session follows each new item.
      expect(concat.degradations()).toEqual([degradation]);
    });

    it('a plain MPEG-TS concat session keeps its aggregate unknown', async () => {
      class StubConcatSession extends ConcatSession {
        protected override async startInternal() {
          this.state = 'started';
        }

        protected override async stopInternal() {
          this.state = 'stopped';
        }
      }

      const manager = makeSessionManager(
        (channel, options) => new StubHlsSession(channel, options),
        (channel, options) => new StubConcatSession(channel, options, vi.fn()),
      );

      // Per-request reports are separate; an aggregate must not claim all-clear.
      const concat = (
        await manager.getOrCreateConcatSession(
          channelUuid,
          'token-a',
          connection,
          { sessionType: 'mpegts_concat', audioOnly: false },
        )
      ).get();
      expect(concat.degradations()).toBeUndefined();
    });
  });
});

describe('request report ownership (#103)', () => {
  const details = {
    connection,
    programBeginMs: 123,
    programId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  };
  const reason: StreamDegradation = {
    code: 'subtitle_passthrough_unsupported',
    message: 'selected image subtitle',
    firstSeen: 10,
  };
  class StubConcat extends ConcatSession {
    protected override async startInternal() {
      this.state = 'started';
    }
    protected override async stopInternal() {
      this.state = 'stopped';
    }
  }
  function manager() {
    return makeSessionManager(
      (channel, options) => new StubHlsSession(channel, options),
      (channel, options) => new StubConcat(channel, options, vi.fn()),
    );
  }

  it('serializes overlapping same-IP requests separately and removes only the completed request', () => {
    const sessions = manager();
    const a = sessions.registerRequestReport(
      makeChannel(),
      'hls_direct',
      undefined,
      details,
    );
    const b = sessions.registerRequestReport(
      makeChannel(),
      'hls_direct',
      undefined,
      { ...details, programBeginMs: 456 },
    );
    if (!a || !b) throw new Error('Expected request owners');
    a.update([reason]);
    b.update([]);
    const [owner] = sessions.getAllSessionsForChannel(channelUuid, true);
    if (!owner) throw new Error('Expected report session');
    const response = ChannelSessionsResponseSchema.parse(
      sessionToApiSession(owner),
    );
    expect(response.degradations).toBeUndefined();
    expect(response.requests).toEqual([
      expect.objectContaining({
        requestId: a.requestId,
        programBeginMs: 123,
        degradations: [reason],
      }),
      expect.objectContaining({
        requestId: b.requestId,
        programBeginMs: 456,
        degradations: [],
      }),
    ]);
    expect(a.requestId).not.toBe(b.requestId);
    // Report-only sessions must not become on-demand viewers or stream producers.
    expect(sessions.getAllSessionsForChannel(channelUuid)).toEqual([]);
    expect(sessions.allSessions()).toEqual({});
    expect(sessions.getSession(channelUuid, 'hls_direct')).toBeUndefined();
    a.close();
    a.update([reason]);
    expect(owner.requestReports()).toEqual([
      expect.objectContaining({ requestId: b.requestId, degradations: [] }),
    ]);
    b.close();
    expect(sessions.allSessions(true)).toEqual({});
    const c = sessions.registerRequestReport(
      makeChannel(),
      'hls_direct',
      undefined,
      details,
    );
    a.close();
    b.close();
    expect(sessions.getAllSessionsForChannel(channelUuid, true)).toHaveLength(
      1,
    );
    c?.close();
    expect(sessions.allSessions(true)).toEqual({});
  });

  it.each(['mpegts', 'hls_direct'] as const)(
    'attaches %s only to its exact parent and rejects delayed requests after replacement',
    async (mode) => {
      const sessions = manager();
      const parent = (
        await sessions.getOrCreateConcatSession(
          channelUuid,
          'viewer',
          connection,
          {
            sessionType: `${mode}_concat`,
            audioOnly: false,
          },
        )
      ).get();
      const a = sessions.registerRequestReport(
        makeChannel(),
        mode,
        parent.instanceId,
        details,
      );
      const b = sessions.registerRequestReport(
        makeChannel(),
        mode,
        parent.instanceId,
        details,
      );
      if (!a || !b) throw new Error('Expected parent-owned reports');
      a.update([reason]);
      b.update([]);
      expect(parent.numConnections()).toBe(1);
      expect(parent.requestReports()).toHaveLength(2);
      expect(
        sessions.registerRequestReport(
          makeChannel(),
          mode,
          'wrong-instance',
          details,
        ),
      ).toBeUndefined();
      await parent.stop();
      expect(parent.requestReports()).toEqual([]);
      const replacement = (
        await sessions.getOrCreateConcatSession(
          channelUuid,
          'viewer2',
          connection,
          {
            sessionType: `${mode}_concat`,
            audioOnly: false,
          },
        )
      ).get();
      const current = sessions.registerRequestReport(
        makeChannel(),
        mode,
        replacement.instanceId,
        details,
      );
      current?.update([]);
      a.update([reason]);
      a.close();
      b.close();
      expect(
        sessions.registerRequestReport(
          makeChannel(),
          mode,
          parent.instanceId,
          details,
        ),
      ).toBeUndefined();
      expect(replacement.requestReports()).toEqual([
        expect.objectContaining({
          requestId: current?.requestId,
          degradations: [],
        }),
      ]);
      current?.close();
      expect(replacement.requestReports()).toEqual([]);
    },
  );

  // The route behind GET /channels/:id/sessions reads this. Concat sessions are
  // keyed `${mode}_concat`, so a list that named three of them by hand reported
  // neither MPEG-TS nor the two newest modes.
  describe('getAllConcatSessions', () => {
    const putSession = (
      manager: SessionManager,
      sessionType: SessionConcatStreamMode,
    ) => {
      const session = { sessionType };
      (
        manager as unknown as {
          addSession: (id: string, t: string, s: unknown) => void;
        }
      ).addSession(channelUuid, sessionType, session);
      return session;
    };

    it('reports a concat session for every concat mode', () => {
      const manager = makeSessionManager(
        (channel, options) => new StubHlsSession(channel, options),
      );

      const sessions = SessionConcatStreamModes.map((mode) =>
        putSession(manager, mode),
      );

      expect(manager.getAllConcatSessions(channelUuid)).toEqual(
        expect.arrayContaining(sessions),
      );
      expect(manager.getAllConcatSessions(channelUuid)).toHaveLength(
        SessionConcatStreamModes.length,
      );
    });

    it('reports an etv_next_concat session', () => {
      const manager = makeSessionManager(
        (channel, options) => new StubHlsSession(channel, options),
      );

      const session = putSession(manager, 'etv_next_concat');

      expect(manager.getAllConcatSessions(channelUuid)).toEqual([session]);
    });

    it('ignores a non-concat session on the same channel', () => {
      const manager = makeSessionManager(
        (channel, options) => new StubHlsSession(channel, options),
      );

      (
        manager as unknown as {
          addSession: (id: string, t: string, s: unknown) => void;
        }
      ).addSession(channelUuid, 'etv_next', { sessionType: 'etv_next' });

      expect(manager.getAllConcatSessions(channelUuid)).toEqual([]);
    });
  });
});

import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import type { StreamDegradation } from '@tunarr/types';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ProgramStream } from './ProgramStream.ts';
import { RequestSession } from './RequestSession.ts';
import { observeRequestTranscodes } from './StreamRequestReport.ts';

const reason: StreamDegradation = {
  code: 'subtitle_passthrough_unsupported',
  message: 'image subtitle',
  firstSeen: 42,
};

function transcode(degradations: StreamDegradation[]) {
  return Object.assign(new EventEmitter(), {
    degradations,
  }) as unknown as FfmpegTranscodeSession;
}

function fixture(signal?: AbortSignal) {
  const owner = new RequestSession(
    {
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    } as ChannelOrmWithTranscodeConfig,
    'hls_direct',
  );
  const program = new EventEmitter() as ProgramStream;
  const output = new PassThrough();
  const report = owner.addRequestReport({
    connection: { ip: '127.0.0.1' },
    programBeginMs: 0,
  });
  const close = observeRequestTranscodes(program, output, report, signal);
  return { owner, program, output, close };
}

describe('per-request transcode handoff', () => {
  it('reports setup decisions, clears ended transcodes, and follows an error-stream replacement', () => {
    const { owner, program, close } = fixture();
    const first = transcode([reason]);
    expect(owner.requestReports()[0]?.degradations).toBeUndefined();
    program.emit('transcode', first);
    expect(owner.requestReports()[0]?.degradations).toEqual([reason]);
    first.emit('error');
    expect(owner.requestReports()[0]?.degradations).toBeUndefined();
    const replacement = transcode([]);
    program.emit('transcode', replacement);
    first.emit('exit', 0, null);
    expect(owner.requestReports()[0]?.degradations).toEqual([]);
    replacement.emit('end');
    expect(owner.requestReports()[0]?.degradations).toBeUndefined();
    close();
    expect(owner.requestReports()).toEqual([]);
    expect(first.listenerCount('exit')).toBe(0);
    expect(replacement.listenerCount('end')).toBe(0);
  });

  it.each(['end', 'close', 'error'] as const)(
    'removes the request and listeners on output %s',
    (event) => {
      const { owner, program, output, close } = fixture();
      const current = transcode([reason]);
      program.emit('transcode', current);
      output.emit(event);
      close();
      expect(owner.requestReports()).toEqual([]);
      expect(program.listenerCount('transcode')).toBe(0);
      expect(current.eventNames()).toEqual([]);
      expect(output.listenerCount('end')).toBe(0);
      expect(output.listenerCount('close')).toBe(0);
    },
  );

  it.each([false, true])(
    'handles a disconnected startup (already aborted: %s)',
    (alreadyAborted) => {
      const abort = new AbortController();
      if (alreadyAborted) abort.abort();
      const { owner, program } = fixture(abort.signal);
      abort.abort();
      program.emit('transcode', transcode([reason]));
      expect(owner.requestReports()).toEqual([]);
      expect(program.listenerCount('transcode')).toBe(0);
    },
  );
});

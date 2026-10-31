import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { evaluateSubtitleExtractionShadow } from './SubtitleExtractionShadow.ts';
import { SubtitleExtractionProcess } from './SubtitleExtractionProcess.ts';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

describe('subtitle extraction input-progress watchdog (#82)', () => {
  let child: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as never);
  });
  afterEach(() => {
    child.stdout.destroy();
    child.stderr.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows more than 500 seconds of advancing media with no subtitle output', async () => {
    const result = new SubtitleExtractionProcess().run('ffmpeg', []);
    for (let frame = 1; frame <= 12; frame++) {
      await vi.advanceTimersByTimeAsync(50_000);
      child.stdout.write(`total_size=${frame * 1000}\nprogress=continue\n`);
    }
    child.stderr.write(
      '[AVIOContext] Statistics: 2000000000 bytes read, 0 seeks\n',
    );
    child.emit('close', 0, null);
    const completed = await result;
    expect(completed).toEqual({
      elapsedSeconds: 600,
      bytesRead: 2e9,
      secondsPerGB: 300,
      longestProgressPauseSeconds: 50,
    });
    expect(
      evaluateSubtitleExtractionShadow(
        Array.from({ length: 20 }, () => ({
          ...completed,
          elapsedSeconds: 2,
          secondsPerGB: 1,
        })),
        completed,
      ).decision,
    ).toBe('would_have_stopped');
    expect(child.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('kills a stalled read after 60 seconds despite repeated progress messages and changing subtitle timestamps', async () => {
    const result = new SubtitleExtractionProcess().run('ffmpeg', []);
    const rejection = expect(result).rejects.toThrow('no media input progress');
    child.stdout.write('total_size=1000\n');
    await vi.advanceTimersByTimeAsync(59_000);
    child.stdout.write(
      'total_size=1000\nout_time_us=900000000\nprogress=continue\n',
    );
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops an input that never produces its first media packet', async () => {
    const result = new SubtitleExtractionProcess().run('ffmpeg', []);
    const rejection = expect(result).rejects.toThrow('60 seconds');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 0, null);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not return a successful sample for a failed process', async () => {
    const result = new SubtitleExtractionProcess().run('ffmpeg', []);
    const rejection = expect(result).rejects.toThrow('exited 1');
    child.stderr.write('Statistics: 1000000 bytes read, 0 seeks\n');
    child.emit('close', 1, null);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});

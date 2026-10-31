import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import { once } from 'lodash-es';
import type { Readable } from 'node:stream';
import type { ProgramStream } from './ProgramStream.ts';
import type { Session } from './Session.ts';

/** Observe the current transcode without starting, stopping, or retrying it. */
export function observeRequestTranscodes(
  program: ProgramStream,
  output: Readable,
  report: ReturnType<Session['addRequestReport']>,
  signal?: AbortSignal,
) {
  let closed = false;
  let currentTranscode: FfmpegTranscodeSession | undefined;
  let detachTranscode: (() => void) | undefined;
  const attachTranscode = (transcode: FfmpegTranscodeSession) => {
    if (closed) return;
    detachTranscode?.();
    currentTranscode = transcode;
    report.update(transcode.degradations);
    const ended = () => {
      if (currentTranscode !== transcode || closed) return;
      report.update(undefined);
      detachTranscode?.();
    };
    detachTranscode = () => {
      transcode.off('end', ended);
      transcode.off('exit', ended);
      transcode.off('error', ended);
    };
    transcode.on('end', ended);
    transcode.on('exit', ended);
    transcode.on('error', ended);
  };
  const close = once(() => {
    closed = true;
    signal?.removeEventListener('abort', close);
    program.off('transcode', attachTranscode);
    detachTranscode?.();
    output.off('end', close);
    output.off('close', close);
    output.off('error', close);
    report.close();
  });
  program.on('transcode', attachTranscode);
  if (program.transcodeSession) {
    attachTranscode(program.transcodeSession);
  }
  output.on('end', close);
  output.on('close', close);
  output.on('error', close);
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  return close;
}

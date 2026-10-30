import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import type { StreamDegradation } from '@tunarr/types';
import type { ChannelConcatStreamMode } from '@tunarr/types/schemas';
import { isEmpty } from 'lodash-es';
import type { ConcatStreamFactory } from './ConcatStream.ts';
import { DirectStreamSession } from './DirectStreamSession.js';
import type { SessionOptions } from './Session.js';

export type ConcatSessionOptions = SessionOptions & {
  sessionType: ChannelConcatStreamMode;
  audioOnly: boolean;
  // A concat session only remuxes; the session it reads from does the
  // transcoding, so it reports that session's degradations.
  underlyingDegradations?: () => StreamDegradation[];
};

export type ConcatSessionFactory = (
  channel: ChannelOrmWithTranscodeConfig,
  options: ConcatSessionOptions,
) => ConcatSession;

export class ConcatSession extends DirectStreamSession<ConcatSessionOptions> {
  #transcodeSession?: FfmpegTranscodeSession;

  constructor(
    channel: ChannelOrmWithTranscodeConfig,
    options: ConcatSessionOptions,
    private concatStreamFactory: ConcatStreamFactory,
  ) {
    super(channel, options);
    this.on('removeConnection', () => {
      if (isEmpty(this.connections())) {
        this.scheduleCleanup();
      }
    });
  }

  isStale(): boolean {
    return isEmpty(this.connections());
  }

  get sessionType() {
    return this.sessionOptions.sessionType;
  }

  override degradations(): StreamDegradation[] {
    return this.sessionOptions.underlyingDegradations?.() ?? [];
  }

  protected async initializeStream(): Promise<FfmpegTranscodeSession> {
    this.#transcodeSession = await this.concatStreamFactory(
      this.channel,
      this.sessionOptions.sessionType,
    ).createSession();

    this.#transcodeSession.on('error', (e) => this.emit('error', e));
    this.#transcodeSession.on('exit', () => this.emit('end'));

    return Promise.resolve(this.#transcodeSession);
  }

  protected stopStream(): Promise<void> {
    this.#transcodeSession?.kill();
    return Promise.resolve(void 0);
  }
}

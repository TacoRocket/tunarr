import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import { Session } from './Session.ts';

/** Active request reports, not a playback producer or a viewer identity. */
export class RequestSession extends Session {
  override readonly reportingOnly = true;

  constructor(
    channel: ChannelOrmWithTranscodeConfig,
    public readonly sessionType: 'mpegts' | 'hls_direct',
  ) {
    super(channel, {});
    this.state = 'started';
  }

  override get key() {
    return `${this.channel.uuid}_requests_${this.sessionType}` as const;
  }

  override degradations() {
    return undefined;
  }

  override requestReports() {
    return this.activeRequestReports();
  }

  // HTTP request completion owns cleanup, not HLS heartbeat expiry.
  override isStale() {
    return false;
  }

  protected startInternal() {
    return Promise.resolve();
  }

  protected stopInternal() {
    return Promise.resolve();
  }
}

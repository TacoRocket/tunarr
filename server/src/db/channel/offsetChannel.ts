import { ChannelCrtSettingsSchema } from '@tunarr/types/schemas';
import { isEqual } from 'lodash-es';
import type {
  ChannelCrtSettings,
  ChannelCreditSqueezeSettings,
  ChannelOffsetPicture,
} from '@tunarr/types/schemas';

// An offset channel plays its source channel's lineup a whole number of hours
// later, like an East/West Coast feed. It is stored as an ordinary channel
// that Tunarr overwrites from its source whenever the source changes, so
// playback and the guide read it like any other channel.

const HourMs = 60 * 60 * 1000;

/**
 * The offset channel's start time: the source's, plus the offset. A channel
 * loops its lineup, so moving the start by whole loops changes nothing that
 * plays. Moving it back to the past keeps a recently rebased source from
 * leaving its offset channel off the air until the shifted start arrives.
 */
export function offsetStartTime(
  sourceStartTime: number,
  offsetHours: number,
  durationMs: number,
  now: number,
): number {
  const start = sourceStartTime + offsetHours * HourMs;
  if (start <= now || durationMs <= 0) {
    return start;
  }
  return start - Math.ceil((start - now) / durationMs) * durationMs;
}

export function offsetChannelCrt(
  sourceCrt: ChannelCrtSettings | null,
  picture: ChannelOffsetPicture | null | undefined,
): ChannelCrtSettings | null {
  switch (picture?.mode) {
    case 'off':
      return null;
    case 'custom':
      return picture.crt;
    default:
      return sourceCrt;
  }
}

export function mirrorCrtUpdateError(
  channel: {
    uuid: string;
    offsetSourceChannelId: string | null;
    crt: ChannelCrtSettings | null;
  },
  requestedCrt: ChannelCrtSettings | null | undefined,
): string | undefined {
  if (!channel.offsetSourceChannelId || requestedCrt === undefined) return;

  // GET applies CRT defaults to older rows; accept that normalized echo too.
  const current =
    channel.crt === null ? null : ChannelCrtSettingsSchema.parse(channel.crt);
  const requested =
    requestedCrt === null ? null : ChannelCrtSettingsSchema.parse(requestedCrt);
  if (isEqual(current, requested)) return;

  return `This channel mirrors ${channel.offsetSourceChannelId}; change its picture with PUT /api/channels/${channel.uuid}/offset.`;
}

export function mirrorCreditSqueezeUpdateError(
  channel: {
    offsetSourceChannelId: string | null;
    creditSqueeze: ChannelCreditSqueezeSettings | null;
  },
  requested: ChannelCreditSqueezeSettings | null | undefined,
): string | undefined {
  if (!channel.offsetSourceChannelId || requested === undefined) return;
  if (isEqual(channel.creditSqueeze, requested)) return;
  return `This channel mirrors ${channel.offsetSourceChannelId}; change credit squeeze on its source channel.`;
}

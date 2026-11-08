import {
  getApiEtvTranscodeConfigsByIdCompatibilityOptions,
  getApiTranscodeConfigsByIdOptions,
} from '@/generated/@tanstack/react-query.gen.ts';
import { channelQuery } from '@/hooks/useChannels.ts';
import { useQuery } from '@tanstack/react-query';

/**
 * Whether this channel's saved transcode profile can play generated
 * programming, which always runs on ErsatzTV next.
 *
 * Reads the channel from its query rather than the channel editor: saving
 * Edit Channel refreshes the query but not the editor's copy, so a profile the
 * user just fixed would otherwise still read as incompatible.
 */
export function useSeedChannelPlayback(channelId: string | undefined) {
  const { data: channel } = useQuery(
    channelQuery(channelId ?? '', channelId !== undefined),
  );
  const profileId = channel?.transcodeConfigId;
  const compatibility = useQuery({
    ...getApiEtvTranscodeConfigsByIdCompatibilityOptions({
      path: { id: profileId ?? '' },
    }),
    enabled: profileId !== undefined,
  });
  const unsupported = compatibility.data?.unsupported ?? [];
  const profile = useQuery({
    ...getApiTranscodeConfigsByIdOptions({ path: { id: profileId ?? '' } }),
    enabled: profileId !== undefined && unsupported.length > 0,
  });
  return {
    blocked: unsupported.length > 0,
    unsupported,
    profileName: profile.data?.name,
  };
}

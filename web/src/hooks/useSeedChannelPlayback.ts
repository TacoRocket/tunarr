import { isNextPlayable } from '@/components/settings/ffmpeg/nextTranscodeSupport.ts';
import {
  getApiEtvTranscodeConfigsByIdCompatibilityOptions,
  getApiTranscodeConfigsOptions,
} from '@/generated/@tanstack/react-query.gen.ts';
import { channelQuery } from '@/hooks/useChannels.ts';
import { useQuery } from '@tanstack/react-query';

/**
 * SIGNPOST(native-retirement): remove with SeedChannelPlaybackNotice.
 *
 * Whether this channel's saved transcode profile can play generated
 * programming, which always runs on ErsatzTV next, and which of the other
 * profiles could.
 *
 * Reads the channel from its query rather than the channel editor: saving the
 * channel refreshes the query but not the editor's copy, so a profile the user
 * just switched would otherwise still read as incompatible.
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
  const blocked = unsupported.length > 0;
  const profiles = useQuery({
    ...getApiTranscodeConfigsOptions(),
    enabled: blocked,
  });
  const compatibleProfiles = (profiles.data ?? []).filter(isNextPlayable);
  return {
    channel,
    blocked,
    unsupported,
    profileName: profiles.data?.find((profile) => profile.id === profileId)
      ?.name,
    profilesLoaded: profiles.isSuccess,
    compatibleProfiles,
  };
}

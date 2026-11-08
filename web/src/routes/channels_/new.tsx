import { DefaultChannel } from '@/helpers/constants';
import { NewChannelPage } from '@/pages/channels/NewChannelPage';
import { safeSetCurrentChannel } from '@/store/channelEditor/actions';
import { createFileRoute } from '@tanstack/react-router';
import type { Channel } from '@tunarr/types';
import dayjs from 'dayjs';
import { find, first, maxBy } from 'lodash-es';
import { v4 } from 'uuid';
import { z } from 'zod/v4';
import {
  getApiTranscodeConfigsOptions,
  getChannelsOptions,
} from '../../generated/@tanstack/react-query.gen.ts';

function defaultNewChannel(num: number, transcodeConfigId: string): Channel {
  return {
    ...DefaultChannel,
    id: v4(),
    name: `Channel ${num}`,
    number: num,
    startTime: +dayjs().startOf('minute'),
    transcodeConfigId,
  };
}

// TODO: Share this schema between new and edit routes
const editChannelParamsSchema = z.object({
  tab: z
    .union([z.literal('flex'), z.literal('epg'), z.literal('ffmpeg')])
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute('/channels_/new')({
  validateSearch: (search) => editChannelParamsSchema.parse(search),
  loader: async ({ context }) => {
    const transcodeConfigs = await context.queryClient.fetchQuery(
      getApiTranscodeConfigsOptions({ query: { backend: 'etv_next' } }),
    );

    const initialProfile =
      find(transcodeConfigs, (profile) => profile.isDefault) ??
      first(transcodeConfigs);
    if (!initialProfile) return { channel: null, transcodeConfigs };

    const channels =
      await context.queryClient.ensureQueryData(getChannelsOptions());
    const newChannel = defaultNewChannel(
      (maxBy(channels, (c) => c.number)?.number ?? 0) + 1,
      initialProfile.id,
    );

    safeSetCurrentChannel(newChannel);

    return { channel: newChannel, transcodeConfigs };
  },
  component: () => <NewChannelPage />,
});

import { preloadChannelAndProgramming } from '@/helpers/routeLoaders';
import ChannelProgrammingPage from '@/pages/channels/ChannelProgrammingPage';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod/v4';

export const Route = createFileRoute('/channels_/$channelId/programming/')({
  validateSearch: z.object({
    dialog: z.literal('auto-generation').optional().catch(undefined),
  }),
  loader: preloadChannelAndProgramming,
  component: () => <ChannelProgrammingPage />,
});

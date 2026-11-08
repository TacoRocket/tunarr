import { RouterLink } from '@/components/base/RouterLink.tsx';
import type { EditChannelTabs } from '@/components/channel_config/EditChannelTabPanel.tsx';
import { ChannelOptionsButton } from '@/components/channels/ChannelOptionsButton.tsx';
import { useChannelSuspense } from '@/hooks/useChannels.ts';
import { Route } from '@/routes/channels_/$channelId/edit/index.tsx';
import { Trans, useLingui } from '@lingui/react/macro';
import { Box, Stack } from '@mui/material';
import Typography from '@mui/material/Typography';
import Breadcrumbs from '../../components/Breadcrumbs.tsx';
import { EditChannelForm } from '../../components/channel_config/EditChannelForm.tsx';

type Props = {
  initialTab?: EditChannelTabs;
};

export default function EditChannelPage({ initialTab }: Props) {
  const { channelId } = Route.useParams();
  const { t } = useLingui();
  const {
    data: { seedGrowth, ...channel },
  } = useChannelSuspense(channelId);
  const rolling = seedGrowth?.rolling;

  return (
    <>
      <Breadcrumbs />
      <Box>
        <Stack direction="row">
          <Typography variant="h4" sx={{ mb: 2, flex: 1 }}>
            {channel.name}
          </Typography>
          <Box>
            <ChannelOptionsButton
              channel={channel}
              hideItems={['edit', 'duplicate', 'delete']}
            />
          </Box>
        </Stack>
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle1">
            {rolling
              ? t`Auto-generation: Rolling guide`
              : seedGrowth
                ? t`Auto-generation: Grow when watched`
                : seedGrowth === null
                  ? t`Auto-generation: Off`
                  : t`Auto-generation settings unavailable`}
          </Typography>
          {rolling ? (
            <Typography variant="body2" color="text.secondary">
              <Trans>
                Minimum ahead {rolling.minimumHours} h · Extension limit{' '}
                {rolling.maximumHours} h · Movie trigger {rolling.moviePercent}%
                · Shortlist {rolling.candidateCount}
              </Trans>
            </Typography>
          ) : seedGrowth ? (
            <Typography variant="body2" color="text.secondary">
              <Trans>Target ahead {seedGrowth.targetHours} h</Trans>
            </Typography>
          ) : null}
          {seedGrowth && (
            <RouterLink
              to="/channels/$channelId/programming"
              params={{ channelId }}
              search={{ dialog: 'auto-generation' }}
            >
              <Trans>Edit generation settings</Trans>
            </RouterLink>
          )}
        </Box>
        <EditChannelForm
          channel={channel}
          isNew={false}
          initialTab={initialTab}
        />
      </Box>
    </>
  );
}

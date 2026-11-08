import { RouterLink } from '@/components/base/RouterLink.tsx';
import { EditChannelForm } from '@/components/channel_config/EditChannelForm';
import { Route } from '@/routes/channels_/new';
import { Trans } from '@lingui/react/macro';
import { Typography } from '@mui/material';
import Breadcrumbs from '@mui/material/Breadcrumbs';

export function NewChannelPage() {
  const { channel, transcodeConfigs } = Route.useLoaderData();

  return (
    <>
      <Breadcrumbs />
      <Typography variant="h4" sx={{ mb: 2 }}>
        <Trans>New Channel</Trans>
      </Typography>
      {channel ? (
        <EditChannelForm
          channel={channel}
          isNew
          transcodeConfigs={transcodeConfigs}
        />
      ) : (
        <RouterLink to="/profiles/transcode/new">
          <Trans>
            Create a Next-compatible transcode profile to add a channel.
          </Trans>
        </RouterLink>
      )}
    </>
  );
}

import { getApiAdminOptions } from '@/generated/@tanstack/react-query.gen.ts';
import { postApiAdminLogout } from '@/generated/sdk.gen.ts';
import { extensionErrorMessage } from '@/hooks/useExtensionStore.ts';
import { useSettings } from '@/store/settings/selectors.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import { Alert, Button } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

export function ExtensionAdminAccess() {
  const { t } = useLingui();
  const { backendUri } = useSettings();
  const adminPage = backendUri + '/admin?next=/web/settings/extensions';
  const { data, isError, refetch } = useQuery(getApiAdminOptions());
  const [error, setError] = useState('');

  if (isError) {
    return (
      <Alert
        severity="error"
        action={
          <Button onClick={() => void refetch()}>
            <Trans>Retry</Trans>
          </Button>
        }
      >
        <Trans>Could not check administrator access.</Trans>
      </Alert>
    );
  }
  if (data?.mode === 'setup') {
    return (
      <Alert
        severity="info"
        sx={{ mb: 2 }}
        action={
          <Button href={adminPage} color="inherit">
            <Trans>Set up administrator access</Trans>
          </Button>
        }
      >
        {data.trustedLan ? (
          <Trans>
            Trusted LAN access is enabled. Anyone who can reach Tunarr can
            manage extensions. Set a server login to require sign-in.
          </Trans>
        ) : (
          <Trans>
            Set a server login to manage extensions. Your TV can keep using its
            playlists and streams.
          </Trans>
        )}
      </Alert>
    );
  }
  if (!data?.signedIn) return null;
  return (
    <>
      <Button
        sx={{ mb: 2 }}
        onClick={() => {
          void postApiAdminLogout({ body: {}, throwOnError: true })
            .then(() => window.location.replace(adminPage))
            .catch((e: unknown) =>
              setError(extensionErrorMessage(e, t`Could not sign out.`)),
            );
        }}
      >
        <Trans>Sign out</Trans>
      </Button>
      {error && <Alert severity="error">{error}</Alert>}
    </>
  );
}

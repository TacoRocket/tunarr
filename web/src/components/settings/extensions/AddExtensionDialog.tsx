import { EmptyState } from '@/components/ui/EmptyState.tsx';
import { MonoText } from '@/components/ui/MonoText.tsx';
import { postApiExtensionsInstallMutation } from '@/generated/@tanstack/react-query.gen.ts';
import {
  extensionErrorMessage,
  useRefreshExtensionStore,
  type ExtensionListing,
  type ExtensionSource,
  type ExtensionStoreState,
} from '@/hooks/useExtensionStore.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import { ExtensionOutlined, Search } from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputAdornment,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

type Props = {
  open: boolean;
  store: ExtensionStoreState;
  onClose: () => void;
  onInstalled: (key: string) => void;
  onManageSources: () => void;
};

export function AddExtensionDialog({
  open,
  store,
  onClose,
  onInstalled,
  onManageSources,
}: Props) {
  const { t } = useLingui();
  const refresh = useRefreshExtensionStore();
  const install = useMutation(postApiExtensionsInstallMutation());
  const [query, setQuery] = useState('');
  const [installing, setInstalling] = useState<string>();
  const [error, setError] = useState<string>();

  const installed = new Set(
    store.installed.map(
      (extension) => `${extension.repository.toLowerCase()}:${extension.id}`,
    ),
  );
  const enabledSources = store.sources.filter((source) => source.enabled);
  const needle = query.trim().toLowerCase();
  const listings = enabledSources.flatMap((source) =>
    source.entries
      .filter(
        (entry) =>
          !needle ||
          entry.name.toLowerCase().includes(needle) ||
          entry.description.toLowerCase().includes(needle) ||
          entry.repository.toLowerCase().includes(needle),
      )
      .map((entry) => ({ source, entry })),
  );
  const failedSources = enabledSources.filter((source) => source.error);

  const runInstall = async (
    source: ExtensionSource,
    entry: ExtensionListing,
  ) => {
    const id = `${source.url}:${entry.repository}:${entry.id}`;
    setInstalling(id);
    setError(undefined);
    try {
      const { key } = await install.mutateAsync({
        body: {
          source: source.url,
          id: entry.id,
          repository: entry.repository,
          commit: entry.commit,
        },
      });
      await refresh();
      onInstalled(key);
    } catch (e) {
      setError(extensionErrorMessage(e, t`Could not install ${entry.name}.`));
    } finally {
      setInstalling(undefined);
    }
  };

  const close = () => {
    setQuery('');
    setError(undefined);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="md">
      <DialogTitle>
        <Trans>Add extension</Trans>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            <Trans>
              Extensions come from their publishers, not from Tunarr. Check who
              publishes one before you install it. Each runs in a sandbox and
              can only reach the services you configure for it.
            </Trans>
          </Typography>
          {!store.canManage && (
            <Alert severity="info">
              <Trans>
                You can browse, but installing needs a Tunarr login or trusted
                LAN access.
              </Trans>
            </Alert>
          )}
          {error && (
            <Alert severity="error" onClose={() => setError(undefined)}>
              {error}
            </Alert>
          )}
          {failedSources.map((source) => (
            <Alert severity="warning" key={source.url}>
              <Trans>
                Could not load {source.name}: {source.error}
              </Trans>
            </Alert>
          ))}
          <TextField
            size="small"
            placeholder={t`Search extensions`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <Search fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />
          {listings.length === 0 ? (
            <EmptyState
              icon={<ExtensionOutlined />}
              title={
                enabledSources.length === 0 ? (
                  <Trans>No sources are enabled</Trans>
                ) : needle ? (
                  <Trans>No extensions match “{query}”</Trans>
                ) : (
                  <Trans>Your sources list no extensions</Trans>
                )
              }
              description={
                enabledSources.length === 0 ? (
                  <Trans>Enable or add a source to see its extensions.</Trans>
                ) : undefined
              }
              actions={
                enabledSources.length === 0 && store.canManage ? (
                  <Button variant="outlined" onClick={onManageSources}>
                    <Trans>Manage sources</Trans>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Box
              sx={{
                display: 'grid',
                gap: 1.5,
                gridTemplateColumns: {
                  xs: '1fr',
                  sm: 'repeat(2, minmax(0, 1fr))',
                },
              }}
            >
              {listings.map(({ source, entry }) => {
                const id = `${source.url}:${entry.repository}:${entry.id}`;
                const isInstalled = installed.has(
                  `${entry.repository.toLowerCase()}:${entry.id}`,
                );
                return (
                  <Card key={id}>
                    <CardContent>
                      <Stack spacing={1} sx={{ height: '100%' }}>
                        <Typography variant="subtitle1" fontWeight={600}>
                          {entry.name}
                        </Typography>
                        <Typography
                          variant="body2"
                          color="text.secondary"
                          sx={{ flex: 1 }}
                        >
                          {entry.description}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          <Trans>
                            By{' '}
                            <Link
                              href={`https://github.com/${entry.repository}/tree/${entry.commit}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <MonoText fontSize="inherit">
                                {entry.repository}
                              </MonoText>
                            </Link>{' '}
                            · version {entry.version} · from {source.name}
                          </Trans>
                        </Typography>
                        <Box>
                          <Button
                            variant="contained"
                            size="small"
                            disabled={
                              !store.canManage ||
                              isInstalled ||
                              installing !== undefined
                            }
                            onClick={() => void runInstall(source, entry)}
                            startIcon={
                              installing === id ? (
                                <CircularProgress size={14} color="inherit" />
                              ) : undefined
                            }
                          >
                            {isInstalled ? (
                              <Trans>Installed</Trans>
                            ) : installing === id ? (
                              <Trans>Installing…</Trans>
                            ) : (
                              <Trans>Install</Trans>
                            )}
                          </Button>
                        </Box>
                      </Stack>
                    </CardContent>
                  </Card>
                );
              })}
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {store.canManage && (
          <Button onClick={onManageSources}>
            <Trans>Manage sources</Trans>
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={close}>
          <Trans>Close</Trans>
        </Button>
      </DialogActions>
    </Dialog>
  );
}

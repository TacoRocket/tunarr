import { StatusPill } from '@/components/ui/StatusPill.tsx';
import {
  postApiExtensionsSourcesMutation,
  postApiExtensionsSourcesRefreshMutation,
  putApiExtensionsSourcesMutation,
} from '@/generated/@tanstack/react-query.gen.ts';
import {
  extensionErrorMessage,
  useRefreshExtensionStore,
  type ExtensionStoreState,
} from '@/hooks/useExtensionStore.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import { Refresh } from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Link,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

type Props = {
  open: boolean;
  store: ExtensionStoreState;
  onClose: () => void;
};

export function ExtensionSourcesDialog({ open, store, onClose }: Props) {
  const { t } = useLingui();
  const refresh = useRefreshExtensionStore();
  const add = useMutation(postApiExtensionsSourcesMutation());
  const toggle = useMutation(putApiExtensionsSourcesMutation());
  const reload = useMutation(postApiExtensionsSourcesRefreshMutation());
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string>();
  const busy = add.isPending || toggle.isPending || reload.isPending;

  const run = async (change: () => Promise<unknown>, fallback: string) => {
    setError(undefined);
    try {
      await change();
      await refresh();
      return true;
    } catch (e) {
      setError(extensionErrorMessage(e, fallback));
      return false;
    }
  };

  const addSource = async () => {
    const ok = await run(
      () => add.mutateAsync({ body: { url: url.trim() } }),
      t`Could not add that source.`,
    );
    if (ok) setUrl('');
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        <Trans>Extension sources</Trans>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            <Trans>
              A source is a public GitHub repository that lists extensions.
              Turning one on only shows its listings; installing still needs
              your click.
            </Trans>
          </Typography>
          {error && (
            <Alert severity="error" onClose={() => setError(undefined)}>
              {error}
            </Alert>
          )}
          {store.sources.length === 0 && (
            <Typography variant="body2">
              <Trans>No sources yet.</Trans>
            </Typography>
          )}
          {store.sources.map((source) => (
            <Box key={source.url}>
              <Stack direction="row" alignItems="center" gap={1}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Link
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{ overflowWrap: 'anywhere' }}
                  >
                    {source.name}
                  </Link>
                  <Box sx={{ mt: 0.5 }}>
                    {!source.enabled ? (
                      <StatusPill status="idle" label={<Trans>Off</Trans>} />
                    ) : source.error ? (
                      <StatusPill
                        status="error"
                        label={<Trans>Could not load</Trans>}
                      />
                    ) : (
                      <StatusPill
                        status="live"
                        label={<Trans>{source.entries.length} listed</Trans>}
                      />
                    )}
                  </Box>
                  {source.enabled && source.error && (
                    <Typography variant="caption" color="error">
                      {source.error}
                    </Typography>
                  )}
                </Box>
                <Tooltip title={t`Reload listings`}>
                  <span>
                    <IconButton
                      aria-label={t`Reload ${source.name}`}
                      disabled={busy || !source.enabled}
                      onClick={() =>
                        void run(
                          () =>
                            reload.mutateAsync({ body: { url: source.url } }),
                          t`Could not reload that source.`,
                        )
                      }
                    >
                      <Refresh />
                    </IconButton>
                  </span>
                </Tooltip>
                <Switch
                  checked={source.enabled}
                  disabled={busy}
                  slotProps={{
                    input: { 'aria-label': t`Use ${source.name}` },
                  }}
                  onChange={(e) =>
                    void run(
                      () =>
                        toggle.mutateAsync({
                          body: { url: source.url, enabled: e.target.checked },
                        }),
                      t`Could not change that source.`,
                    )
                  }
                />
              </Stack>
            </Box>
          ))}
          <Divider />
          <Stack
            component="form"
            direction={{ xs: 'column', sm: 'row' }}
            gap={1}
            alignItems={{ sm: 'flex-start' }}
            onSubmit={(e) => {
              e.preventDefault();
              void addSource();
            }}
          >
            <TextField
              size="small"
              label={t`GitHub repository`}
              placeholder="https://github.com/owner/repository"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
              fullWidth
            />
            <Button
              type="submit"
              variant="outlined"
              disabled={busy || !url.trim()}
              sx={{ flex: 'none' }}
            >
              <Trans>Add source</Trans>
            </Button>
          </Stack>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>
          <Trans>Close</Trans>
        </Button>
      </DialogActions>
    </Dialog>
  );
}

import { getApiAdminOptions } from '@/generated/@tanstack/react-query.gen.ts';
import {
  postApiAdminLogin,
  postApiAdminLogout,
  postApiAdminMigrate,
  postApiAdminSetup,
  postApiAdminSetupCode,
} from '@/generated/sdk.gen.ts';
import {
  extensionErrorMessage,
  useRefreshExtensionStore,
} from '@/hooks/useExtensionStore.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

type FormMode = 'setup' | 'login' | 'migrate';

export function ExtensionAdminAccess() {
  const { t } = useLingui();
  const admin = useQuery(getApiAdminOptions());
  const refreshStore = useRefreshExtensionStore();
  const [form, setForm] = useState<FormMode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [migrated, setMigrated] = useState(false);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(
        extensionErrorMessage(e, t`The request could not be completed.`),
      );
    } finally {
      setBusy(false);
    }
  }

  function open(mode: FormMode) {
    void perform(async () => {
      if (mode === 'setup')
        await postApiAdminSetupCode({ body: {}, throwOnError: true });
      setForm(mode);
    });
  }

  async function refresh() {
    await Promise.all([admin.refetch(), refreshStore()]);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    function field(name: string) {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    }
    const body = { username: field('username'), password: field('password') };
    void perform(async () => {
      if (form === 'setup') {
        await postApiAdminSetup({
          body: { ...body, code: field('code').trim() },
          throwOnError: true,
        });
      } else if (form === 'migrate') {
        await postApiAdminMigrate({ body, throwOnError: true });
        setMigrated(true);
      } else {
        await postApiAdminLogin({ body, throwOnError: true });
      }
      setForm(undefined);
      await refresh();
    });
  }

  const state = admin.data;
  const mode =
    state?.mode === 'setup'
      ? 'setup'
      : state?.mode === 'environment'
        ? 'migrate'
        : state?.mode === 'extensions' && !state.signedIn && !state.trustedLan
          ? 'login'
          : undefined;
  const title = (value: FormMode) =>
    value === 'setup'
      ? t`Set up administrator access`
      : value === 'migrate'
        ? t`Move your login into Tunarr`
        : t`Administrator sign-in`;

  return (
    <>
      {mode && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button color="inherit" disabled={busy} onClick={() => open(mode)}>
              {title(mode)}
            </Button>
          }
        >
          {mode === 'migrate' ? (
            <Trans>
              You can save your existing server login in Tunarr’s data
              directory.
            </Trans>
          ) : state?.trustedLan ? (
            <Trans>
              Trusted LAN access is enabled. Anyone who can reach Tunarr can
              manage extensions.
            </Trans>
          ) : (
            <Trans>
              Administrator access lets you install, configure, and run
              extensions.
            </Trans>
          )}
        </Alert>
      )}
      {state?.signedIn && (
        <Button
          sx={{ mb: 2 }}
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              await postApiAdminLogout({ body: {}, throwOnError: true });
              await refresh();
            })
          }
        >
          <Trans>Sign out of administrator session</Trans>
        </Button>
      )}
      {migrated && (
        <Alert severity="success" sx={{ mb: 2 }}>
          <Trans>
            Your login is saved. You can remove both Basic Auth environment
            variables and restart Tunarr. The same login will still protect the
            server.
          </Trans>
        </Alert>
      )}
      {admin.isError && (
        <Alert
          severity="error"
          action={
            <Button onClick={() => void admin.refetch()}>
              <Trans>Retry</Trans>
            </Button>
          }
        >
          <Trans>Could not check administrator access.</Trans>
        </Alert>
      )}
      {!form && error && <Alert severity="error">{error}</Alert>}
      {form && (
        <Dialog
          open
          onClose={() => {
            if (!busy) {
              setError('');
              setForm(undefined);
            }
          }}
          maxWidth="xs"
          fullWidth
        >
          <form onSubmit={submit}>
            <DialogTitle>{title(form)}</DialogTitle>
            <DialogContent>
              <Stack spacing={2} sx={{ pt: 1 }}>
                {form === 'setup' && (
                  <>
                    <DialogContentText>
                      <Trans>
                        Find the one-time setup code in your Tunarr container
                        log or the terminal running Tunarr. It expires after ten
                        minutes.
                      </Trans>
                    </DialogContentText>
                    <TextField
                      name="code"
                      label={t`Setup code`}
                      autoComplete="one-time-code"
                      autoFocus
                      required
                    />
                  </>
                )}
                {form === 'migrate' && (
                  <DialogContentText>
                    <Trans>
                      Confirm the username and password you currently use to
                      access this server.
                    </Trans>
                  </DialogContentText>
                )}
                <TextField
                  name="username"
                  label={t`Username`}
                  autoComplete="username"
                  autoFocus={form !== 'setup'}
                  required
                />
                <TextField
                  name="password"
                  label={t`Password`}
                  type="password"
                  helperText={
                    form === 'setup'
                      ? t`Use at least 12 characters.`
                      : undefined
                  }
                  slotProps={{
                    htmlInput: { minLength: form === 'setup' ? 12 : undefined },
                  }}
                  autoComplete={
                    form === 'setup' ? 'new-password' : 'current-password'
                  }
                  required
                />
                {error && <Alert severity="error">{error}</Alert>}
              </Stack>
            </DialogContent>
            <DialogActions>
              <Button
                disabled={busy}
                onClick={() => {
                  setForm(undefined);
                  setError('');
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button type="submit" variant="contained" disabled={busy}>
                {form === 'setup'
                  ? t`Create administrator`
                  : form === 'migrate'
                    ? t`Save login`
                    : t`Sign in`}
              </Button>
            </DialogActions>
          </form>
        </Dialog>
      )}
    </>
  );
}

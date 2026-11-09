import { MonoText } from '@/components/ui/MonoText.tsx';
import { StatusPill } from '@/components/ui/StatusPill.tsx';
import {
  postApiExtensionsActionsRunMutation,
  postApiExtensionsSettingsTestMutation,
  postApiExtensionsUninstallMutation,
  postApiExtensionsUpdatesApplyMutation,
  postApiExtensionsUpdatesCheckMutation,
  putApiExtensionsEnabledMutation,
  putApiExtensionsSettingsMutation,
} from '@/generated/@tanstack/react-query.gen.ts';
import {
  extensionErrorMessage,
  useRefreshExtensionStore,
  type ExtensionAction,
  type ExtensionField,
  type InstalledExtension,
} from '@/hooks/useExtensionStore.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  CheckCircleOutline,
  ErrorOutline,
  Visibility,
  VisibilityOff,
} from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputAdornment,
  Link,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useEffect, useRef, useState } from 'react';
import { ExtensionStatusPill } from './ExtensionStatusPill.tsx';
import { ExtensionAccessGuide } from './ExtensionAccessGuide.tsx';
import { ActionResult } from './RunExtensionActionDialog.tsx';

type Props = {
  extension: InstalledExtension | undefined;
  onClose: () => void;
  /** Opens an action's run dialog over this one. */
  onRun: (action: ExtensionAction) => void;
};

// The details template every extension plugs into. A tab with nothing in it
// isn't shown.
type DetailsTab = 'info' | 'configuration' | 'actions' | 'access';

// Tunarr runs this action itself when Info opens (manifest rule: no inputs).
const statusActionId = 'status';

type TestState =
  | { state: 'idle' }
  | { state: 'ok'; message?: string }
  | { state: 'failed'; message: string };

const trimUrl = (value: string) => value.trim().replace(/\/+$/, '');

export function ExtensionEditDialog({ extension, onClose, onRun }: Props) {
  return (
    <Dialog
      open={!!extension}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby="extension-edit-title"
    >
      {extension && (
        <ExtensionEditForm
          key={extension.key + extension.commit}
          extension={extension}
          onClose={onClose}
          onRun={onRun}
        />
      )}
    </Dialog>
  );
}

function ExtensionEditForm({
  extension,
  onClose,
  onRun,
}: {
  extension: InstalledExtension;
  onClose: () => void;
  onRun: (action: ExtensionAction) => void;
}) {
  const { t } = useLingui();
  const snackbar = useSnackbar();
  const refresh = useRefreshExtensionStore();

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const field of extension.settings)
      initial[field.key] =
        field.type === 'secret' ? '' : (extension.values[field.key] ?? '');
    return initial;
  });
  const [clearSecrets, setClearSecrets] = useState<string[]>([]);
  // A required field only turns red after someone has edited it.
  const [touched, setTouched] = useState<string[]>([]);
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [enabled, setEnabled] = useState(
    extension.configured ? extension.enabled : true,
  );
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [error, setError] = useState<string>();
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  // Counts Test runs and edits, so a late answer can tell it is stale.
  const testRun = useRef(0);
  const [latest, setLatest] = useState(false);
  // An extension that still needs setup opens on Configuration.
  const [tab, setTab] = useState<DetailsTab>(
    extension.compatible && !extension.configured ? 'configuration' : 'info',
  );

  const testMutation = useMutation(postApiExtensionsSettingsTestMutation());
  const saveSettings = useMutation(putApiExtensionsSettingsMutation());
  const setEnabledMutation = useMutation(putApiExtensionsEnabledMutation());
  const uninstall = useMutation(postApiExtensionsUninstallMutation());
  const checkUpdate = useMutation(postApiExtensionsUpdatesCheckMutation());
  const applyUpdate = useMutation(postApiExtensionsUpdatesApplyMutation());

  const urlFields = extension.settings.filter((f) => f.type === 'url');
  const addressChanged = urlFields.some(
    (f) => trimUrl(values[f.key] ?? '') !== (extension.values[f.key] ?? ''),
  );
  const keepsSecret = (field: ExtensionField) =>
    extension.savedSecrets.includes(field.key) &&
    !addressChanged &&
    !clearSecrets.includes(field.key);
  const missing = extension.settings.filter(
    (field) =>
      field.required &&
      !values[field.key]?.trim() &&
      !(field.type === 'secret' && keepsSecret(field)),
  );
  const settingsChanged =
    !extension.configured ||
    clearSecrets.length > 0 ||
    extension.settings.some((field) =>
      field.type === 'secret'
        ? !!values[field.key]
        : (field.type === 'url'
            ? trimUrl(values[field.key] ?? '')
            : (values[field.key] ?? '').trim()) !==
          (extension.values[field.key] ?? ''),
    );
  const enabledChanged = extension.configured && enabled !== extension.enabled;
  const busy =
    saveSettings.isPending ||
    setEnabledMutation.isPending ||
    uninstall.isPending ||
    applyUpdate.isPending;
  // Built for an extension API this Tunarr doesn't run: only update or
  // uninstall make sense.
  const usable = extension.compatible;
  // Turned on and set up, so its actions can run.
  const running = usable && extension.enabled && extension.configured;
  const statusAction = extension.actions.find((a) => a.id === statusActionId);
  const actions = extension.actions.filter((a) => a.id !== statusActionId);
  const tabs: DetailsTab[] = usable
    ? [
        'info',
        'configuration',
        ...(actions.length ? ['actions' as const] : []),
        'access',
      ]
    : ['info'];
  const canSave =
    usable &&
    !busy &&
    missing.length === 0 &&
    (settingsChanged || enabledChanged);

  const body = () => ({
    key: extension.key,
    values,
    clearSecrets,
  });

  const runTest = async () => {
    setError(undefined);
    const run = ++testRun.current;
    try {
      const result = await testMutation.mutateAsync({ body: body() });
      // The fields changed while Test was running: this answer is for
      // values the dialog no longer shows.
      if (run !== testRun.current) return;
      setTest({
        state: 'ok',
        message:
          typeof result.message === 'string' ? result.message : undefined,
      });
    } catch (e) {
      if (run !== testRun.current) return;
      setTest({
        state: 'failed',
        message: extensionErrorMessage(e, t`The connection test failed.`),
      });
    }
  };

  const save = async () => {
    setError(undefined);
    try {
      // One request saves the settings with the chosen Enable state.
      if (settingsChanged)
        await saveSettings.mutateAsync({ body: { ...body(), enabled } });
      else if (enabledChanged)
        await setEnabledMutation.mutateAsync({
          body: { key: extension.key, enabled },
        });
      await refresh();
      snackbar.enqueueSnackbar(t`Saved ${extension.name}.`, {
        variant: 'success',
      });
      onClose();
    } catch (e) {
      setError(extensionErrorMessage(e, t`Could not save the extension.`));
    }
  };

  const removeExtension = async () => {
    setError(undefined);
    try {
      await uninstall.mutateAsync({ body: { key: extension.key } });
      await refresh();
      snackbar.enqueueSnackbar(t`Uninstalled ${extension.name}.`, {
        variant: 'success',
      });
      onClose();
    } catch (e) {
      setConfirmUninstall(false);
      setError(extensionErrorMessage(e, t`Could not uninstall the extension.`));
    }
  };

  const runCheckUpdate = async () => {
    setError(undefined);
    setLatest(false);
    try {
      await checkUpdate.mutateAsync({ body: { key: extension.key } });
      await refresh();
      setLatest(true);
    } catch (e) {
      setError(extensionErrorMessage(e, t`Could not check for an update.`));
    }
  };

  const runUpdate = async () => {
    if (!extension.update) return;
    setError(undefined);
    try {
      await applyUpdate.mutateAsync({
        body: { key: extension.key, commit: extension.update.commit },
      });
      await refresh();
      snackbar.enqueueSnackbar(
        t`Updated ${extension.name} to ${extension.update.version}.`,
        { variant: 'success' },
      );
    } catch (e) {
      setError(extensionErrorMessage(e, t`Could not update the extension.`));
    }
  };

  // A Test result describes the values that were tested, so any edit clears it.
  const setValue = (key: string, value: string) => {
    testRun.current++;
    setTest({ state: 'idle' });
    setTouched((prev) => (prev.includes(key) ? prev : [...prev, key]));
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const secretHelp = (field: ExtensionField) => {
    if (clearSecrets.includes(field.key))
      return t`The saved value will be removed when you save.`;
    if (!extension.savedSecrets.includes(field.key)) return field.help;
    if (addressChanged)
      return t`The address changed, so the saved value won't be sent there. Enter it again.`;
    return t`Saved. Leave blank to keep it.`;
  };

  if (confirmUninstall) {
    return (
      <>
        <DialogTitle id="extension-edit-title">
          <Trans>Uninstall {extension.name}?</Trans>
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            <Trans>
              This removes the extension, its settings and its saved credentials
              from this server. Your channels and media are not changed. You can
              install it again from its source.
            </Trans>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmUninstall(false)} disabled={busy}>
            <Trans>Back</Trans>
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => void removeExtension()}
            disabled={busy}
          >
            {uninstall.isPending ? (
              <Trans>Uninstalling…</Trans>
            ) : (
              <Trans>Uninstall</Trans>
            )}
          </Button>
        </DialogActions>
      </>
    );
  }

  const changed = settingsChanged || enabledChanged;

  return (
    <>
      <DialogTitle id="extension-edit-title" sx={{ pb: 0 }}>
        <Stack direction="row" alignItems="center" gap={1.5} flexWrap="wrap">
          <Box component="span">{extension.name}</Box>
          <ExtensionStatusPill extension={extension} />
        </Stack>
        <Typography variant="body2" color="text.secondary" component="div">
          <MonoText>{extension.repository}</MonoText> ·{' '}
          <Trans>version {extension.version}</Trans>
          {extension.maintainer && (
            <>
              {' · '}
              <Trans>maintained by {extension.maintainer}</Trans>
            </>
          )}
          {extension.issueTracker && (
            <>
              {' · '}
              <Link
                href={extension.issueTracker}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Trans>Report a problem</Trans>
              </Link>
            </>
          )}
        </Typography>
        {tabs.length > 1 && (
          <Tabs
            value={tab}
            onChange={(_, value) => setTab(value as DetailsTab)}
            variant="scrollable"
            allowScrollButtonsMobile
            sx={{ mt: 1 }}
          >
            <Tab value="info" label={t`Info`} />
            {tabs.includes('configuration') && (
              <Tab value="configuration" label={t`Configuration`} />
            )}
            {tabs.includes('actions') && (
              <Tab value="actions" label={t`Actions`} />
            )}
            {tabs.includes('access') && (
              <Tab value="access" label={t`Access`} />
            )}
          </Tabs>
        )}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {error && (
            <Alert severity="error" onClose={() => setError(undefined)}>
              {error}
            </Alert>
          )}
          {tab === 'info' && (
            <>
              {!usable && (
                <Alert severity="error">
                  {extension.problem ??
                    t`This extension was built for another version of Tunarr.`}{' '}
                  <Trans>Check for an update, or uninstall it.</Trans>
                </Alert>
              )}
              {extension.description && (
                <Typography variant="body2">{extension.description}</Typography>
              )}
              {extension.update ? (
                <Alert
                  severity="info"
                  action={
                    <Button
                      color="inherit"
                      size="small"
                      onClick={() => void runUpdate()}
                      disabled={busy}
                    >
                      {applyUpdate.isPending ? (
                        <Trans>Updating…</Trans>
                      ) : (
                        <Trans>Update</Trans>
                      )}
                    </Button>
                  }
                >
                  <Trans>
                    Version {extension.update.version} is available from the
                    publisher.
                  </Trans>
                </Alert>
              ) : latest ? (
                <Alert severity="success" onClose={() => setLatest(false)}>
                  <Trans>You have the latest version.</Trans>
                </Alert>
              ) : (
                <Box>
                  <Button
                    size="small"
                    onClick={() => void runCheckUpdate()}
                    disabled={checkUpdate.isPending || busy}
                  >
                    {checkUpdate.isPending ? (
                      <Trans>Checking…</Trans>
                    ) : (
                      <Trans>Check for update</Trans>
                    )}
                  </Button>
                </Box>
              )}
              {extension.capabilities.map((capability) => (
                <CapabilityLine
                  key={capability.capability}
                  capability={capability}
                />
              ))}
              {running && statusAction && (
                <StatusCheck extension={extension} action={statusAction} />
              )}
              <Divider />
              <Box>
                <Button
                  color="error"
                  onClick={() => setConfirmUninstall(true)}
                  disabled={busy}
                >
                  <Trans>Uninstall</Trans>
                </Button>
              </Box>
            </>
          )}
          {tab === 'configuration' && (
            <>
              {test.state === 'failed' && (
                <Alert severity="error" icon={<ErrorOutline />}>
                  {test.message}
                </Alert>
              )}
              {test.state === 'ok' && test.message && (
                <Alert severity="success">{test.message}</Alert>
              )}
              {!extension.configured && (
                <Alert severity="warning">
                  <Trans>
                    Finish setup and save to turn this extension on.
                  </Trans>
                </Alert>
              )}
              {extension.setupHelp && (
                <Typography variant="body2" color="text.secondary">
                  {extension.setupHelp}
                </Typography>
              )}
              {extension.settings.map((field) => {
                const isMissing = missing.includes(field);
                if (field.type !== 'secret')
                  return (
                    <TextField
                      key={field.key}
                      label={field.label}
                      type={field.type === 'url' ? 'url' : 'text'}
                      value={values[field.key] ?? ''}
                      onChange={(e) => setValue(field.key, e.target.value)}
                      placeholder={field.placeholder}
                      required={field.required}
                      error={isMissing && touched.includes(field.key)}
                      helperText={field.help}
                      autoComplete="off"
                      fullWidth
                      disabled={busy}
                    />
                  );
                const saved = extension.savedSecrets.includes(field.key);
                return (
                  <Box key={field.key}>
                    <TextField
                      label={field.label}
                      type={showSecret[field.key] ? 'text' : 'password'}
                      value={values[field.key] ?? ''}
                      onChange={(e) => setValue(field.key, e.target.value)}
                      placeholder={
                        saved && keepsSecret(field)
                          ? '••••••••'
                          : field.placeholder
                      }
                      required={field.required && !keepsSecret(field)}
                      error={isMissing && touched.includes(field.key)}
                      helperText={secretHelp(field)}
                      autoComplete="new-password"
                      fullWidth
                      disabled={busy || clearSecrets.includes(field.key)}
                      slotProps={{
                        formHelperText: {
                          sx:
                            saved && addressChanged && !values[field.key]
                              ? { color: 'warning.main' }
                              : undefined,
                        },
                        input: {
                          endAdornment: (
                            <InputAdornment position="end">
                              <IconButton
                                aria-label={t`Show or hide ${field.label}`}
                                onClick={() =>
                                  setShowSecret((prev) => ({
                                    ...prev,
                                    [field.key]: !prev[field.key],
                                  }))
                                }
                                edge="end"
                              >
                                {showSecret[field.key] ? (
                                  <VisibilityOff />
                                ) : (
                                  <Visibility />
                                )}
                              </IconButton>
                            </InputAdornment>
                          ),
                        },
                      }}
                    />
                    {saved && (
                      <FormControlLabel
                        sx={{ mt: 0.5 }}
                        control={
                          <Checkbox
                            size="small"
                            checked={clearSecrets.includes(field.key)}
                            onChange={(e) => {
                              setValue(field.key, '');
                              setClearSecrets((prev) =>
                                e.target.checked
                                  ? [...prev, field.key]
                                  : prev.filter((k) => k !== field.key),
                              );
                            }}
                            disabled={busy}
                          />
                        }
                        label={<Trans>Remove the saved {field.label}</Trans>}
                      />
                    )}
                  </Box>
                );
              })}
              {extension.credentialHelp && (
                <FormHelperText sx={{ mt: -1 }}>
                  {extension.credentialHelp}
                </FormHelperText>
              )}
              <Box>
                <FormControlLabel
                  control={
                    <Switch
                      checked={enabled}
                      onChange={(e) => setEnabled(e.target.checked)}
                      disabled={busy}
                    />
                  }
                  label={<Trans>Enable</Trans>}
                />
                <FormHelperText sx={{ mt: 0 }}>
                  <Trans>
                    A disabled extension keeps its settings, but its actions
                    can't run.
                  </Trans>
                </FormHelperText>
              </Box>
            </>
          )}
          {tab === 'actions' && (
            <Stack spacing={1.5} divider={<Divider flexItem />}>
              {!running && (
                <Typography variant="body2" color="text.secondary">
                  <Trans>Turn the extension on to run its actions.</Trans>
                </Typography>
              )}
              {actions.map((action) => (
                <Stack
                  key={action.id}
                  direction="row"
                  alignItems="center"
                  justifyContent="space-between"
                  gap={2}
                >
                  <Box>
                    <Typography variant="body2" fontWeight={600}>
                      {action.label}
                    </Typography>
                    {action.quick && (
                      <Typography variant="caption" color="text.secondary">
                        <Trans>Also on the card</Trans>
                      </Typography>
                    )}
                  </Box>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => onRun(action)}
                    disabled={!running || busy}
                  >
                    <Trans>Run</Trans>
                  </Button>
                </Stack>
              ))}
            </Stack>
          )}
          {tab === 'access' && (
            <ExtensionAccessGuide
              name={extension.name}
              guide={extension.accessGuide}
              allowance={extension.allowance}
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1, flexWrap: 'wrap' }}>
        {tab === 'configuration' && usable && extension.connectionTest && (
          <Button
            variant="outlined"
            color={test.state === 'ok' ? 'success' : 'inherit'}
            onClick={() => void runTest()}
            disabled={testMutation.isPending || busy || missing.length > 0}
            startIcon={
              testMutation.isPending ? (
                <CircularProgress size={16} color="inherit" />
              ) : test.state === 'ok' ? (
                <CheckCircleOutline />
              ) : test.state === 'failed' ? (
                <ErrorOutline color="error" />
              ) : undefined
            }
          >
            <Trans>Test</Trans>
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose} disabled={busy}>
          {usable && changed ? <Trans>Cancel</Trans> : <Trans>Close</Trans>}
        </Button>
        {usable && (tab === 'configuration' || changed) && (
          <Button
            variant="contained"
            onClick={() => void save()}
            disabled={!canSave}
            startIcon={
              saveSettings.isPending || setEnabledMutation.isPending ? (
                <CircularProgress size={16} color="inherit" />
              ) : undefined
            }
          >
            <Trans>Save</Trans>
          </Button>
        )}
      </DialogActions>
    </>
  );
}

// "Provides similar titles" and how far along it is, straight from Tunarr.
function CapabilityLine({
  capability,
}: {
  capability: InstalledExtension['capabilities'][number];
}) {
  const label = capability.label;
  return (
    <Box>
      <Stack direction="row" alignItems="center" gap={1}>
        <Typography variant="body2" fontWeight={600}>
          <Trans>Provides {label}</Trans>
        </Typography>
        {capability.state === 'ready' ? (
          <StatusPill status="live" label={<Trans>Ready</Trans>} />
        ) : capability.state === 'preparing' ? (
          <StatusPill status="warning" label={<Trans>Preparing</Trans>} />
        ) : (
          <StatusPill status="idle" label={<Trans>Off</Trans>} />
        )}
      </Stack>
      {capability.state !== 'ready' && (
        <Typography variant="caption" color="text.secondary">
          {capability.message}
        </Typography>
      )}
    </Box>
  );
}

// The extension's own status, run each time Info opens.
function StatusCheck({
  extension,
  action,
}: {
  extension: InstalledExtension;
  action: ExtensionAction;
}) {
  const { t } = useLingui();
  const run = useMutation(postApiExtensionsActionsRunMutation());
  const [result, setResult] = useState<Record<string, unknown>>();
  const [error, setError] = useState<string>();
  const started = useRef(false);

  const check = async () => {
    setError(undefined);
    try {
      const response = await run.mutateAsync({
        body: { key: extension.key, action: action.id, inputs: {} },
      });
      setResult(response.result);
    } catch (e) {
      setResult(undefined);
      setError(extensionErrorMessage(e, t`The status check could not finish.`));
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void check();
  });

  const name = extension.name;
  return (
    <Box>
      {run.isPending && !result && !error && (
        <Stack direction="row" alignItems="center" gap={1}>
          <CircularProgress size={16} />
          <Typography variant="body2" color="text.secondary">
            <Trans>Checking {name}…</Trans>
          </Typography>
        </Stack>
      )}
      {error && <Alert severity="error">{error}</Alert>}
      {result && <ActionResult result={result} action={action} />}
      {(result || error) && (
        <Button
          size="small"
          onClick={() => void check()}
          disabled={run.isPending}
          sx={{ mt: 1 }}
        >
          <Trans>Check again</Trans>
        </Button>
      )}
    </Box>
  );
}

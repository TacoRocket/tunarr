import { ProgramSearchAutocomplete } from '@/components/ProgramSearchAutocomplete.tsx';
import { postApiExtensionsActionsRunMutation } from '@/generated/@tanstack/react-query.gen.ts';
import {
  formatTerminalProgramTitle,
  terminalTypeFilter,
} from '@/helpers/programSearch.ts';
import {
  extensionErrorMessage,
  type ExtensionAction,
  type InstalledExtension,
} from '@/hooks/useExtensionStore.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation } from '@tanstack/react-query';
import {
  isTerminalItemType,
  type ProgramOrFolder,
  type TerminalProgram,
} from '@tunarr/types';
import type { SearchRequest } from '@tunarr/types/schemas';
import { useCallback, useState } from 'react';

type Props = {
  target:
    | { extension: InstalledExtension; action: ExtensionAction }
    | undefined;
  onClose: () => void;
};

export function RunExtensionActionDialog({ target, onClose }: Props) {
  return (
    <Dialog open={!!target} onClose={onClose} fullWidth maxWidth="sm">
      {target && (
        <RunActionForm
          key={target.extension.key + target.action.id}
          extension={target.extension}
          action={target.action}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

function labelFor(key: string, action: ExtensionAction) {
  return (
    action.resultLabels?.[key] ??
    key
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, (c) => c.toUpperCase())
  );
}

function ResultValue({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <Trans>Not specified</Trans>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <Trans>None</Trans>;
    return (
      <>
        {value
          .map((item) =>
            typeof item === 'string' ? item : JSON.stringify(item),
          )
          .join(', ')}
      </>
    );
  }
  if (typeof value === 'string') return <>{value}</>;
  return <>{JSON.stringify(value)}</>;
}

const tones = ['success', 'info', 'warning', 'error'] as const;
type Tone = (typeof tones)[number];

// An action answers with one plain sentence (message), an optional tone and
// optional labelled details. A result without a message is shown as its raw
// fields so older packages still display something.
export function ActionResult({
  result,
  action,
}: {
  result: Record<string, unknown>;
  action: ExtensionAction;
}) {
  const message =
    typeof result.message === 'string' && result.message.trim()
      ? result.message
      : undefined;
  const tone: Tone =
    message && tones.includes(result.tone as Tone)
      ? (result.tone as Tone)
      : 'info';
  const details = message
    ? result.details && typeof result.details === 'object'
      ? (result.details as Record<string, unknown>)
      : {}
    : result;
  const entries = Object.entries(details);
  return (
    <Alert severity={tone}>
      {message && (
        <Typography
          variant="body2"
          fontWeight={600}
          sx={{ mb: entries.length ? 1 : 0 }}
        >
          {message}
        </Typography>
      )}
      {entries.length > 0 && (
        <Box
          component="dl"
          sx={{
            m: 0,
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'auto 1fr' },
            columnGap: 2,
            rowGap: 0.75,
            '& dt': { fontWeight: 600 },
            '& dd': { m: 0, overflowWrap: 'anywhere' },
          }}
        >
          {entries.map(([key, value]) => (
            <Box key={key} sx={{ display: 'contents' }}>
              <dt>{labelFor(key, action)}</dt>
              <dd>
                <ResultValue value={value} />
              </dd>
            </Box>
          ))}
        </Box>
      )}
    </Alert>
  );
}

function RunActionForm({
  extension,
  action,
  onClose,
}: {
  extension: InstalledExtension;
  action: ExtensionAction;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const run = useMutation(postApiExtensionsActionsRunMutation());
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [programs, setPrograms] = useState<
    Record<string, TerminalProgram | null>
  >({});
  const [searches, setSearches] = useState<Record<string, SearchRequest>>({});
  const [result, setResult] = useState<Record<string, unknown>>();
  const [error, setError] = useState<string>();

  const includeProgram = useCallback(
    (item: ProgramOrFolder): item is TerminalProgram =>
      isTerminalItemType(item),
    [],
  );

  const missing = action.inputs.some(
    (input) => input.required && !inputs[input.key]?.trim(),
  );

  const submit = async () => {
    setError(undefined);
    setResult(undefined);
    try {
      const response = await run.mutateAsync({
        body: { key: extension.key, action: action.id, inputs },
      });
      setResult(response.result);
    } catch (e) {
      setError(extensionErrorMessage(e, t`The extension could not finish.`));
    }
  };

  const setInput = (key: string, value: string) => {
    setResult(undefined);
    setError(undefined);
    setInputs((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <>
      <DialogTitle>
        {action.label}
        <Typography variant="body2" color="text.secondary">
          {extension.name}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack
          component="form"
          id="extension-action-form"
          spacing={2}
          sx={{ pt: 1 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!missing && !run.isPending) void submit();
          }}
        >
          {action.inputs.map((input) =>
            input.type === 'tunarrProgram' ? (
              <Box key={input.key}>
                <ProgramSearchAutocomplete<TerminalProgram>
                  searchQuery={
                    searches[input.key] ?? {
                      query: '',
                      filter: terminalTypeFilter,
                      restrictSearchTo: ['title'],
                    }
                  }
                  enabled={!!searches[input.key]?.query}
                  value={programs[input.key] ?? null}
                  includeItem={includeProgram}
                  onChange={(program) => {
                    setPrograms((prev) => ({ ...prev, [input.key]: program }));
                    setInput(input.key, program.uuid);
                  }}
                  onQueryChange={(query) =>
                    setSearches((prev) => ({
                      ...prev,
                      [input.key]: {
                        query,
                        filter: terminalTypeFilter,
                        restrictSearchTo: ['title'],
                      },
                    }))
                  }
                  label={input.label}
                  disabled={run.isPending}
                  renderOptionTitle={formatTerminalProgramTitle}
                />
                {input.help && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ ml: 1.75 }}
                  >
                    {input.help}
                  </Typography>
                )}
              </Box>
            ) : (
              <TextField
                key={input.key}
                label={input.label}
                value={inputs[input.key] ?? ''}
                onChange={(e) => setInput(input.key, e.target.value)}
                placeholder={input.placeholder}
                helperText={input.help}
                required={input.required}
                disabled={run.isPending}
                fullWidth
              />
            ),
          )}
          {error && <Alert severity="error">{error}</Alert>}
          {result && <ActionResult result={result} action={action} />}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>
          <Trans>Close</Trans>
        </Button>
        <Button
          type="submit"
          form="extension-action-form"
          variant="contained"
          disabled={missing || run.isPending}
          startIcon={
            run.isPending ? (
              <CircularProgress size={16} color="inherit" />
            ) : undefined
          }
        >
          {run.isPending ? <Trans>Running…</Trans> : <Trans>Run</Trans>}
        </Button>
      </DialogActions>
    </>
  );
}

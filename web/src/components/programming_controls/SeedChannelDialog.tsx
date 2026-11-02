import { Trans, useLingui } from '@lingui/react/macro';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Slider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { Episode, Movie, ProgramOrFolder, Show } from '@tunarr/types';
import type { GenerateSeedChannelResult } from '@tunarr/types/api';
import type { SearchRequest } from '@tunarr/types/schemas';
import { useMemo, useState } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { postApiProgrammingGenerateSeedChannel } from '../../generated/sdk.gen.ts';
import { getApiErrorMessage } from '../../helpers/apiError.ts';
import { applyGeneratedChannelProgramming } from '../../store/channelEditor/actions.ts';
import { useChannelEditor } from '../../store/selectors.ts';
import { ProgramSearchAutocomplete } from '../ProgramSearchAutocomplete.tsx';

type SeedProgram = Show | Episode | Movie;

function isSeedProgram(program: ProgramOrFolder): program is SeedProgram {
  return (
    program.type === 'show' ||
    program.type === 'episode' ||
    program.type === 'movie'
  );
}

type Settings = {
  programs: SeedProgram[];
  hours: number;
  familiarity: number;
};

type Props = { open: boolean; onClose: () => void };

export function SeedChannelDialog({ open, onClose }: Props) {
  return open ? <SeedChannelDialogContent onClose={onClose} /> : null;
}

function SeedChannelDialogContent({ onClose }: Pick<Props, 'onClose'>) {
  const { t } = useLingui();
  const { currentEntity: channel } = useChannelEditor();
  const [lastSettings, setLastSettings] = useLocalStorage<Settings>(
    'seed-channel-settings',
    { programs: [], hours: 24, familiarity: 50 },
  );
  const [programs, setPrograms] = useState(lastSettings.programs);
  const [hours, setHours] = useState(String(lastSettings.hours));
  const [familiarity, setFamiliarity] = useState(lastSettings.familiarity);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<GenerateSeedChannelResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const durationHours = Number(hours);
  const validHours =
    Number.isFinite(durationHours) &&
    durationHours >= 1 &&
    durationHours <= 168;
  const search = useMemo(
    () =>
      ({
        query,
        filter: {
          type: 'value',
          fieldSpec: {
            key: 'type',
            type: 'string',
            op: 'in',
            value: ['show', 'episode', 'movie'],
          },
        },
        restrictSearchTo: ['title'],
      }) satisfies SearchRequest,
    [query],
  );

  async function generate(seed?: number[]) {
    if (programs.length === 0 || !channel || !validHours || pending) return;
    setPending(true);
    setError(undefined);
    setResult(undefined);
    setLastSettings({ programs, hours: durationHours, familiarity });
    try {
      const response = await postApiProgrammingGenerateSeedChannel({
        body: {
          seedProgramIds: programs.map((program) => program.uuid),
          channelId: channel.id,
          hours: durationHours,
          familiarity,
          seed,
        },
        throwOnError: true,
      });
      setResult(response.data);
    } catch (error) {
      setError(
        getApiErrorMessage(error) ??
          (error instanceof Error ? error.message : t`Generation failed.`),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      maxWidth="md"
      fullWidth
      onClose={() => {
        if (!pending) onClose();
      }}
    >
      <DialogTitle>
        <Trans>Generate from seeds</Trans>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography color="text.secondary">
            <Trans>
              Start with one or more shows, episodes, or movies. Related
              programs form a new lineup, with this channel's recorded plays
              giving favorites a greater chance. Preview as often as you like;
              generating does not count as a play.
            </Trans>
          </Typography>
          <Typography variant="body2" color="text.secondary">
            <Trans>
              Regenerating keeps this channel's viewing history. Deleting the
              channel starts fresh.
            </Trans>
          </Typography>
          <ProgramSearchAutocomplete
            value={null}
            searchQuery={search}
            enabled={query.trim().length > 0 && !pending}
            includeItem={isSeedProgram}
            onChange={(value) => {
              setPrograms((current) =>
                current.some((program) => program.uuid === value.uuid)
                  ? current
                  : [...current, value],
              );
              setResult(undefined);
            }}
            onQueryChange={setQuery}
            label={t`Add a starting show, episode, or movie`}
            disabled={pending || programs.length >= 10}
            renderOptionTitle={(value) => `${value.title} (${value.type})`}
          />
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {programs.map((program) => (
              <Chip
                key={program.uuid}
                label={program.title}
                disabled={pending}
                onDelete={() => {
                  setPrograms((current) =>
                    current.filter(
                      (selected) => selected.uuid !== program.uuid,
                    ),
                  );
                  setResult(undefined);
                }}
              />
            ))}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            <Trans>
              Combine up to 10 seeds to shape the channel. For example, The
              Mandalorian and Cowboy Bebop for a space-western mix.
            </Trans>
          </Typography>
          <TextField
            label={t`Channel length (hours)`}
            type="number"
            value={hours}
            onChange={(event) => {
              setHours(event.target.value);
              setResult(undefined);
            }}
            slotProps={{ htmlInput: { min: 1, max: 168, step: 1 } }}
            error={!validHours}
            helperText={
              validHours
                ? t`Whole programs may extend slightly beyond this length.`
                : t`Choose between 1 and 168 hours.`
            }
            disabled={pending}
          />
          <Box>
            <Typography id="seed-channel-familiarity-label" gutterBottom>
              <Trans>Familiarity</Trans>: {familiarity}%
            </Typography>
            <Slider
              aria-labelledby="seed-channel-familiarity-label"
              value={familiarity}
              onChange={(_, value) => {
                if (typeof value === 'number') {
                  setFamiliarity(value);
                  setResult(undefined);
                }
              }}
              min={0}
              max={100}
              step={10}
              valueLabelDisplay="auto"
              disabled={pending}
            />
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="caption">
                <Trans>Similarity only</Trans>
              </Typography>
              <Typography variant="caption">
                <Trans>Favor familiar programs</Trans>
              </Typography>
            </Stack>
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button
              variant="outlined"
              disabled={
                pending || programs.length === 0 || !channel || !validHours
              }
              onClick={() => void generate()}
            >
              {pending
                ? t`Generating…`
                : result
                  ? t`Try another lineup`
                  : t`Generate preview`}
            </Button>
            {result && (
              <Button
                disabled={pending}
                onClick={() => void generate(result.seed)}
              >
                <Trans>Repeat this draw</Trans>
              </Button>
            )}
          </Stack>
          {result && (
            <>
              {result.warnings.map((warning) => (
                <Alert severity="warning" key={warning}>
                  {warning}
                </Alert>
              ))}
              <Typography>
                <Trans>
                  {result.lineup.length} programs ·{' '}
                  {(result.durationMs / 3_600_000).toFixed(1)} hours
                </Trans>
              </Typography>
              <TextField
                label={t`Draw seed`}
                value={result.seed.join(', ')}
                slotProps={{ input: { readOnly: true } }}
                helperText={t`Repeat this draw uses the same seed. Library or play-count changes can change the result.`}
                size="small"
                fullWidth
              />
              <Stack
                spacing={1.5}
                divider={<Divider />}
                sx={{ maxHeight: 320, overflow: 'auto' }}
                aria-label={t`Generated lineup preview`}
              >
                {result.choices.map((choice, index) => (
                  <Box key={`${index}-${choice.programId}`}>
                    <Typography variant="subtitle2">
                      {index + 1}. {choice.sourceTitle}
                      {choice.title !== choice.sourceTitle &&
                        ` — ${choice.title}`}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {choice.reasons.join(' · ')}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      <Trans>
                        {choice.views} recorded plays on this channel
                      </Trans>
                    </Typography>
                  </Box>
                ))}
              </Stack>
              <Alert severity="info">
                <Trans>
                  Use this lineup replaces the programming in the editor. Save
                  on the programming page to put it on the channel.
                </Trans>
              </Alert>
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={pending}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          variant="contained"
          disabled={pending || !result || result.lineup.length === 0}
          onClick={() => {
            if (!result || pending) return;
            applyGeneratedChannelProgramming(result);
            onClose();
          }}
        >
          <Trans>Use this lineup</Trans>
        </Button>
      </DialogActions>
    </Dialog>
  );
}

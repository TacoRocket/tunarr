import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Alert,
  Box,
  Button,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  MenuItem,
  Slider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { Episode, Movie, ProgramOrFolder, Show } from '@tunarr/types';
import type { GenerateSeedChannelResult } from '@tunarr/types/api';
import type {
  SearchRequest,
  SeedChannelGrowthConfig,
  SeedChannelDiscovery,
} from '@tunarr/types/schemas';
import {
  BalancedSeedChannelDefaults,
  SeedChannelRollingConfigSchema,
  SeedChannelRollingDefaults,
} from '@tunarr/types/schemas';
import { useQuery } from '@tanstack/react-query';
import { isEqual } from 'lodash-es';
import { useMemo, useState } from 'react';
import { useLocalStorage } from 'usehooks-ts';
import { postApiProgrammingGenerateSeedChannel } from '../../generated/sdk.gen.ts';
import {
  getApiCapabilitiesOptions,
  postApiProgramsSearchOptions,
} from '../../generated/@tanstack/react-query.gen.ts';
import { getApiErrorMessage } from '../../helpers/apiError.ts';
import {
  applyGeneratedChannelProgramming,
  setSeedChannelGrowth,
} from '../../store/channelEditor/actions.ts';
import { useChannelEditor } from '../../store/selectors.ts';
import { ProgramSearchAutocomplete } from '../ProgramSearchAutocomplete.tsx';
import { useSeedChannelPlayback } from '../../hooks/useSeedChannelPlayback.ts';
import { SeedChannelPlaybackNotice } from './SeedChannelPlaybackNotice.tsx';

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
  recommendationMode?: SeedChannelGrowthConfig['recommendationMode'];
  discovery?: SeedChannelDiscovery;
};

type Props = { open: boolean; onClose: () => void };

export function SeedChannelDialog({ open, onClose }: Props) {
  return open ? <SeedChannelDialogContent onClose={onClose} /> : null;
}

function SeedChannelDialogContent({ onClose }: Pick<Props, 'onClose'>) {
  const { t } = useLingui();
  const {
    currentEntity: channel,
    seedGrowth,
    programList,
  } = useChannelEditor();
  const [lastSettings, setLastSettings] = useLocalStorage<Settings>(
    'seed-channel-settings',
    { programs: [], hours: 24, familiarity: 50 },
  );
  const [knownPrograms, setKnownPrograms] = useState(lastSettings.programs);
  const [programIds, setProgramIds] = useState(
    seedGrowth?.seedProgramIds ??
      lastSettings.programs.map((program) => program.uuid),
  );
  const [hours, setHours] = useState(String(lastSettings.hours));
  const [familiarity, setFamiliarity] = useState(
    seedGrowth?.familiarity ?? lastSettings.familiarity,
  );
  const capabilities = useQuery({
    ...getApiCapabilitiesOptions(),
    staleTime: 0,
  });
  const similarity = capabilities.data?.find(
    (entry) => entry.capability === 'similarity',
  );
  const semanticReady = !capabilities.isError && similarity?.state === 'ready';
  const usingSemanticFallback =
    !capabilities.isError &&
    (similarity?.state === 'none' || similarity?.state === 'preparing');
  const [chosenMode, setRecommendationMode] = useState(
    seedGrowth?.recommendationMode,
  );
  const lastMode = lastSettings.recommendationMode;
  const recommendationMode =
    chosenMode ??
    (!seedGrowth && (lastMode !== 'semantic' || semanticReady)
      ? lastMode
      : undefined);
  const [discovery, setDiscovery] = useState(
    seedGrowth ? seedGrowth.discovery : lastSettings.discovery,
  );
  const playback = useSeedChannelPlayback(channel?.id);
  const [tuningOpen, setTuningOpen] = useState(false);
  const discoverySettings = discovery ?? BalancedSeedChannelDefaults;
  const recommendationSettings = {
    ...(recommendationMode && { recommendationMode }),
    ...(discovery && { discovery }),
  };
  const [generationMode, setGenerationMode] = useState<
    'once' | 'watched' | 'rolling'
  >(seedGrowth?.rolling ? 'rolling' : seedGrowth ? 'watched' : 'once');
  const autoGenerate = generationMode !== 'once';
  const rollingGuide = generationMode === 'rolling';
  const [rollingFields, setRollingFields] = useState(() => {
    const saved = seedGrowth?.rolling ?? SeedChannelRollingDefaults;
    return {
      minimumHours: String(saved.minimumHours),
      maximumHours: String(saved.maximumHours),
      moviePercent: String(saved.moviePercent),
      candidateCount: String(saved.candidateCount),
    };
  });
  const [targetHours, setTargetHours] = useState(
    String(seedGrowth?.targetHours ?? 12),
  );
  const savedSeeds = useQuery({
    ...postApiProgramsSearchOptions({
      body: {
        query: {
          filter: {
            type: 'value',
            fieldSpec: {
              key: 'id',
              type: 'string',
              op: 'in',
              value: programIds,
            },
          },
        },
        limit: 10,
      },
    }),
    enabled: programIds.some(
      (id) => !knownPrograms.some((program) => program.uuid === id),
    ),
  });
  const programs = programIds.flatMap((id) => {
    const program =
      knownPrograms.find((program) => program.uuid === id) ??
      savedSeeds.data?.results.find((program) => program.uuid === id);
    return program && isSeedProgram(program) ? [program] : [];
  });
  const seedsResolved = programs.length === programIds.length;
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<GenerateSeedChannelResult>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const durationHours = Number(hours);
  const growthTargetHours = Number(targetHours);
  const validGrowthTarget =
    Number.isFinite(growthTargetHours) &&
    growthTargetHours >= 1 &&
    growthTargetHours <= 168;
  const rolling = {
    minimumHours: Number(rollingFields.minimumHours),
    maximumHours: Number(rollingFields.maximumHours),
    moviePercent: Number(rollingFields.moviePercent),
    candidateCount: Number(rollingFields.candidateCount),
  };
  const rollingValidation = SeedChannelRollingConfigSchema.safeParse(rolling);
  const validRolling =
    Object.values(rollingFields).every((value) => value.trim() !== '') &&
    rollingValidation.success;
  const growthConfig: SeedChannelGrowthConfig | null = autoGenerate
    ? {
        seedProgramIds: programIds,
        familiarity,
        targetHours: rollingGuide ? rolling.maximumHours : growthTargetHours,
        ...recommendationSettings,
        ...(rollingGuide && { rolling }),
      }
    : null;
  const validGrowthSettings =
    !autoGenerate ||
    ((rollingGuide ? validRolling : validGrowthTarget) &&
      programIds.length > 0 &&
      seedsResolved);
  const growthSettingsChanged = !isEqual(growthConfig, seedGrowth ?? null);
  const validHours =
    Number.isFinite(durationHours) &&
    durationHours >= 1 &&
    durationHours <= 168;
  const validGenerationSettings =
    (rollingGuide ? validRolling : validHours) && validGrowthSettings;
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
    if (
      programs.length === 0 ||
      !seedsResolved ||
      !channel ||
      !validGenerationSettings ||
      pending
    )
      return;
    setPending(true);
    setError(undefined);
    setResult(undefined);
    setLastSettings({
      programs,
      hours: durationHours,
      familiarity,
      ...recommendationSettings,
    });
    try {
      const response = await postApiProgrammingGenerateSeedChannel({
        body: {
          seedProgramIds: programs.map((program) => program.uuid),
          channelId: channel.id,
          hours: rollingGuide ? rolling.minimumHours : durationHours,
          familiarity,
          seed,
          ...recommendationSettings,
          ...(rollingGuide && { rolling }),
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
        <Trans>Channel auto-generation</Trans>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {/* SIGNPOST(native-retirement): profile notice, see SeedChannelPlaybackNotice. */}
          {playback.blocked && <SeedChannelPlaybackNotice {...playback} />}
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
          <TextField
            select
            label={t`Programming mode`}
            value={generationMode}
            disabled={pending}
            helperText={t`Saving puts this channel on ErsatzTV next. HLS Direct becomes HLS Direct v2 and HLS Alt becomes HLS.`}
            onChange={(event) => {
              const mode = event.target.value;
              if (mode !== 'once' && mode !== 'watched' && mode !== 'rolling')
                return;
              setGenerationMode(mode);
              if (mode === 'rolling') {
                setRecommendationMode('balanced');
                if (!discovery)
                  setDiscovery({ ...BalancedSeedChannelDefaults });
              }
              setResult(undefined);
            }}
          >
            <MenuItem value="once">
              <Trans>One-time lineup</Trans>
            </MenuItem>
            <MenuItem value="watched">
              <Trans>Grow when watched</Trans>
            </MenuItem>
            <MenuItem value="rolling">
              <Trans>Rolling guide</Trans>
            </MenuItem>
          </TextField>
          <ProgramSearchAutocomplete
            value={null}
            searchQuery={search}
            enabled={query.trim().length > 0 && !pending}
            includeItem={isSeedProgram}
            onChange={(value) => {
              setKnownPrograms((current) =>
                current.some((program) => program.uuid === value.uuid)
                  ? current
                  : [...current, value],
              );
              setProgramIds((current) =>
                current.includes(value.uuid)
                  ? current
                  : [...current, value.uuid],
              );
              setResult(undefined);
            }}
            onQueryChange={setQuery}
            label={t`Add a starting show, episode, or movie`}
            disabled={pending || programIds.length >= 10}
            renderOptionTitle={(value) => `${value.title} (${value.type})`}
          />
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {programIds.map((id) => (
              <Chip
                key={id}
                label={
                  programs.find((program) => program.uuid === id)?.title ??
                  (savedSeeds.isFetching
                    ? t`Loading seed…`
                    : t`Unavailable seed`)
                }
                disabled={pending}
                onDelete={() => {
                  setProgramIds((current) =>
                    current.filter((selected) => selected !== id),
                  );
                  setResult(undefined);
                }}
              />
            ))}
          </Stack>
          {savedSeeds.isError && (
            <Alert severity="error">
              <Trans>
                Could not load this channel's saved seeds. Close and reopen to
                retry.
              </Trans>
            </Alert>
          )}
          {!seedsResolved && !savedSeeds.isFetching && !savedSeeds.isError && (
            <Alert severity="warning">
              <Trans>
                Some saved seeds are unavailable. Remove them or choose
                replacements.
              </Trans>
            </Alert>
          )}
          <Typography variant="caption" color="text.secondary">
            <Trans>
              Combine up to 10 seeds to shape the channel. For example, The
              Mandalorian and Cowboy Bebop for a space-western mix.
            </Trans>
          </Typography>
          <TextField
            select
            label={t`Matching`}
            value={recommendationMode ?? 'metadata'}
            onChange={(event) => {
              const mode = event.target.value;
              if (
                mode !== 'metadata' &&
                mode !== 'semantic' &&
                mode !== 'balanced'
              )
                return;
              setRecommendationMode(mode);
              if (mode === 'balanced' && !discovery) {
                setDiscovery({ ...BalancedSeedChannelDefaults });
              }
              setResult(undefined);
            }}
            disabled={pending || rollingGuide}
            helperText={
              <>
                {recommendationMode === 'semantic' && usingSemanticFallback
                  ? t`Semantic stays selected. Tunarr uses metadata until a similarity provider is ready.`
                  : recommendationMode === 'balanced' || rollingGuide
                    ? t`Balanced uses metadata and this channel’s watch history. A ready similarity provider adds related titles.`
                    : recommendationMode === 'semantic'
                      ? t`Matches similar titles in your library.`
                      : t`Matches the library's genres, tags, cast, directors and studios.`}{' '}
                {capabilities.isError
                  ? t`Could not check similarity availability. Reopen the dialog to retry.`
                  : (similarity?.message ??
                    t`Checking similarity availability…`)}
              </>
            }
          >
            <MenuItem value="metadata">
              <Trans>Metadata</Trans>
            </MenuItem>
            <MenuItem value="semantic" disabled={!semanticReady}>
              <Trans>Semantic</Trans>
            </MenuItem>
            <MenuItem value="balanced">
              <Trans>Balanced</Trans>
            </MenuItem>
          </TextField>
          {recommendationMode === 'balanced' && (
            <Box>
              <Typography variant="body2" color="text.secondary">
                <Trans>
                  Starts from your seeds, then gradually follows this channel's
                  recorded plays. Mix those interests with broader connections
                  and discoveries across the library.
                </Trans>
              </Typography>
              <Button
                onClick={() => setTuningOpen((open) => !open)}
                aria-expanded={tuningOpen}
                aria-controls="seed-channel-tuning"
                endIcon={
                  <ExpandMoreIcon
                    sx={{
                      transform: tuningOpen ? 'rotate(180deg)' : undefined,
                    }}
                  />
                }
              >
                <Trans>Tune recommendations</Trans>
              </Button>
              <Collapse in={tuningOpen}>
                <Stack id="seed-channel-tuning" spacing={2} sx={{ pt: 1 }}>
                  <Box>
                    <Typography id="seed-channel-discovery-label" gutterBottom>
                      <Trans>Discovery</Trans>: {discoverySettings.exploration}%
                    </Typography>
                    <Slider
                      aria-labelledby="seed-channel-discovery-label"
                      value={discoverySettings.exploration}
                      min={0}
                      max={100}
                      step={5}
                      valueLabelDisplay="auto"
                      disabled={pending}
                      onChange={(_, value) => {
                        if (typeof value !== 'number') return;
                        setDiscovery({
                          ...discoverySettings,
                          exploration: value,
                        });
                        setResult(undefined);
                      }}
                    />
                    <Typography variant="body2" color="text.secondary">
                      <Trans>
                        Higher values make more room for broader metadata
                        connections and connected detours. Five percent always
                        looks back to original seeds and older watched titles.
                      </Trans>
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      <Trans>
                        {Number(
                          (
                            (100 - discoverySettings.exploration) *
                            0.95
                          ).toFixed(1),
                        )}
                        % interests ·{' '}
                        {Number(
                          (discoverySettings.exploration * 0.8 * 0.95).toFixed(
                            1,
                          ),
                        )}
                        % broader connections ·{' '}
                        {Number(
                          (discoverySettings.exploration * 0.2 * 0.95).toFixed(
                            1,
                          ),
                        )}
                        % connected exploration · 5% look-back
                      </Trans>
                    </Typography>
                  </Box>
                  <Box>
                    <Typography id="seed-channel-variety-label" gutterBottom>
                      <Trans>Variety</Trans>:{' '}
                      {discoverySettings.temperature.toFixed(1)}
                    </Typography>
                    <Slider
                      aria-labelledby="seed-channel-variety-label"
                      value={discoverySettings.temperature}
                      min={0.7}
                      max={1.4}
                      step={0.1}
                      marks={[{ value: 1, label: t`Balanced` }]}
                      valueLabelDisplay="auto"
                      disabled={pending}
                      onChange={(_, value) => {
                        if (typeof value !== 'number') return;
                        setDiscovery({
                          ...discoverySettings,
                          temperature: value,
                        });
                        setResult(undefined);
                      }}
                    />
                    <Typography variant="body2" color="text.secondary">
                      <Trans>
                        Lower values favor closer matches. Higher values spread
                        choices among related titles. Discovery gives broader
                        connections more weight.
                      </Trans>
                    </Typography>
                  </Box>
                  <Button
                    onClick={() => {
                      setDiscovery({ ...BalancedSeedChannelDefaults });
                      setFamiliarity(50);
                      setResult(undefined);
                    }}
                    disabled={pending}
                    sx={{ alignSelf: 'flex-start' }}
                  >
                    <Trans>Reset Balanced settings</Trans>
                  </Button>
                </Stack>
              </Collapse>
            </Box>
          )}
          {rollingGuide ? (
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                <Trans>
                  Keep fresh programming ahead even when nobody watches.
                  Recorded plays steer the candidates; periodic updates extend
                  the guide and retire aired programs.
                </Trans>
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField
                  fullWidth
                  label={t`Minimum ahead (hours)`}
                  type="number"
                  value={rollingFields.minimumHours}
                  onChange={(event) => {
                    setRollingFields({
                      ...rollingFields,
                      minimumHours: event.target.value,
                    });
                    setResult(undefined);
                  }}
                  slotProps={{ htmlInput: { min: 1, max: 168, step: 1 } }}
                  error={
                    !rollingFields.minimumHours.trim() ||
                    !Number.isFinite(rolling.minimumHours) ||
                    rolling.minimumHours < 1 ||
                    rolling.minimumHours > 168
                  }
                  helperText={t`Fill to this minimum, from 1 to 168 hours.`}
                  disabled={pending}
                />
                <TextField
                  fullWidth
                  label={t`Extension limit (hours)`}
                  type="number"
                  value={rollingFields.maximumHours}
                  onChange={(event) => {
                    setRollingFields({
                      ...rollingFields,
                      maximumHours: event.target.value,
                    });
                    setResult(undefined);
                  }}
                  slotProps={{ htmlInput: { min: 1, max: 168, step: 1 } }}
                  error={
                    !rollingFields.maximumHours.trim() ||
                    !Number.isFinite(rolling.maximumHours) ||
                    rolling.maximumHours < rolling.minimumHours ||
                    rolling.maximumHours < 1 ||
                    rolling.maximumHours > 168
                  }
                  helperText={t`At least the minimum, up to 168 hours. Whole movies or episodes can exceed this limit.`}
                  disabled={pending}
                />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <TextField
                  fullWidth
                  label={t`Movie share extension trigger (%)`}
                  type="number"
                  value={rollingFields.moviePercent}
                  onChange={(event) => {
                    setRollingFields({
                      ...rollingFields,
                      moviePercent: event.target.value,
                    });
                    setResult(undefined);
                  }}
                  slotProps={{ htmlInput: { min: 0, max: 100, step: 1 } }}
                  error={
                    !rollingFields.moviePercent.trim() ||
                    !Number.isFinite(rolling.moviePercent) ||
                    rolling.moviePercent < 0 ||
                    rolling.moviePercent > 100
                  }
                  helperText={t`From 0 to 100%. Above this movie airtime share, extend toward the limit with related episodes. This is a soft trigger, not a quota.`}
                  disabled={pending}
                />
                <TextField
                  fullWidth
                  label={t`Candidate shortlist size`}
                  type="number"
                  value={rollingFields.candidateCount}
                  onChange={(event) => {
                    setRollingFields({
                      ...rollingFields,
                      candidateCount: event.target.value,
                    });
                    setResult(undefined);
                  }}
                  slotProps={{ htmlInput: { min: 10, max: 200, step: 1 } }}
                  error={
                    !rollingFields.candidateCount.trim() ||
                    !Number.isInteger(rolling.candidateCount) ||
                    rolling.candidateCount < 10 ||
                    rolling.candidateCount > 200
                  }
                  helperText={t`Choose 10 to 200 related shows and movies for the draw.`}
                  disabled={pending}
                />
              </Stack>
            </Stack>
          ) : (
            <TextField
              label={t`Initial lineup length (hours)`}
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
          )}
          {generationMode === 'watched' && (
            <>
              <TextField
                label={t`Keep about this many hours ahead`}
                type="number"
                value={targetHours}
                onChange={(event) => {
                  setTargetHours(event.target.value);
                  setResult(undefined);
                }}
                slotProps={{ htmlInput: { min: 1, max: 168, step: 1 } }}
                error={!validGrowthTarget}
                helperText={
                  validGrowthTarget
                    ? t`A whole episode or movie can take the lineup beyond this target.`
                    : t`Choose between 1 and 168 hours.`
                }
                disabled={pending}
              />
              <Typography variant="body2" color="text.secondary">
                <Trans>
                  Below the target, each new recorded play adds one related
                  pick. What you watch steers the next choice. When nobody
                  watches, the current lineup repeats.
                </Trans>
              </Typography>
            </>
          )}
          {generationMode === 'once' && (
            <Typography variant="body2" color="text.secondary">
              <Trans>
                The saved lineup repeats until you change it. Automatic
                generation is off.
              </Trans>
            </Typography>
          )}
          {(autoGenerate || seedGrowth) && (
            <Typography variant="body2" color="text.secondary">
              <Trans>
                Apply growth settings keeps the current lineup. Save on the
                programming page to make the settings active.
              </Trans>
            </Typography>
          )}
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
                <Trans>No play-count boost</Trans>
              </Typography>
              <Typography variant="caption">
                <Trans>Favor familiar programs</Trans>
              </Typography>
            </Stack>
          </Box>
          {recommendationMode === 'balanced' && (
            <Typography variant="caption" color="text.secondary">
              <Trans>
                Recorded plays steer related choices at every Familiarity
                setting.
              </Trans>
            </Typography>
          )}
          {error && <Alert severity="error">{error}</Alert>}
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button
              variant="outlined"
              disabled={
                pending ||
                programs.length === 0 ||
                !seedsResolved ||
                !channel ||
                !validGenerationSettings
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
        {/* SIGNPOST(native-retirement): remove with SeedChannelPlaybackNotice. */}
        {playback.blocked && (
          <Typography
            variant="caption"
            color="warning.main"
            sx={{ mr: 'auto', pl: 1 }}
          >
            <Trans>Saving needs a different transcode profile.</Trans>
          </Typography>
        )}
        <Button onClick={onClose} disabled={pending}>
          <Trans>Cancel</Trans>
        </Button>
        {(autoGenerate || seedGrowth) && (
          <Button
            disabled={
              pending ||
              !growthSettingsChanged ||
              !validGrowthSettings ||
              (autoGenerate && (programList.length === 0 || playback.blocked))
            }
            onClick={() => {
              setSeedChannelGrowth(growthConfig);
              onClose();
            }}
          >
            <Trans>Apply growth settings</Trans>
          </Button>
        )}
        <Button
          variant="contained"
          disabled={
            pending ||
            !result ||
            result.lineup.length === 0 ||
            !validGenerationSettings ||
            playback.blocked
          }
          onClick={() => {
            if (
              !result ||
              pending ||
              !validGenerationSettings ||
              playback.blocked
            )
              return;
            applyGeneratedChannelProgramming(result, growthConfig);
            onClose();
          }}
        >
          <Trans>Use this lineup</Trans>
        </Button>
      </DialogActions>
    </Dialog>
  );
}

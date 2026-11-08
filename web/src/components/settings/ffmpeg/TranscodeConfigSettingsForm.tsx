import { useAppForm } from '@/hooks/form.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Divider,
  FormControl,
  FormControlLabel,
  FormHelperText,
  Grid,
  Link as MuiLink,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { TranscodeConfig } from '@tunarr/types';
import type { TranscodeConfigSchema } from '@tunarr/types/schemas';
import { useState } from 'react';
import type z from 'zod';
import useStore from '../../../store/index.ts';
import UnsavedNavigationAlert from '../UnsavedNavigationAlert.tsx';
import { TranscodeConfigAdvancedOptions } from './TranscodeConfigAdvancedOptions.tsx';
import { TranscodeConfigAudioSettingsForm } from './TranscodeConfigAudioSettingsForm.tsx';
import { TranscodeConfigErrorOptions } from './TranscodeConfigErrorOptions.tsx';
import { TranscodeConfigVideoSettingsForm } from './TranscodeConfigVideoSettingsForm.tsx';
import {
  NextAudioFormats,
  NextNeutralSettings,
} from './nextTranscodeSupport.ts';
import { useTranscodeConfigFormOptions } from './useTranscodeConfigFormOptions.ts';

type Props = {
  initialConfig: z.input<typeof TranscodeConfigSchema>;
  isNew?: boolean;
  onCreated?: (config: TranscodeConfig) => void;
};

export const TranscodeConfigSettingsForm = ({
  initialConfig,
  isNew,
  onCreated,
}: Props) => {
  const { t } = useLingui();
  const showAdvancedSettings = useStore(
    (s) => s.settings.ui.showAdvancedSettings,
  );
  // SIGNPOST(native-retirement): remove the legacy toggle and the fields it
  // reveals once Tunarr's built-in playback is gone.
  const [showLegacy, setShowLegacy] = useState(false);
  const nextFirst = isNew === true && !showLegacy;

  const saveForm = (newConfig: TranscodeConfig) => {
    transcodeConfigForm.reset(newConfig, { keepDefaultValues: true });
  };

  const formOpts = useTranscodeConfigFormOptions({
    initialConfig,
    isNew,
    onSave: saveForm,
    onCreated,
  });
  const transcodeConfigForm = useAppForm({ ...formOpts });

  return (
    <Box
      component="form"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        transcodeConfigForm.handleSubmit().catch(console.error);
      }}
    >
      <transcodeConfigForm.AppForm>
        <Stack spacing={2} divider={<Divider />}>
          {nextFirst && (
            <Alert severity="info">
              <AlertTitle>
                <Trans>Made for ErsatzTV next</Trans>
              </AlertTitle>
              <Trans>
                New transcode profiles use ErsatzTV next, so every option here
                works with it. Settings it doesn't use are left out.
              </Trans>
            </Alert>
          )}
          <Box>
            <Typography variant="h5" sx={{ mb: 2 }}>
              <Trans>General</Trans>
            </Typography>
            <Grid container columnSpacing={2}>
              <Grid size={{ sm: 12, md: nextFirst ? 12 : 6 }}>
                <transcodeConfigForm.AppField
                  name="name"
                  children={(field) => (
                    <field.BasicTextInput fullWidth label={t`Name`} />
                  )}
                />
              </Grid>
              {!nextFirst && (
                <Grid size={{ sm: 12, md: 6 }}>
                  <transcodeConfigForm.Field
                    name="threadCount"
                    children={(field) => (
                      <TextField
                        label={t`Threads`}
                        fullWidth
                        helperText={
                          <>
                            <Trans>
                              Sets the number of threads used to decode the
                              input stream. Set to 0 to let ffmpeg automatically
                              decide how many threads to use. Read more about
                              this option{' '}
                              <MuiLink
                                target="_blank"
                                href="https://ffmpeg.org/ffmpeg-codecs.html#:~:text=threads%20integer%20(decoding/encoding%2Cvideo)"
                              >
                                here
                              </MuiLink>
                              . <strong>Note: </strong> this option is
                              overridden to 1 when using hardware accelearation
                              for stability reasons.
                            </Trans>{' '}
                            <Trans>
                              Not used by ErsatzTV next, which picks its own.
                            </Trans>
                          </>
                        }
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                      />
                    )}
                  />
                </Grid>
              )}
              <Grid size={12}>
                <FormControl fullWidth>
                  <FormControlLabel
                    control={
                      <transcodeConfigForm.Field
                        name="disableChannelOverlay"
                        children={(field) => (
                          <Checkbox
                            // {...field}
                            value={field.state.value}
                            checked={field.state.value}
                            onChange={(_, checked) =>
                              field.handleChange(checked)
                            }
                          />
                        )}
                      />
                    }
                    label={t`Disable Watermarks`}
                  />
                  <FormHelperText>
                    <Trans>
                      If set, all watermark overlays will be disabled for
                      channels assigned this transcode config.
                    </Trans>
                  </FormHelperText>
                </FormControl>
              </Grid>
            </Grid>
          </Box>

          <Stack spacing={2}>
            <Typography component="h5" variant="h5">
              <Trans>Video Options</Trans>
            </Typography>
            <TranscodeConfigVideoSettingsForm
              initialConfig={initialConfig}
              nextFirst={nextFirst}
            />
            <transcodeConfigForm.Subscribe
              selector={(s) => s.values.hardwareAccelerationMode}
              children={(hardwareAccelerationMode) =>
                showAdvancedSettings &&
                !nextFirst &&
                hardwareAccelerationMode !== 'none' && (
                  <Box>
                    <Typography component="h6" variant="h6" mb={1}>
                      <Trans>Advanced Video Options</Trans>
                    </Typography>
                    <Typography variant="body2" sx={{ mb: 2 }}>
                      <Trans>
                        Advanced options relating to transcoding. In general, do
                        not change these unless you know what you are doing!
                        These settings exist in order to leave some parity with
                        the old dizqueTV transcode pipeline as well as to
                        provide mechanisms to aid in debugging streaming issues.
                      </Trans>{' '}
                      <Trans>ErsatzTV next doesn't use these switches.</Trans>
                    </Typography>
                    <TranscodeConfigAdvancedOptions
                      initialConfig={initialConfig}
                    />
                  </Box>
                )
              }
            />
          </Stack>
          <Box>
            <Typography component="h5" variant="h5" sx={{ mb: 2 }}>
              <Trans>Audio Options</Trans>
            </Typography>
            <TranscodeConfigAudioSettingsForm
              initialConfig={initialConfig}
              showAdvancedSettings={showAdvancedSettings}
              nextFirst={nextFirst}
            />
          </Box>
          <Box>
            <Typography component="h6" variant="h6" sx={{ pb: 1 }}>
              <Trans>Error Options</Trans>
            </Typography>
            <TranscodeConfigErrorOptions initialConfig={initialConfig} />
          </Box>
          {isNew === true && (
            // SIGNPOST(native-retirement): remove with the legacy fields.
            <Box>
              <Button
                size="small"
                onClick={() => {
                  if (showLegacy) {
                    // Hiding them again puts them back at rest, so nothing
                    // hidden changes what the profile does.
                    for (const [name, value] of Object.entries(
                      NextNeutralSettings,
                    )) {
                      transcodeConfigForm.setFieldValue(
                        name as keyof typeof NextNeutralSettings,
                        value,
                      );
                    }
                    if (
                      !NextAudioFormats.has(
                        transcodeConfigForm.getFieldValue('audioFormat'),
                      )
                    ) {
                      transcodeConfigForm.setFieldValue('audioFormat', 'aac');
                    }
                  }
                  setShowLegacy(!showLegacy);
                }}
              >
                {showLegacy ? (
                  <Trans>Hide legacy playback options</Trans>
                ) : (
                  <Trans>Show legacy playback options</Trans>
                )}
              </Button>
              <FormHelperText>
                <Trans>
                  Settings and audio formats only Tunarr's built-in playback
                  uses. They will be removed in a coming release.
                </Trans>
              </FormHelperText>
            </Box>
          )}

          <Stack spacing={2} direction="row" justifyContent="right">
            <transcodeConfigForm.Subscribe
              selector={(state) => state}
              children={({ isPristine, canSubmit, isSubmitting }) => (
                <>
                  {!isPristine ? (
                    <Button
                      variant="outlined"
                      onClick={() => {
                        transcodeConfigForm.reset();
                      }}
                    >
                      <Trans>Reset Changes</Trans>
                    </Button>
                  ) : null}
                  <Button
                    variant="contained"
                    disabled={isPristine || !canSubmit}
                    type="submit"
                  >
                    {isSubmitting ? (
                      <Trans>Saving...</Trans>
                    ) : (
                      <Trans>Save</Trans>
                    )}
                  </Button>
                  <UnsavedNavigationAlert isDirty={!isPristine} />
                </>
              )}
            />
          </Stack>
        </Stack>
      </transcodeConfigForm.AppForm>
    </Box>
  );
};

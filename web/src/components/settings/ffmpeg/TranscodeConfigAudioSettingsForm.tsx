import { useTypedAppFormContext } from '@/hooks/form.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  FormControl,
  FormHelperText,
  Grid,
  InputAdornment,
  InputLabel,
  Link,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  LoudnormConfigSchema,
  type SupportedTranscodeAudioOutputFormats,
} from '@tunarr/types/schemas';
import { useQuery } from '@tanstack/react-query';
import { isNil } from 'lodash-es';
import { useCallback, useMemo, useState } from 'react';
import { getApiFfmpegInfoOptions } from '../../../generated/@tanstack/react-query.gen.ts';
import type { DropdownOption } from '../../../helpers/DropdownOption.ts';
import type { BaseTranscodeConfigProps } from './BaseTranscodeConfigProps.ts';
import {
  Ac3MaxChannels,
  Ac3SampleRatesKhz,
  NextAudioFormats,
} from './nextTranscodeSupport.ts';
import { useBaseTranscodeConfigFormOptions } from './useTranscodeConfigFormOptions.ts';

const AudioFormats: DropdownOption<SupportedTranscodeAudioOutputFormats>[] = [
  {
    description: 'AAC',
    value: 'aac',
  },
  {
    description: 'AC3',
    value: 'ac3',
  },
  {
    description: 'MP3',
    value: 'mp3',
  },
  {
    description: 'E-AC3',
    value: 'eac3',
  },
  {
    description: 'Opus (experimental)',
    value: 'libopus',
  },
  {
    description: 'Copy / Passthrough',
    value: 'copy',
  },
] as const;

export const TranscodeConfigAudioSettingsForm = ({
  initialConfig,
  showAdvancedSettings,
  nextFirst,
}: BaseTranscodeConfigProps) => {
  const { t } = useLingui();
  const ffmpegInfo = useQuery({
    ...getApiFfmpegInfoOptions(),
  });
  const formOpts = useBaseTranscodeConfigFormOptions(initialConfig);
  const form = useTypedAppFormContext({ ...formOpts });
  const [loudnormEnabled, setLoudnormEnabled] = useState(
    !isNil(form.getFieldValue('audioLoudnormConfig')),
  );

  const audioFormatOptions = useMemo(() => {
    const availableEncoders = ffmpegInfo.data?.audioEncoders;

    // SIGNPOST(native-retirement): once E-AC-3, MP3 and Opus can't be chosen, drop the filter.
    return AudioFormats.filter(
      (option) => !nextFirst || NextAudioFormats.has(option.value),
    ).map((option) => {
      if (option.value === 'copy') {
        return option;
      }

      const isSupported = availableEncoders?.find((encoder) => {
        return (
          encoder.ffmpegName === option.value ||
          // 'mp3' is an alias, the actual encoders in ffmpeg are called libmp3lame and libshine
          (option.value === 'mp3' &&
            encoder.name.includes(`(codec ${option.value})`))
        );
      });

      return {
        ...option,
        disabled: ffmpegInfo.isSuccess && !isSupported,
      };
    });
  }, [ffmpegInfo.data?.audioEncoders, ffmpegInfo.isSuccess, nextFirst]);

  const onLoudnormChange = useCallback(
    (enabled: boolean) => {
      setLoudnormEnabled(enabled);
      if (enabled) {
        form.setFieldValue(
          'audioLoudnormConfig',
          LoudnormConfigSchema.decode({}),
        );
      } else {
        form.setFieldValue('audioLoudnormConfig', null);
      }
    },
    [form],
  );

  return (
    <Stack spacing={2}>
      <Grid container spacing={2}>
        <Grid size={{ xs: 12 }}>
          <form.AppField
            name="audioFormat"
            children={(field) => (
              <field.BasicSelectInput
                formControlProps={{ fullWidth: true }}
                selectProps={{
                  label: t`Audio Format`,
                }}
                options={audioFormatOptions}
                // SIGNPOST(native-retirement): the error for formats only native playback encodes.
                formHelperTextProps={{
                  error: !NextAudioFormats.has(
                    field.form.state.values.audioFormat,
                  ),
                }}
                helperText={
                  field.form.state.values.audioFormat === 'copy'
                    ? t`Passthrough audio unchanged. Other settings will not apply.`
                    : !NextAudioFormats.has(field.form.state.values.audioFormat)
                      ? t`ErsatzTV next can't encode this format, so channels on ErsatzTV next can't use this profile. AAC or AC-3 work with both playback engines.`
                      : ''
                }
              />
            )}
          />
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <form.Subscribe
            selector={(s) => s.values.audioFormat}
            children={(encoder) => (
              <form.AppField
                name="audioBitRate"
                children={(field) => (
                  <field.BasicTextInput
                    fullWidth
                    label={t`Audio Bitrate`}
                    disabled={encoder === 'copy'}
                    slotProps={{
                      input: {
                        endAdornment: (
                          <InputAdornment position="end">kbps</InputAdornment>
                        ),
                      },
                    }}
                    helperText={
                      encoder === 'copy'
                        ? t`Bitrate cannot be changed when copying input audio`
                        : null
                    }
                  />
                )}
              />
            )}
          />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <form.Subscribe
            selector={(s) => s.values.audioFormat}
            children={(encoder) => (
              <form.AppField
                name="audioBufferSize"
                children={(field) => (
                  <field.BasicTextInput
                    fullWidth
                    label={t`Audio Buffer Size`}
                    disabled={encoder === 'copy'}
                    slotProps={{
                      input: {
                        endAdornment: (
                          <InputAdornment position="end">kb</InputAdornment>
                        ),
                      },
                    }}
                    helperText={
                      encoder === 'copy'
                        ? t`Buffer size cannot be changed when copying input audio`
                        : null
                    }
                  />
                )}
              />
            )}
          />
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <form.Subscribe
            selector={(s) => s.values.audioFormat}
            children={(encoder) =>
              encoder === 'ac3' ? (
                // AC-3 only works at three rates, so offer exactly those. A
                // saved profile with any other rate shows it, flagged, until the
                // user picks a replacement; the form refuses to save it.
                <form.Field
                  name="audioSampleRate"
                  children={(field) => {
                    const current = Number(field.state.value);
                    const supported = (
                      Ac3SampleRatesKhz as readonly number[]
                    ).includes(current);
                    return (
                      <TextField
                        select
                        fullWidth
                        label={t`Audio Sample Rate`}
                        value={current}
                        onChange={(event) =>
                          field.handleChange(Number(event.target.value))
                        }
                        error={!supported}
                        helperText={
                          supported
                            ? t`AC-3 supports 32, 44.1 or 48 kHz.`
                            : t`${current} kHz doesn't work with AC-3. Choose 32, 44.1 or 48 kHz.`
                        }
                      >
                        {!supported && (
                          <MenuItem value={current} disabled>
                            {t`${current} kHz (not supported)`}
                          </MenuItem>
                        )}
                        {Ac3SampleRatesKhz.map((rate) => (
                          <MenuItem key={rate} value={rate}>
                            {t`${rate} kHz`}
                          </MenuItem>
                        ))}
                      </TextField>
                    );
                  }}
                />
              ) : (
                <form.AppField
                  name="audioSampleRate"
                  children={(field) => (
                    <field.BasicTextInput
                      fullWidth
                      label={t`Audio Sample Rate`}
                      disabled={encoder === 'copy'}
                      slotProps={{
                        input: {
                          endAdornment: (
                            <InputAdornment position="end">kHz</InputAdornment>
                          ),
                        },
                      }}
                      helperText={
                        encoder === 'copy'
                          ? t`Sample rate cannot be changed when copying input audio`
                          : null
                      }
                    />
                  )}
                />
              )
            }
          />
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <form.Subscribe
            selector={(s) => s.values.audioFormat}
            children={(encoder) => (
              <form.AppField
                name="audioChannels"
                children={(field) => {
                  // The form refuses more than 5.1 for AC-3 on save; say so as
                  // soon as the profile opens rather than only after an edit.
                  const tooMany =
                    encoder === 'ac3' &&
                    Number(field.state.value) > Ac3MaxChannels &&
                    field.state.meta.errors.length === 0;
                  return (
                    <field.BasicTextInput
                      fullWidth
                      label={t`Audio Channels`}
                      error={tooMany}
                      helperText={
                        tooMany
                          ? t`AC-3 carries at most 6 channels (5.1).`
                          : null
                      }
                    />
                  );
                }}
              />
            )}
          />
        </Grid>
        {/* SIGNPOST(native-retirement): Next has no volume control. */}
        {!nextFirst && (
          <Grid size={{ xs: 12, md: 6 }}>
            <form.AppField
              name="audioVolumePercent"
              children={(field) => (
                <field.BasicTextInput
                  fullWidth
                  label={t`Audio Volume`}
                  helperText={`${t`Adjust the output volume (not recommended). Values higher than 100 will boost the audio.`} ${t`Not used by ErsatzTV next.`}`}
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment position="end">%</InputAdornment>
                      ),
                    },
                  }}
                />
              )}
            />
          </Grid>
        )}
        <Grid size={{ xs: 12, md: 6 }}>
          <form.Subscribe
            selector={(s) => s.values.audioFormat}
            children={(encoder) => (
              <FormControl
                fullWidth
                // Copied audio is never re-encoded, so it can't be leveled.
                // A profile that already has both set can still switch it off.
                disabled={encoder === 'copy' && !loudnormEnabled}
                error={encoder === 'copy' && loudnormEnabled}
              >
                <InputLabel>
                  <Trans>Audio Loudness Normalization</Trans>
                </InputLabel>
                <Select
                  label={t`Audio Loudness Normalization`}
                  value={loudnormEnabled ? 'enabled' : 'disabled'}
                  onChange={() => onLoudnormChange(!loudnormEnabled)}
                >
                  <MenuItem value={'disabled'}>
                    <Trans>Disabled</Trans>
                  </MenuItem>
                  <MenuItem value={'enabled'}>
                    <Trans>Enabled (loudnorm)</Trans>
                  </MenuItem>
                </Select>
                <FormHelperText>
                  {encoder === 'copy' ? (
                    loudnormEnabled ? (
                      <Trans>
                        Copied audio isn't re-encoded, so it won't be leveled.
                        Turn this off, or choose AAC or AC-3.
                      </Trans>
                    ) : (
                      <Trans>
                        Not available when copying audio, which isn't
                        re-encoded.
                      </Trans>
                    )
                  ) : (
                    <Trans>
                      Enable{' '}
                      <Link
                        href="https://en.wikipedia.org/wiki/EBU_R_128"
                        target="_blank"
                      >
                        EBU R 128
                      </Link>{' '}
                      loudness normalization via the <code>loudnorm</code>{' '}
                      FFmpeg filter. May increase CPU usage during streaming.
                    </Trans>
                  )}
                </FormHelperText>
              </FormControl>
            )}
          />
        </Grid>
      </Grid>
      {showAdvancedSettings && (
        <form.Subscribe
          children={(state) => {
            const hasOneAdvancedSetting = !!state.values.audioLoudnormConfig;
            if (!hasOneAdvancedSetting) {
              return null;
            }

            return (
              <Stack>
                <Typography component="h6" variant="h6" mb={1}>
                  <Trans>Advanced Video Options</Trans>
                </Typography>
                <Typography variant="body2" sx={{ mb: 2 }}>
                  <Trans>
                    Advanced options relating to audio. In general, do not
                    change these unless you know what you are doing!
                  </Trans>
                </Typography>
                {!!state.values.audioLoudnormConfig && (
                  <>
                    <Typography sx={{ mb: 1 }}>
                      <Trans>Loudnorm Options</Trans>
                    </Typography>
                    <Stack direction={{ sm: 'column', md: 'row' }} spacing={2}>
                      <form.AppField
                        name="audioLoudnormConfig.i"
                        children={(field) => (
                          <field.BasicTextInput
                            fullWidth
                            label={t`Loudness Target`}
                            helperText="[-70.0, -5.0]"
                          />
                        )}
                      />
                      <form.AppField
                        name="audioLoudnormConfig.lra"
                        children={(field) => (
                          <field.BasicTextInput
                            fullWidth
                            label={t`Loudness Range Target`}
                            helperText="[1.0, 50.0]"
                          />
                        )}
                      />
                      <form.AppField
                        name="audioLoudnormConfig.tp"
                        children={(field) => (
                          <field.BasicTextInput
                            fullWidth
                            label={t`Max True Peak`}
                            helperText="[-9.0, 0.0]"
                          />
                        )}
                      />
                    </Stack>
                  </>
                )}
              </Stack>
            );
          }}
        />
      )}
    </Stack>
  );
};

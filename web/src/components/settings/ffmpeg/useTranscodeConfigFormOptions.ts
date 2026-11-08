import { t } from '@lingui/core/macro';
import { formOptions } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TranscodeConfig } from '@tunarr/types';
import { TranscodeConfigSchema } from '@tunarr/types/schemas';
import { useSnackbar } from 'notistack';
import type z from 'zod';
import {
  getApiEtvTranscodeConfigsByIdCompatibilityQueryKey,
  getApiTranscodeConfigsQueryKey,
  postApiTranscodeConfigsMutation,
  putApiTranscodeConfigsByIdMutation,
} from '../../../generated/@tanstack/react-query.gen.ts';
import { Ac3MaxChannels, Ac3SampleRatesKhz } from './nextTranscodeSupport.ts';

type Opts = {
  initialConfig: z.input<typeof TranscodeConfigSchema>;
  isNew?: boolean;
  onSave: (newConfig: TranscodeConfig) => void;
  // Called after a new config is created, e.g. to move to its edit page.
  onCreated?: (newConfig: TranscodeConfig) => void;
};

// The server accepts any number for these fields, but FFmpeg's AC-3 encoder
// refuses to open outside them, so the form won't save such a profile.
const TranscodeConfigFormSchema = TranscodeConfigSchema.superRefine(
  (config, ctx) => {
    if (config.audioFormat !== 'ac3') return;
    if (
      !(Ac3SampleRatesKhz as readonly number[]).includes(
        Number(config.audioSampleRate),
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['audioSampleRate'],
        message: t`AC-3 supports 32, 44.1 or 48 kHz.`,
      });
    }
    if (Number(config.audioChannels) > Ac3MaxChannels) {
      ctx.addIssue({
        code: 'custom',
        path: ['audioChannels'],
        message: t`AC-3 carries at most 6 channels (5.1).`,
      });
    }
  },
);

export const useBaseTranscodeConfigFormOptions = (
  initialConfig: z.input<typeof TranscodeConfigSchema>,
) => {
  return formOptions({
    defaultValues: initialConfig,
    // mode: 'onChange',
    validators: {
      onChange: TranscodeConfigFormSchema,
    },
  });
};

export const useTranscodeConfigFormOptions = ({
  initialConfig,
  onSave,
  onCreated,
  isNew,
}: Opts) => {
  const snackbar = useSnackbar();
  const baseOpts = useBaseTranscodeConfigFormOptions(initialConfig);
  const queryClient = useQueryClient();

  const updateConfigMutation = useMutation({
    ...putApiTranscodeConfigsByIdMutation(),
    onSuccess: (ret) => {
      snackbar.enqueueSnackbar(t`Successfully saved config!`, {
        variant: 'success',
      });
      onSave(ret);
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: getApiTranscodeConfigsQueryKey(),
          exact: false,
        }),

        // A saved codec change moves the config in or out of what the ErsatzTV
        // next backend accepts, so the notice has to re-read it.
        queryClient.invalidateQueries({
          queryKey: getApiEtvTranscodeConfigsByIdCompatibilityQueryKey({
            path: { id: ret.id },
          }),
          exact: false,
        }),
      ]);
    },
    onError: (e) => {
      console.error(e);
      snackbar.enqueueSnackbar(
        t`Error while saving transcode config. See console log for details.`,
        {
          variant: 'error',
        },
      );
    },
  });

  const newConfigMutation = useMutation({
    ...postApiTranscodeConfigsMutation(),
    onSuccess: async (ret) => {
      snackbar.enqueueSnackbar(t`Successfully saved config!`, {
        variant: 'success',
      });
      onSave(ret);
      await queryClient.invalidateQueries({
        queryKey: getApiTranscodeConfigsQueryKey(),
        exact: false,
      });
      onCreated?.(ret);
    },
    onError: (e) => {
      console.error(e);
      snackbar.enqueueSnackbar(
        t`Error while saving transcode config. See console log for details.`,
        {
          variant: 'error',
        },
      );
    },
  });

  return formOptions({
    ...baseOpts,
    onSubmit: (config) => {
      const parsedConfig = TranscodeConfigSchema.parse(config.value);
      if (isNew) {
        newConfigMutation.mutate({ body: parsedConfig });
      } else {
        updateConfigMutation.mutate({
          path: { id: initialConfig.id },
          body: parsedConfig,
        });
      }
    },
  });
};

import { getSpelunkrFeedsOptions } from '@/generated/@tanstack/react-query.gen.ts';
import UnsavedNavigationAlert from '@/components/settings/UnsavedNavigationAlert.tsx';
import { toChannelUpdateRequest } from '@/helpers/channelUpdateRequest.ts';
import { DefaultChannel } from '@/helpers/constants.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import { Alert, Badge, Button, MenuItem, TextField } from '@mui/material';
import { isAxiosError } from 'axios';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type {
  Channel,
  SaveableChannel,
  SubtitlePreference,
  TranscodeConfig,
} from '@tunarr/types';
import { isEmpty, isNil, keys, map, reject, some } from 'lodash-es';
import { useCallback, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  FormProvider,
  useController,
  useForm,
  type SubmitErrorHandler,
  type SubmitHandler,
} from 'react-hook-form';
import type { DeepRequired, NonEmptyArray } from 'ts-essentials';
import { invalidateTaggedQueries } from '../../helpers/queryUtil.ts';
import { isNonEmptyString } from '../../helpers/util.ts';
import { useCreateChannel } from '../../hooks/useCreateChannel.ts';
import { useUpdateChannel } from '../../hooks/useUpdateChannel.ts';
import {
  EtvNextRoutableModes,
  isNextPlayable,
} from '../settings/ffmpeg/nextTranscodeSupport.ts';
import ChannelEditActions from './ChannelEditActions.tsx';
import ChannelEpgConfig from './ChannelEpgConfig.tsx';
import { ChannelFlexConfig } from './ChannelFlexConfig.tsx';
import { ChannelLiveRelaySettings } from './ChannelLiveRelaySettings.tsx';
import { ChannelPropertiesEditor } from './ChannelPropertiesEditor.tsx';
import ChannelTranscodingConfig, {
  ChannelTranscodeProfileSelect,
} from './ChannelTranscodingConfig.tsx';
import {
  EditChannelTabPanel,
  type EditChannelTabProps,
  type EditChannelTabs,
} from './EditChannelTabPanel.tsx';
import {
  firstErrorPath,
  firstTabWithError,
  focusField,
  tabId,
  tabPanelId,
} from './editChannelTabs.ts';

function getDefaultFormValues(
  channel: Channel,
): DeepRequired<Omit<SaveableChannel, 'crt' | 'creditSqueeze'>> &
  Pick<SaveableChannel, 'crt' | 'creditSqueeze'> {
  return {
    ...channel,
    advanceAtFinalCredits: channel.advanceAtFinalCredits ?? false,
    streamMode: channel.streamMode ?? 'hls',
    fillerCollections: channel.fillerCollections ?? [],
    fillerRepeatCooldown:
      (!isNil(channel.fillerRepeatCooldown)
        ? channel.fillerRepeatCooldown
        : DefaultChannel.fillerRepeatCooldown!) / 1000,
    guideFlexTitle: channel.guideFlexTitle ?? '',
    guideMinimumDuration: channel.guideMinimumDuration / 1000,
    offline: {
      ...channel.offline,
      picture: channel.offline.picture ?? DefaultChannel.offline.picture ?? '',
      soundtrack:
        channel.offline.soundtrack ?? DefaultChannel.offline.soundtrack ?? '',
    },
    watermark: {
      ...(channel.watermark ?? {}),
      enabled: channel.watermark?.enabled ?? false,
      url: channel.watermark?.url ?? '',
      width: channel.watermark?.width ?? 10,
      horizontalMargin: channel.watermark?.horizontalMargin ?? 1,
      verticalMargin: channel.watermark?.verticalMargin ?? 1,
      fixedSize: channel.watermark?.fixedSize ?? false,
      animated: channel.watermark?.animated ?? false,
      duration: channel.watermark?.duration ?? 0,
      position: channel.watermark?.position ?? 'bottom-right',
      opacity: channel.watermark?.opacity ?? 100,
      fadeConfig: channel.watermark?.fadeConfig?.map((conf) => ({
        ...conf,
        leadingEdge: conf.leadingEdge ?? false,
        programType: conf.programType ?? 'episode',
      })) ?? [
        {
          periodMins: 0,
          leadingEdge: true,
          programType: 'episode', // Unused
        },
      ],
    },
    icon: {
      ...channel.icon,
      useDefaultIconFallback: channel.icon?.useDefaultIconFallback ?? true,
    },
    onDemand: {
      enabled: channel.onDemand.enabled,
    },
    subtitlesEnabled: channel.subtitlesEnabled,
    subtitleDelivery: channel.subtitleDelivery ?? 'global',
    useEtvNext: channel.useEtvNext,
    subtitlePreferences: channel.subtitlePreferences ?? [],
    streamSelectionProfileId: channel.streamSelectionProfileId ?? null,
  };
}

const EditChannelTabsProps: EditChannelTabProps[] = [
  {
    value: 'properties',
    description: 'Properties',
    fields: ['number', 'name', 'groupTitle', 'icon'],
  },
  {
    value: 'flex',
    description: 'Flex',
    fields: ['offline', 'fillerCollections', 'fillerRepeatCooldown'],
  },
  {
    value: 'epg',
    description: 'EPG',
    fields: ['stealth', 'guideFlexTitle', 'guideMinimumDuration'],
  },
  {
    value: 'ffmpeg',
    description: 'Streaming',
    fields: [
      'watermark',
      'streamMode',
      'subtitleDelivery',
      'useEtvNext',
      'transcodeConfigId',
      'streamSelectionProfileId',
    ],
  },
];

export function EditChannelForm({
  channel,
  transcodeConfigs,
  isNew,
  initialTab,
}: EditChannelFormProps) {
  const { t } = useLingui();
  const navigate = useNavigate({
    from: isNew ? '/channels/new' : '/channels/$channelId/edit',
  });
  const [currentTab, setCurrentTab] = useState<EditChannelTabs>(
    initialTab ?? 'properties',
  );

  const formMethods = useForm<SaveableChannel>({
    mode: 'onChange',
    // Change this so we only load the form on initial...
    defaultValues: getDefaultFormValues(channel),
  });

  // The Streaming tab mounts on first visit. Validate the profile on every save.
  const { field: profileField } = useController({
    control: formMethods.control,
    name: 'transcodeConfigId',
    rules: {
      // SIGNPOST(native-retirement): a channel on Next can't save a profile
      // Next can't play; this goes once such profiles can't be chosen.
      validate: (id, values) => {
        if (
          !values.useEtvNext ||
          !EtvNextRoutableModes.includes(values.streamMode)
        ) {
          return true;
        }
        const profile = transcodeConfigs.find((config) => config.id === id);
        return (
          !profile ||
          isNextPlayable(profile) ||
          t`ErsatzTV next can't play this profile.`
        );
      },
    },
  });
  const queryClient = useQueryClient();
  const [source, setSource] = useState<'library' | `spelunkr:${string}`>(
    'library',
  );
  const spelunkr = useQuery({
    ...getSpelunkrFeedsOptions(),
    enabled: isNew,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [creationError, setCreationError] = useState<string>();

  const createUpdateSuccessCallback = useCallback(
    async (data: Channel) => {
      formMethods.reset(getDefaultFormValues(data), {
        keepDefaultValues: false,
        keepDirty: false,
      });

      await queryClient.invalidateQueries({
        predicate: invalidateTaggedQueries('Channels'),
      });

      if (isNew) {
        navigate({
          to:
            source === 'library'
              ? `/channels/$channelId/programming`
              : `/channels/$channelId`,
          params: { channelId: data.id },
        }).catch(console.warn);
      }
    },
    [formMethods, isNew, navigate, queryClient, source],
  );

  const updateChannelMutation = useUpdateChannel({
    onSuccess: createUpdateSuccessCallback,
  });

  const createChannelMutation = useCreateChannel({
    onSuccess: createUpdateSuccessCallback,
  });

  const formIsValid = formMethods.formState.isValid;
  const formErrorKeys = keys(
    formMethods.formState.errors,
  ) as (keyof SaveableChannel)[];
  const formIsDirty = formMethods.formState.isDirty;

  const onSubmit: SubmitHandler<SaveableChannel> = async (data) => {
    const fadeConfigs = reject(
      data.watermark?.fadeConfig,
      (conf) => conf.periodMins <= 0,
    );

    const preferences =
      !data.subtitlePreferences || data.subtitlePreferences.length === 0
        ? undefined
        : map(data.subtitlePreferences, (pref, idx) => ({
            ...pref,
            priority: idx,
          }));

    const dataTransform = {
      ...data,
      // Transform this to milliseconds before we send it over
      guideMinimumDuration: data.guideMinimumDuration * 1000,
      fillerRepeatCooldown: !isNil(data.fillerRepeatCooldown)
        ? data.fillerRepeatCooldown * 1000
        : undefined,
      guideFlexTitle: isNonEmptyString(data.guideFlexTitle)
        ? data.guideFlexTitle
        : undefined,
      fillerCollections: data.fillerCollections,
      watermark: data.watermark
        ? {
            ...data.watermark,
            enabled: !!data.watermark.enabled,
            fadeConfig: isEmpty(fadeConfigs) ? undefined : fadeConfigs,
          }
        : undefined,
      subtitlePreferences: preferences as NonEmptyArray<SubtitlePreference>,
    } satisfies SaveableChannel;

    if (isNew) {
      setCreationError(undefined);
      try {
        await createChannelMutation.mutateAsync({
          body: {
            type: 'new',
            channel: dataTransform,
            ...(source !== 'library'
              ? {
                  liveRelay: {
                    source: 'spelunkr' as const,
                    feed: source.slice('spelunkr:'.length),
                  },
                }
              : {}),
          },
        });
      } catch (error) {
        const message: unknown = isAxiosError<{ error?: unknown }>(error)
          ? error.response?.data?.error
          : undefined;
        setCreationError(
          typeof message === 'string'
            ? message
            : t`Could not create the channel. Check the settings and try again.`,
        );
      }
    } else {
      updateChannelMutation.mutate({
        path: { id: channel.id },
        body: toChannelUpdateRequest(
          dataTransform,
          formMethods.formState.defaultValues,
        ),
      });
    }
  };

  const switchTab = (newValue: EditChannelTabs) => {
    if (newValue !== currentTab) {
      setCurrentTab(newValue);
      // Don't enable routing for new channel, yet.
      if (!isNew) {
        navigate({
          replace: true,
          search: { tab: newValue === 'properties' ? undefined : newValue },
        }).catch(console.warn);
      }
    }
  };

  const handleChange = (_: React.SyntheticEvent, newValue: EditChannelTabs) =>
    switchTab(newValue);

  // Visited tabs stay mounted, so an error can sit in a hidden tab. Show that
  // tab, then focus the field, because focus does nothing inside a hidden panel.
  const onInvalid: SubmitErrorHandler<SaveableChannel> = (errors) => {
    const tab = firstTabWithError(EditChannelTabsProps, keys(errors));
    const fields = EditChannelTabsProps.find((t) => t.value === tab)?.fields;
    if (tab === undefined || fields === undefined) {
      return;
    }

    flushSync(() => switchTab(tab));
    const path = firstErrorPath(errors, fields);
    const panel = document.getElementById(tabPanelId(tab));
    if (path !== undefined && panel) {
      focusField(panel, path);
    }
  };

  const tabDescriptions: Record<string, string> = {
    Properties: t`Properties`,
    Flex: t`Flex`,
    EPG: t`EPG`,
    Streaming: t`Streaming`,
  };

  const renderTab = (tab: EditChannelTabProps) => {
    const hasError = some(formErrorKeys, (k) => tab.fields.includes(k));
    return (
      <Tab
        key={tab.value}
        id={tabId(tab.value)}
        aria-controls={tabPanelId(tab.value)}
        disabled={isNew && tab.value !== currentTab && !formIsValid}
        value={tab.value}
        label={
          <Badge
            color="error"
            variant="dot"
            slotProps={{ badge: { style: { right: -3, top: -3 } } }}
            invisible={!hasError}
          >
            {tabDescriptions[tab.description] ?? tab.description}
          </Badge>
        }
      />
    );
  };

  return (
    <Paper sx={{ p: 2 }}>
      <Box sx={{ borderColor: 'primary', borderBottom: 1 }}>
        <Tabs
          value={currentTab}
          onChange={handleChange}
          variant="scrollable"
          allowScrollButtonsMobile
        >
          {EditChannelTabsProps.map(renderTab)}
        </Tabs>
      </Box>
      <FormProvider {...formMethods}>
        <Box
          component="form"
          onSubmit={formMethods.handleSubmit(onSubmit, onInvalid)}
        >
          <EditChannelTabPanel value="properties" currentValue={currentTab}>
            {isNew && (
              <Box sx={{ mb: 3 }}>
                <TextField
                  select
                  fullWidth
                  label={t`Channel source`}
                  value={source}
                  disabled={formMethods.formState.isSubmitting}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value !== 'library' && !value.startsWith('spelunkr:'))
                      return;
                    setSource(value as 'library' | `spelunkr:${string}`);
                    setCreationError(undefined);
                    if (value !== 'library') {
                      formMethods.setValue('streamMode', 'hls', {
                        shouldDirty: true,
                      });
                      formMethods.setValue('useEtvNext', true, {
                        shouldDirty: true,
                      });
                    }
                  }}
                  helperText={
                    source === 'library'
                      ? t`Add programs from your library after saving. Toonami Aftermath is configured under Streaming after saving an empty channel.`
                      : t`Follows Spelunkr's live schedule, with guide entries and a silent card during breaks. HLS and ErsatzTV next are selected for this source. Tunarr checks the feed's schedule compatibility when you save.`
                  }
                >
                  <MenuItem value="library">{t`Library programming`}</MenuItem>
                  {spelunkr.data?.map((feed) => (
                    <MenuItem
                      key={feed.id}
                      value={`spelunkr:${feed.id}`}
                      disabled={!!feed.unavailableReason}
                    >
                      Spelunkr — {feed.name}
                      {feed.unavailableReason
                        ? ` (${feed.unavailableReason})`
                        : ''}
                    </MenuItem>
                  ))}
                  {spelunkr.isPending && (
                    <MenuItem
                      disabled
                    >{t`Loading Spelunkr channels…`}</MenuItem>
                  )}
                </TextField>
                {spelunkr.isError && (
                  <Alert
                    severity="warning"
                    action={
                      <Button
                        onClick={() => void spelunkr.refetch()}
                      >{t`Retry`}</Button>
                    }
                  >{t`Could not load Spelunkr channels. Library programming is still available.`}</Alert>
                )}
                {/* A new channel plays on ErsatzTV next, so its profile is chosen
                    up front with the other basics, from profiles Next can play. */}
                <ChannelTranscodeProfileSelect
                  field={profileField}
                  transcodeConfigs={transcodeConfigs}
                  nextRequired
                  isNew
                />
              </Box>
            )}
            <ChannelPropertiesEditor />
          </EditChannelTabPanel>
          <EditChannelTabPanel value="flex" currentValue={currentTab}>
            <ChannelFlexConfig />
          </EditChannelTabPanel>
          <EditChannelTabPanel value="epg" currentValue={currentTab}>
            <ChannelEpgConfig />
          </EditChannelTabPanel>
          <EditChannelTabPanel value="ffmpeg" currentValue={currentTab}>
            {!isNew && (
              <ChannelLiveRelaySettings
                key={channel.id}
                channelId={channel.id}
                hasUnsavedChanges={formIsDirty}
              />
            )}
            {isNew && source === 'library' && (
              <Alert severity="info" sx={{ mb: 3 }}>
                <Trans>
                  For Toonami Aftermath, save an empty channel, then open Edit →
                  Streaming → Configure live feed. For Spelunkr, select a feed
                  under Properties before saving.
                </Trans>
              </Alert>
            )}
            {isNew && source !== 'library' && (
              <Alert severity="info" sx={{ mb: 3 }}>
                <Trans>
                  Spelunkr needs HLS, ErsatzTV next, and a compatible transcode
                  profile. H.264 with AAC is a simple starting point. Save will
                  create the channel with its feed ready to tune.
                </Trans>
              </Alert>
            )}
            <ChannelTranscodingConfig
              isNew={isNew}
              profileField={profileField}
              transcodeConfigs={transcodeConfigs}
            />
          </EditChannelTabPanel>
          {isNew && creationError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {creationError}
            </Alert>
          )}
          <ChannelEditActions isNewChannel={isNew} />
        </Box>
      </FormProvider>
      {!isNew && (
        <UnsavedNavigationAlert
          isDirty={formIsDirty}
          // Switching tabs only rewrites `?tab=` on this route.
          exceptTargetPaths={['/channels/$channelId/edit']}
        />
      )}
    </Paper>
  );
}
type EditChannelFormProps = {
  channel: Channel;
  initialTab?: EditChannelTabs;
  isNew: boolean;
  transcodeConfigs: TranscodeConfig[];
};

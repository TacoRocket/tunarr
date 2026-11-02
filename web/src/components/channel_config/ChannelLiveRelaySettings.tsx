import {
  getApiChannelsByIdExperimentalLiveRelayOptions,
  getSpelunkrFeedsOptions,
  putApiChannelsByIdExperimentalLiveRelayMutation,
} from '@/generated/@tanstack/react-query.gen.ts';
import type { GetApiChannelsByIdExperimentalLiveRelayResponse } from '@/generated/types.gen.ts';
import { invalidateTaggedQueries } from '@/helpers/queryUtil.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useState } from 'react';

type Feed = Extract<
  NonNullable<GetApiChannelsByIdExperimentalLiveRelayResponse>,
  { source: 'toonami-aftermath' }
>['feed'];

export function ChannelLiveRelaySettings({
  channelId,
  hasUnsavedChanges,
}: {
  channelId: string;
  hasUnsavedChanges: boolean;
}) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const snackbar = useSnackbar();
  const options = getApiChannelsByIdExperimentalLiveRelayOptions({
    path: { id: channelId },
  });
  const relay = useQuery(options);
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<
    Feed | 'off' | `spelunkr:${string}`
  >('off');
  const feeds: Record<Feed, string> = {
    est: t`Toonami Aftermath East`,
    pst: t`Toonami Aftermath West`,
    'snick-est': t`Snickelodeon East`,
    'snick-pst': t`Snickelodeon West`,
    mtv97: t`MTV97`,
    movies: t`Movies`,
    radio: t`Toonami Aftermath Radio`,
  };
  const spelunkr = useQuery({
    ...getSpelunkrFeedsOptions(),
    enabled: open || relay.data?.source === 'spelunkr',
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const savedSelection =
    relay.data?.source === 'spelunkr'
      ? (`spelunkr:${relay.data.feed}` as const)
      : (relay.data?.feed ?? 'off');
  const savedName =
    relay.data?.source === 'spelunkr'
      ? `Spelunkr — ${spelunkr.data?.find((feed) => feed.id === relay.data?.feed)?.name ?? relay.data.feed}`
      : relay.data?.feed
        ? feeds[relay.data.feed]
        : t`Off`;
  const save = useMutation({
    ...putApiChannelsByIdExperimentalLiveRelayMutation(),
    onSuccess: async (data) => {
      queryClient.setQueryData(options.queryKey, data);
      await queryClient.invalidateQueries({
        predicate: invalidateTaggedQueries('Channels'),
      });
      setOpen(false);
      snackbar.enqueueSnackbar(t`Live feed saved`, { variant: 'success' });
    },
  });

  return (
    <Stack spacing={2} sx={{ mb: 3 }}>
      <Typography variant="h6">
        <Trans>Live feed (experimental)</Trans>
      </Typography>
      <Typography variant="body2">
        <Trans>
          Play a Toonami Aftermath feed or a supported Spelunkr channel instead
          of library programming. Use an empty, standalone channel. Spelunkr
          requires HLS with the ErsatzTV next playback engine.
        </Trans>
      </Typography>
      {relay.isError ? (
        <Alert
          severity="error"
          action={
            <Button type="button" onClick={() => void relay.refetch()}>
              <Trans>Retry</Trans>
            </Button>
          }
        >
          <Trans>Could not load the saved live feed.</Trans>
        </Alert>
      ) : relay.isSuccess ? (
        <Typography variant="body2">
          <Trans>Saved feed:</Trans> {savedName}
        </Typography>
      ) : (
        <Typography variant="body2">
          <Trans>Loading live feed…</Trans>
        </Typography>
      )}
      {hasUnsavedChanges && (
        <Typography variant="body2">
          <Trans>
            Save or discard channel changes before configuring the live feed.
          </Trans>
        </Typography>
      )}
      <Button
        type="button"
        variant="outlined"
        sx={{ alignSelf: 'flex-start' }}
        disabled={!relay.isSuccess || hasUnsavedChanges}
        onClick={() => {
          setSelection(savedSelection);
          save.reset();
          setOpen(true);
        }}
      >
        <Trans>Configure live feed</Trans>
      </Button>
      <Dialog
        open={open}
        onClose={() => {
          if (!save.isPending) setOpen(false);
        }}
        fullWidth
        maxWidth="sm"
        aria-labelledby="live-feed-title"
      >
        <DialogTitle id="live-feed-title">
          <Trans>Configure live feed</Trans>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2">
              <Trans>
                Stop viewers before changing this setting. Saving does not
                restart active playback. This setting saves separately from
                other channel settings.
              </Trans>
            </Typography>
            <TextField
              id="live-feed-selection"
              select
              fullWidth
              label={t`Live feed`}
              value={selection}
              disabled={save.isPending}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === 'off' ||
                  Object.keys(feeds).includes(value) ||
                  spelunkr.data?.some((feed) => value === `spelunkr:${feed.id}`)
                )
                  setSelection(value as Feed | 'off' | `spelunkr:${string}`);
                save.reset();
              }}
            >
              <MenuItem value="off">
                <Trans>Off — use channel programming</Trans>
              </MenuItem>
              {Object.entries(feeds).map(([value, label]) => (
                <MenuItem key={value} value={value}>
                  {label}
                </MenuItem>
              ))}
              {spelunkr.data?.map((feed) => (
                <MenuItem
                  key={`spelunkr:${feed.id}`}
                  value={`spelunkr:${feed.id}`}
                  disabled={!!feed.unavailableReason}
                >
                  Spelunkr — {feed.name}
                  {feed.unavailableReason ? ` (${feed.unavailableReason})` : ''}
                </MenuItem>
              ))}
              {relay.data?.source === 'spelunkr' &&
                !spelunkr.data?.some(
                  (feed) => feed.id === relay.data?.feed,
                ) && <MenuItem value={savedSelection}>{savedName}</MenuItem>}
              {spelunkr.isPending && (
                <MenuItem disabled>{t`Loading Spelunkr channels…`}</MenuItem>
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
              >{t`Could not load Spelunkr channels. Your saved feed is unchanged.`}</Alert>
            )}
            {selection.startsWith('spelunkr:') ? (
              <Typography variant="body2">
                <Trans>
                  Spelunkr requires HLS with the ErsatzTV next playback engine.
                  Playback joins the current program at its scheduled position.
                  A silent "We'll Be Right Back" card fills the original break
                  time before the next episode. The guide follows the same
                  schedule. Spelunkr's own cards and music are not included.
                  Tunarr checks the feed's schedule compatibility when you save.
                </Trans>
              </Typography>
            ) : (
              <Typography variant="body2">
                <Trans>
                  For Toonami, choose HLS to transcode, or ErsatzTV next with
                  HLS Direct v2 to keep compatible source video and audio. West
                  feeds are delayed three hours. Some feeds may be unavailable
                  through the public endpoint. The guide uses the source
                  schedule where available, with the channel's usual placeholder
                  title otherwise.
                </Trans>
              </Typography>
            )}
            <Typography variant="body2">
              <Trans>
                Disable the live feed before adding programs or a schedule. Your
                channel name, number, icon and streaming profile stay the same.
              </Trans>
            </Typography>
            {save.isError && (
              <Alert severity="error">
                {save.error.response?.data?.message ??
                  t`Could not save the live feed. Try again.`}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            type="button"
            disabled={save.isPending}
            onClick={() => setOpen(false)}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="button"
            variant="contained"
            loading={save.isPending}
            disabled={selection === savedSelection}
            onClick={() => {
              if (selection === 'off') {
                save.mutate({ path: { id: channelId }, body: null });
              } else if (selection.startsWith('spelunkr:')) {
                save.mutate({
                  path: { id: channelId },
                  body: {
                    source: 'spelunkr',
                    feed: selection.slice('spelunkr:'.length),
                  },
                });
              } else {
                const feed = (Object.keys(feeds) as Feed[]).find(
                  (feed) => feed === selection,
                );
                if (feed)
                  save.mutate({
                    path: { id: channelId },
                    body: { source: 'toonami-aftermath', feed },
                  });
              }
            }}
          >
            <Trans>Save live feed</Trans>
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

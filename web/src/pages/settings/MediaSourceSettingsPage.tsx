import { AddMediaSourceButton } from '@/components/settings/media_source/AddMediaSourceButton.tsx';

import { useMediaSources } from '@/hooks/settingsHooks.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import { Delete, Edit, Refresh, VideoLibrary } from '@mui/icons-material';
import {
  Box,
  Divider,
  FormControlLabel,
  IconButton,
  Link,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query';
import type { MediaSourceSettings } from '@tunarr/types';
import { useSnackbar } from 'notistack';
import { capitalize } from 'lodash-es';
import { useMemo, useState } from 'react';
import { DeleteConfirmationDialog } from '../../components/DeleteConfirmationDialog.tsx';
import { EditMediaSourceLibrariesDialog } from '../../components/settings/media_source/EditMediaSourceLibrariesDialog.tsx';
import { EmbyServerEditDialog } from '../../components/settings/media_source/EmbyServerEditDialog.tsx';
import { JellyfinServerEditDialog } from '../../components/settings/media_source/JelllyfinServerEditDialog.tsx';
import { LocalMediaEditDialog } from '../../components/settings/media_source/LocalMediaEditDialog.tsx';
import { MediaSourceLibrariesChip } from '../../components/settings/media_source/MediaSourceLibrariesChip.tsx';
import { MediaSourceHealthyTableCell } from '../../components/settings/media_source/MediaSourceHealthyTableCell.tsx';
import { PlexServerEditDialog } from '../../components/settings/media_source/PlexServerEditDialog.tsx';
import { DataTable } from '../../components/ui/table/DataTable.tsx';
import { actionsColumn } from '../../components/ui/table/columns.tsx';
import {
  createAppColumnHelper,
  useTunarrTable,
} from '../../components/ui/table/tunarrTable.ts';
import { useStoreBackedTableSettings } from '../../components/ui/table/useStoreBackedTableSettings.ts';
import {
  deleteApiMediaSourcesByIdMutation,
  getApiSettingsMediaSourceOptions,
  putApiSettingsMediaSourceMutation,
  postApiMediaSourcesByIdLibrariesRefreshMutation,
} from '../../generated/@tanstack/react-query.gen.ts';
import { invalidateTaggedQueries } from '../../helpers/queryUtil.ts';
import type { Nullable } from '../../types/util.ts';

const columnHelper = createAppColumnHelper<MediaSourceSettings>();

export default function MediaSourceSettingsPage() {
  const { t } = useLingui();
  const { data: servers } = useMediaSources();
  const tableState = useStoreBackedTableSettings('MediaSourceSettings');

  const [editingMediaSource, setEditingMediaSource] =
    useState<Nullable<MediaSourceSettings>>(null);
  const [editingMediaSourceLibraries, setEditingMediaSourceLibraries] =
    useState<Nullable<MediaSourceSettings>>(null);
  const [deletingMediaSource, setDeletingMediaSource] =
    useState<Nullable<MediaSourceSettings>>(null);

  const queryClient = useQueryClient();

  const settingsQuery = getApiSettingsMediaSourceOptions();
  const { data: settings } = useSuspenseQuery(settingsQuery);
  const { enqueueSnackbar } = useSnackbar();
  const notifications = useMutation({
    ...putApiSettingsMediaSourceMutation(),
    onSuccess: (saved) =>
      queryClient.setQueryData(settingsQuery.queryKey, saved),
    onError: () =>
      enqueueSnackbar(t`Could not save the Plex notification setting.`, {
        variant: 'error',
      }),
  });
  const plexSources = servers.filter((source) => source.type === 'plex');
  const hasPlexLibrary = plexSources.some((source) =>
    source.libraries.some(
      (lib) =>
        lib.enabled &&
        lib.unavailableSince == null &&
        (lib.mediaType === 'movies' || lib.mediaType === 'shows'),
    ),
  );

  const deleteMediaSourceMut = useMutation({
    ...deleteApiMediaSourcesByIdMutation(),
    onSuccess: () => {
      return queryClient.invalidateQueries({
        predicate: invalidateTaggedQueries('Media Source'),
      });
    },
  });

  const { mutate: refreshLibraries } = useMutation({
    ...postApiMediaSourcesByIdLibrariesRefreshMutation(),
    onSuccess: () => {
      return queryClient.invalidateQueries({
        predicate: invalidateTaggedQueries('Media Source'),
      });
    },
  });

  const columns = useMemo(
    () => [
      ...columnHelper.columns([
        columnHelper.accessor(({ type }) => capitalize(type), {
          id: 'type',
          header: t`Type`,
          enableSorting: false,
        }),
        columnHelper.accessor('name', { header: t`Name` }),
        columnHelper.accessor('uri', {
          header: t`URL`,
          cell: ({ getValue, row }) =>
            row.original.type === 'local' ? (
              '-'
            ) : (
              <Link
                href={getValue()}
                sx={{
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
                target="_blank"
              >
                {getValue()}
              </Link>
            ),
        }),
        columnHelper.display({
          id: 'libraries',
          header: t`Libraries`,
          cell: ({ row }) => (
            <MediaSourceLibrariesChip
              mediaSource={row.original}
              onClick={() => setEditingMediaSourceLibraries(row.original)}
            />
          ),
        }),
        columnHelper.display({
          id: 'isHealthy',
          header: t`Healthy?`,
          cell: ({ row }) => (
            <MediaSourceHealthyTableCell mediaSource={row.original} />
          ),
        }),
      ]),
      actionsColumn<MediaSourceSettings>({
        render: ({ original: source }) => (
          <>
            <Tooltip title={t`Edit Media Source`} placement="top">
              <IconButton
                aria-label={t`Edit Media Source`}
                onClick={() => setEditingMediaSource(source)}
              >
                <Edit />
              </IconButton>
            </Tooltip>
            {source.type !== 'local' && (
              <>
                <Tooltip title={t`Refresh Libraries`} placement="top">
                  <IconButton
                    aria-label={t`Refresh Libraries`}
                    onClick={() =>
                      refreshLibraries({
                        path: {
                          id: source.id,
                        },
                      })
                    }
                  >
                    <Refresh />
                  </IconButton>
                </Tooltip>
                <Tooltip title={t`Edit Libraries`} placement="top">
                  <IconButton
                    aria-label={t`Edit Libraries`}
                    onClick={() => setEditingMediaSourceLibraries(source)}
                  >
                    <VideoLibrary />
                  </IconButton>
                </Tooltip>
              </>
            )}
            <IconButton
              aria-label={t`Delete`}
              onClick={() => setDeletingMediaSource(source)}
            >
              <Delete />
            </IconButton>
          </>
        ),
      }),
    ],
    [refreshLibraries, t],
  );

  const table = useTunarrTable({
    columns,
    data: servers,
    ...tableState,
  });

  return (
    <>
      <Stack divider={<Divider />} gap={2}>
        <Box>
          <Stack
            spacing={1}
            direction="row"
            useFlexGap
            sx={{ flexWrap: 'wrap' }}
          >
            <Typography
              variant="h3"
              sx={(theme) => ({
                flexGrow: 1,
                [theme.breakpoints.down('sm')]: {
                  width: '100%',
                },
              })}
            >
              <Trans>Media Sources</Trans>
            </Typography>
            <AddMediaSourceButton />
            <Box sx={{ flexBasis: '100%', width: 0 }}></Box>
            <Typography sx={{ width: '60%' }}>
              <Trans>
                Media Sources are where Tunarr sources your content. Media can
                come from your filesystem or a remote server, like Plex or
                Jellyfin. At least one Media Source is necessary to create
                channels and play media in Tunarr.
              </Trans>
            </Typography>
          </Stack>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', mb: 1 }}></Box>
          <DataTable table={table} aria-label={t`Media Sources`} />
        </Box>
        <Box>
          <FormControlLabel
            label={t`Refresh libraries when Plex reports changes`}
            control={
              <Switch
                checked={settings.plexNotificationsEnabled}
                disabled={notifications.isPending}
                onChange={(_, checked) =>
                  notifications.mutate({
                    body: { plexNotificationsEnabled: checked },
                  })
                }
                slotProps={{
                  input: { 'aria-describedby': 'plex-notifications-help' },
                }}
              />
            }
          />
          <Typography
            id="plex-notifications-help"
            variant="body2"
            color="text.secondary"
          >
            {plexSources.length === 0
              ? t`Choose Add → Plex (Auto) or Plex (Manual), then enable a movie or TV library to receive updates.`
              : !hasPlexLibrary
                ? t`Use Edit Libraries on your Plex source to enable an available movie or TV library.`
                : t`Updates apply to enabled Plex movie and TV libraries between scheduled scans.`}
          </Typography>
        </Box>
      </Stack>
      {editingMediaSource?.type === 'plex' && (
        <PlexServerEditDialog
          open
          onClose={() => setEditingMediaSource(null)}
          server={editingMediaSource}
        />
      )}
      {editingMediaSource?.type === 'jellyfin' && (
        <JellyfinServerEditDialog
          open
          onClose={() => setEditingMediaSource(null)}
          server={editingMediaSource}
        />
      )}
      {editingMediaSource?.type === 'emby' && (
        <EmbyServerEditDialog
          open
          onClose={() => setEditingMediaSource(null)}
          server={editingMediaSource}
        />
      )}
      {editingMediaSource?.type === 'local' && (
        <LocalMediaEditDialog
          open
          onClose={() => setEditingMediaSource(null)}
          source={editingMediaSource}
        />
      )}
      <EditMediaSourceLibrariesDialog
        open={!!editingMediaSourceLibraries}
        mediaSource={editingMediaSourceLibraries}
        onClose={() => setEditingMediaSourceLibraries(null)}
      />
      <DeleteConfirmationDialog
        open={!!deletingMediaSource}
        onClose={() => setDeletingMediaSource(null)}
        title={t`Delete Media Source "${deletingMediaSource?.name}"?`}
        body={t`Deleting a media source will remove all of its associated programs from Tunarr.`}
        onConfirm={() => {
          if (deletingMediaSource) {
            deleteMediaSourceMut.mutate({
              path: { id: deletingMediaSource.id },
            });
          }
        }}
      />
    </>
  );
}

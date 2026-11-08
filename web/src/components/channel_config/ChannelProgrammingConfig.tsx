import { useUpdateChannel } from '@/hooks/useUpdateChannel.ts';
import { channelQuery } from '@/hooks/useChannels.ts';
import { getApiErrorMessage } from '@/helpers/apiError.ts';
import { useUpdateLineup } from '@/hooks/useUpdateLineup.ts';
import {
  resetLineup,
  setCurrentChannel,
} from '@/store/channelEditor/actions.ts';
import useStore from '@/store/index.ts';
import { useChannelEditor } from '@/store/selectors.ts';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  CalendarViewDay,
  CalendarViewMonth,
  CalendarViewWeek,
  List,
  Save,
  Undo,
} from '@mui/icons-material';
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import dayjs, { type Dayjs } from 'dayjs';
import { useQueryClient } from '@tanstack/react-query';
import { isEqual, reject } from 'lodash-es';
import { useSnackbar } from 'notistack';
import { useCallback, useMemo, useState } from 'react';
import type { CalendarState } from '../slot_scheduler/ProgramCalendarView.tsx';
import { ProgramCalendarView } from '../slot_scheduler/ProgramCalendarView.tsx';
import { ProgramDayCalendarView } from '../slot_scheduler/ProgramDayCalendarView.tsx';
import { ProgramWeekCalendarView } from '../slot_scheduler/ProgramWeekCalendarView.tsx';
import AddProgrammingButton from './AddProgrammingButton.tsx';
import ChannelLineupList from './ChannelLineupList.tsx';
import { ChannelProgrammingFlexTools } from './ChannelProgrammingFlexTools.tsx';
import { ChannelProgrammingSort } from './ChannelProgrammingSort.tsx';
import { ChannelProgrammingTools } from './ChannelProgrammingTools.tsx';

type ViewType = 'list' | 'day' | 'week' | 'month';

export function ChannelProgrammingConfig() {
  const {
    currentEntity: channel,
    originalEntity: originalChannel,
    programList: newLineup,
    generatedLineupApplied,
    seedGrowth,
    originalSeedGrowth,
  } = useChannelEditor();
  const theme = useTheme();
  const smallViewport = useMediaQuery(theme.breakpoints.down('sm'));
  const { t } = useLingui();
  const programsDirty = useStore((s) => s.channelEditor.dirty.programs);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const snackbar = useSnackbar();
  const queryClient = useQueryClient();

  const [view, setView] = useState<ViewType>('list');
  const [viewDate, setViewDate] = useState<Dayjs>(dayjs());
  const calendarState = useMemo(
    () =>
      ({
        month: viewDate.month(),
        year: viewDate.year(),
      }) satisfies CalendarState,
    [viewDate],
  );

  const onCalendarStateChange = useCallback((date: CalendarState) => {
    setViewDate((prev) => prev.month(date.month).year(date.year));
  }, []);

  const handleCalendarDaySelect = useCallback((date: Dayjs) => {
    setViewDate(date);
    setView('day');
  }, []);

  const updateLineupMutation = useUpdateLineup();
  const updateChannelMutation = useUpdateChannel();

  const onSave = async () => {
    if (!channel) return;
    setIsSubmitting(true);
    try {
      if (originalChannel && channel.startTime !== originalChannel.startTime) {
        const current = await queryClient.fetchQuery(channelQuery(channel.id));
        const updated = await updateChannelMutation.mutateAsync({
          path: { id: channel.id },
          body: { ...current, startTime: channel.startTime },
        });
        setCurrentChannel(updated);
      }

      const preferEtvNext =
        generatedLineupApplied ||
        (seedGrowth && !isEqual(seedGrowth, originalSeedGrowth));
      await updateLineupMutation.mutateAsync({
        path: { id: channel.id },
        body: {
          type: 'manual',
          lineup: reject(newLineup, (lineupItem) => lineupItem.duration <= 0),
          append: false,
          seedGrowth,
          ...(preferEtvNext && { preferEtvNext: true }),
        },
      });
      snackbar.enqueueSnackbar(t`Programs saved!`, { variant: 'success' });
    } catch (error) {
      const message =
        getApiErrorMessage(error) ??
        (error instanceof Error ? error.message : String(error));
      snackbar.enqueueSnackbar(t`Error saving programs. ${message}`, {
        variant: 'error',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const renderView = () => {
    switch (view) {
      case 'list':
        return (
          <ChannelLineupList
            type="selector"
            virtualListProps={{
              width: '100%',
              height: 600,
              itemSize: smallViewport ? 70 : 35,
            }}
            // listRef={ref}
          />
        );
      case 'day':
        return (
          <ProgramDayCalendarView
            calendarState={viewDate}
            onChange={setViewDate}
          />
        );
      case 'week':
        return (
          <ProgramWeekCalendarView
            calendarState={viewDate}
            onChange={setViewDate}
            onSelectDay={handleCalendarDaySelect}
          />
        );
      case 'month':
        return (
          <ProgramCalendarView
            calendarState={calendarState}
            onChange={onCalendarStateChange}
            onSelectDay={handleCalendarDaySelect}
          />
        );
    }
  };

  return (
    <>
      <Stack gap={2}>
        <Stack direction={{ md: 'column', lg: 'row' }} justifyContent="center">
          <Stack
            direction="row"
            flexGrow={1}
            alignItems={'center'}
            alignSelf={['center']}
            flex={1}
          >
            <Box>
              <ToggleButtonGroup
                value={view}
                exclusive
                onChange={(_, v) => setView(v as ViewType)}
              >
                <Tooltip title={t`List`}>
                  <ToggleButton value="list">
                    <List />
                  </ToggleButton>
                </Tooltip>
                <Tooltip title={t`Day`}>
                  <ToggleButton value="day">
                    <CalendarViewDay />
                  </ToggleButton>
                </Tooltip>
                <Tooltip title={t`Week`}>
                  <ToggleButton value="week">
                    <CalendarViewWeek />
                  </ToggleButton>
                </Tooltip>
                <Tooltip title={t`Month`}>
                  <ToggleButton value="month">
                    <CalendarViewMonth />
                  </ToggleButton>
                </Tooltip>
              </ToggleButtonGroup>
            </Box>
          </Stack>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            gap={{ xs: 1 }}
            sx={{
              display: 'flex',
              flexWrap: { sm: 'wrap' },
              columnGap: 1,
              alignItems: 'center',
              justifyContent: { sm: 'flex-end' },
              alignSelf: ['center'],
              mt: { xs: 1 },
            }}
          >
            <ChannelProgrammingTools />
            <ChannelProgrammingSort />
            <ChannelProgrammingFlexTools />
            <AddProgrammingButton />
            <Divider sx={{ mx: 1 }} orientation="vertical" flexItem />

            {programsDirty && (
              <Tooltip
                title={t`Reset changes made to the channel's lineup`}
                placement="top"
              >
                {smallViewport ? (
                  <IconButton
                    onClick={() => resetLineup()}
                    disabled={!programsDirty}
                  >
                    <Undo />
                  </IconButton>
                ) : (
                  <Button
                    onClick={() => resetLineup()}
                    disabled={!programsDirty}
                    startIcon={<Undo />}
                  >
                    <Trans>Reset</Trans>
                  </Button>
                )}
              </Tooltip>
            )}
            {smallViewport ? (
              <IconButton
                onClick={() => onSave()}
                disabled={!programsDirty || isSubmitting}
              >
                {isSubmitting ? (
                  <CircularProgress
                    size="20px"
                    sx={{ mx: 1, color: 'inherit' }}
                  />
                ) : (
                  <Save />
                )}
              </IconButton>
            ) : (
              <Button
                variant="contained"
                onClick={() => onSave()}
                disabled={!programsDirty || isSubmitting}
                startIcon={
                  isSubmitting ? (
                    <CircularProgress
                      size="20px"
                      sx={{ mx: 1, color: 'inherit' }}
                    />
                  ) : (
                    <Save />
                  )
                }
              >
                <Trans>Save</Trans>
              </Button>
            )}
          </Stack>
        </Stack>

        {renderView()}
      </Stack>
    </>
  );
}

import { LiveRelayConfigSchema } from '../db/derived_types/Lineup.ts';
import { liveRelayConfigurationError } from '../stream/LiveRelay.ts';
import { FfmpegInfo } from '@/ffmpeg/ffmpegInfo.js';
import {
  offsetChannelCrt,
  mirrorCrtUpdateError,
  mirrorCreditSqueezeUpdateError,
} from '../db/channel/offsetChannel.ts';
import {
  dbChannelToApiChannel,
  ormChannelToApiChannel,
} from '@/db/converters/channelConverters.js';
import { ReconcileProgramDurationsTask } from '../tasks/ReconcileProgramDurationsTask.ts';
import { autoFactoryKey } from '../types/inject.ts';
import { globalOptions } from '@/globals.js';
import { GlobalScheduler } from '@/services/Scheduler.js';
import { validateSlotGroups } from '@/services/scheduling/slotGroupValidator.js';
import type { UpdateXmlTvTaskRequest } from '@/tasks/UpdateXmlTvTask.js';
import { UpdateXmlTvTask } from '@/tasks/UpdateXmlTvTask.js';
import { OpenDateTimeRange } from '@/types/OpenDateTimeRange.js';
import type { RouterPluginAsyncCallback } from '@/types/serverType.js';
import { deleteIfLocalAndCleared } from '@/util/iconUtil.js';
import { LoggerFactory } from '@/util/logging/LoggerFactory.js';
import { timeNamedAsync } from '@/util/perf.js';
import {
  type Channel,
  type ChannelCreditSqueezeSettings,
  type ChannelStreamMode,
  type ChannelOffset,
  type ChannelSession,
  type CreateChannelRequest,
} from '@tunarr/types';
import {
  BasicIdParamSchema,
  BaseErrorSchema,
  RefreshFillerRequest,
  RefreshFillerResult,
  BasicPagingSchema,
  MaterializedSchedule,
  PagedResult,
  SlotScheduleWithPrograms,
  StrictRandomSlotScheduleSchema,
  StrictTimeSlotScheduleSchema,
  TimeSlotScheduleWithPrograms,
  UpdateChannelProgrammingRequestSchema,
} from '@tunarr/types/api';
import {
  ChannelLineupSchema,
  ChannelOffsetSchema,
  ChannelSchema,
  CondensedChannelProgrammingSchema,
  ContentProgramSchema,
  ContentProgramTypeSchema,
  CreateChannelRequestSchema,
  MusicArtist,
  Show as ShowSchema,
  TerminalProgramSchema,
  TranscodeConfigSchema,
  TvGuideProgramSchema,
  UpdateChannelRequestSchema,
} from '@tunarr/types/schemas';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration.js';
import {
  head,
  isEmpty,
  isNil,
  isNull,
  isUndefined,
  map,
  omit,
  orderBy,
  reduce,
} from 'lodash-es';
import type { MarkRequired } from 'ts-essentials';
import z from 'zod/v4';
import { GetMaterializedChannelScheduleCommand } from '../commands/GetMaterializedChannelScheduleCommand.ts';
import { MaterializeLineupCommand } from '../commands/MaterializeLineupCommand.ts';
import { MaterializeProgramGroupings } from '../commands/MaterializeProgramGroupings.ts';
import { MaterializeProgramsCommand } from '../commands/MaterializeProgramsCommand.ts';
import { RegenerateChannelLineupCommand } from '../commands/RegenerateChannelLineupCommand.ts';
import { RefreshChannelFillerCommand } from '../commands/RefreshChannelFillerCommand.ts';
import { container } from '../container.ts';
import { sessionToApiSession } from '../db/converters/sessionConverter.ts';
import { transcodeConfigOrmToDto } from '../db/converters/transcodeConfigConverters.ts';
import type { ChannelAndLineup } from '../db/interfaces/IChannelDB.ts';
import type { ChannelOrmWithRelations } from '../db/schema/derivedTypes.ts';
import {
  ChannelNotFoundError,
  findBadRequestError,
  ScheduleValidationError,
  unwrapError,
} from '../types/errors.ts';
import { Result } from '../types/result.ts';
import type { ChannelCrtSettings } from '@tunarr/types/schemas';
import type { TranscodeConfigOrm } from '../db/schema/TranscodeConfig.ts';
import { PagingParams, TruthyQueryParam } from '../types/schemas.ts';
import { isNonEmptyString } from '../util/index.ts';
import type { ServerContext } from '../ServerContext.ts';
import { GUIDE_PROGRAM_FIELDS_NOTE } from './guideApi.ts';
import { routesToEtvNext } from '../stream/etv/EtvNextRouting.ts';

dayjs.extend(duration);

function crtConfigurationError(
  crt: ChannelCrtSettings | null | undefined,
  streamMode: string,
  config: TranscodeConfigOrm,
): string | undefined {
  if (!crt?.enabled) return;
  if (
    !['hls', 'hls_slower', 'mpegts'].includes(streamMode) ||
    config.hardwareAccelerationMode !== 'vaapi' ||
    config.disableHardwareEncoding ||
    config.disableHardwareFilters
  ) {
    return 'CRT requires a transcoded channel with VAAPI encoding and hardware filters enabled.';
  }
  return;
}

async function creditSqueezeConfigurationError(
  creditSqueeze: ChannelCreditSqueezeSettings | null | undefined,
  advanceAtFinalCredits: boolean | undefined,
  streamMode: ChannelStreamMode,
  config: TranscodeConfigOrm,
  useEtvNext: boolean,
  etvNextEnabled: boolean,
): Promise<string | undefined> {
  if (!creditSqueeze?.enabled) return;
  if (
    creditSqueeze.advertisementFillerListIds?.length &&
    !routesToEtvNext(streamMode, etvNextEnabled, useEtvNext)
  ) {
    return 'Moving credit advertisements require the ErsatzTV next backend.';
  }
  if (advanceAtFinalCredits) {
    return 'Disable advance at final credits before enabling credit squeeze.';
  }
  if (
    !['hls', 'hls_slower', 'mpegts'].includes(streamMode) ||
    config.hardwareAccelerationMode !== 'vaapi' ||
    config.disableHardwareEncoding ||
    config.disableHardwareFilters
  ) {
    return 'Credit squeeze requires a transcoded channel with VAAPI encoding and hardware filters enabled.';
  }
  if (!(await container.get(FfmpegInfo).supportsTimestampPreservingConcat())) {
    return 'Credit squeeze requires FFmpeg with concat preserve_ts support.';
  }
  return;
}

const ChannelLineupQuery = z.object({
  // `.optional()` must sit outside the pipe. Inside, it only lets `undefined`
  // through the left half and `z.coerce.date()` still runs on it; and because
  // the pipe's output is non-optional, zod does not treat the key as optional
  // either, so omitting the query string is a 400.
  from: z.iso.datetime().pipe(z.coerce.date()).optional(),
  to: z.iso.datetime().pipe(z.coerce.date()).optional(),
  includePrograms: TruthyQueryParam.default(false),
});

// eslint-disable-next-line @typescript-eslint/require-await
export const channelsApi: RouterPluginAsyncCallback = async (fastify) => {
  const logger = LoggerFactory.child({
    caller: import.meta,
    className: 'ChannelsApi',
  });

  fastify.get(
    '/channels/:id/experimental/live-relay',
    {
      schema: {
        tags: ['Channels'],
        params: BasicIdParamSchema,
        response: {
          200: LiveRelayConfigSchema.nullable(),
          404: BaseErrorSchema,
        },
      },
    },
    async (req, res) => {
      const channel = await req.serverCtx.channelDB.getChannelOrm(
        req.params.id,
      );
      if (!channel)
        return res.status(404).send({ message: 'Channel not found' });
      const lineup = await req.serverCtx.channelDB.loadLineup(channel.uuid);
      return res.send(lineup.liveRelay ?? null);
    },
  );

  fastify.put(
    '/channels/:id/experimental/live-relay',
    {
      schema: {
        tags: ['Channels'],
        params: BasicIdParamSchema,
        body: LiveRelayConfigSchema.nullable(),
        response: {
          200: LiveRelayConfigSchema.nullable(),
          400: BaseErrorSchema,
          404: BaseErrorSchema,
        },
      },
    },
    async (req, res) => {
      const channel = await req.serverCtx.channelDB.getChannelOrm(
        req.params.id,
      );
      if (!channel)
        return res.status(404).send({ message: 'Channel not found' });
      const lineup = await req.serverCtx.channelDB.loadLineup(channel.uuid);
      if (channel.offsetSourceChannelId) {
        return res.status(400).send({
          message: 'Live relay settings belong to a standalone channel',
        });
      }
      const error = req.body
        ? liveRelayConfigurationError(channel, lineup)
        : undefined;
      if (error) {
        return res.status(400).send({ message: error });
      }
      await req.serverCtx.channelDB.updateLineupConfig(
        channel.uuid,
        'liveRelay',
        req.body,
      );
      GlobalScheduler.getScheduledJob(UpdateXmlTvTask.ID)
        .runNow(true, {
          channelId: channel.uuid,
        } satisfies UpdateXmlTvTaskRequest)
        .catch((error) =>
          logger.error(
            error,
            'Error regenerating guide after live feed change',
          ),
        );
      return res.send(req.body);
    },
  );

  fastify.post(
    '/channels/:id/programming/refresh-fillers',
    {
      schema: {
        operationId: 'RefreshChannelFiller',
        description:
          'Reselect saved after-show positions from explicitly named pools, preserving current playback.',
        tags: ['Channels'],
        params: BasicIdParamSchema,
        body: RefreshFillerRequest,
        response: { 200: RefreshFillerResult, 400: BaseErrorSchema },
      },
    },
    async (req, res) => {
      try {
        const result = await container
          .get(RefreshChannelFillerCommand)
          .execute(req.params.id, req.body);
        if (result.refreshedPositions > 0) {
          GlobalScheduler.getScheduledJob(UpdateXmlTvTask.ID)
            .runNow(true, {
              channelId: req.params.id,
            } satisfies UpdateXmlTvTaskRequest)
            .catch((error) =>
              logger.error(
                error,
                'Error regenerating guide after filler refresh',
              ),
            );
        }
        return res.send(result);
      } catch (error) {
        if (error instanceof ScheduleValidationError)
          return res.status(400).send({ message: error.message });
        throw error;
      }
    },
  );

  fastify.addHook('onError', (req, _, error, done) => {
    logger.error({
      error,
      method: req.routeOptions.method,
      url: req.routeOptions.url,
    });
    done();
  });

  fastify.get(
    '/channels',
    {
      schema: {
        operationId: 'getChannels',
        tags: ['Channels'],
        response: {
          200: z.array(ChannelSchema),
          500: z.literal('error'),
        },
      },
    },
    async (req, res) => {
      const channelsAndLineups =
        await req.serverCtx.channelDB.loadAllLineupConfigs();

      const sessionsByChannel =
        req.serverCtx.sessionManager.allSessionsByChannel();

      const result = orderBy(
        map(channelsAndLineups, (channelAndLineup) => {
          const sessions = sessionsByChannel[channelAndLineup.channel.uuid];
          const apiSessions = reduce(
            sessions,
            (prev, session) => {
              if (!session) {
                return prev;
              }
              prev.push(sessionToApiSession(session));
              return prev;
            },
            [] as ChannelSession[],
          );
          return {
            ...ormChannelToApiChannel(channelAndLineup),
            sessions: apiSessions,
          };
        }),
        'number',
      );

      return res.send(result);
    },
  );

  fastify.get(
    '/channels/:id',
    {
      schema: {
        operationId: 'getChannelsByNumberV2',
        tags: ['Channels'],
        params: BasicIdParamSchema,
        response: {
          200: ChannelSchema,
          404: z.void(),
          500: z.void(),
        },
      },
    },
    async (req, res) => {
      try {
        const channelAndLineup =
          await req.serverCtx.channelDB.loadChannelAndLineupOrm(req.params.id);

        if (isNil(channelAndLineup)) {
          return res.status(404).send();
        }

        const [channelFillers, channelSubtitles] = await Promise.all([
          req.serverCtx.fillerDB.getFillersFromChannel(req.params.id),
          req.serverCtx.channelDB.getChannelSubtitlePreferences(req.params.id),
        ]);

        const sessions = req.serverCtx.sessionManager.getAllSessionsForChannel(
          channelAndLineup.channel.uuid,
          true,
        );

        const apiChannel = dbChannelToApiChannel({
          ...channelAndLineup,
          channel: {
            ...channelAndLineup.channel,
            subtitlePreferences: channelSubtitles,
          },
        });

        const channelWithFillers = {
          ...apiChannel,
          fillerCollections: channelFillers.map((cf) => ({
            id: cf.fillerShow.uuid,
            cooldownSeconds: cf.cooldown,
            weight: cf.weight,
          })),
          sessions: sessions.map(sessionToApiSession),
        };
        return res.send(channelWithFillers);
      } catch (err) {
        logger.error(err, req.routeOptions.config.url);
        return res.status(500).send();
      }
    },
  );

  fastify.post(
    '/channels',
    {
      schema: {
        operationId: 'createChannelV2',
        tags: ['Channels'],
        body: CreateChannelRequestSchema,
        response: {
          201: ChannelSchema,
          400: z.object({ error: z.string() }),
          500: z.object({}),
        },
      },
    },
    async (req, res) => {
      const body: CreateChannelRequest = req.body;
      let insertResult: Result<
        ChannelAndLineup<MarkRequired<ChannelOrmWithRelations, 'fillerShows'>>
      >;
      switch (body.type) {
        case 'copy':
          insertResult = await Result.attemptAsync(() =>
            req.serverCtx.channelDB.copyChannel(body.channelId),
          );
          break;
        case 'new': {
          const transcodeConfig = await req.serverCtx.transcodeConfigDB.getById(
            body.channel.transcodeConfigId,
          );
          if (!transcodeConfig) {
            return res.status(400).send({
              error: `Transcode config with ID ${body.channel.transcodeConfigId} not found`,
            });
          }
          const crtError = crtConfigurationError(
            body.channel.crt,
            body.channel.streamMode,
            transcodeConfig,
          );
          if (crtError) return res.status(400).send({ error: crtError });
          const squeezeError = await creditSqueezeConfigurationError(
            body.channel.creditSqueeze,
            body.channel.advanceAtFinalCredits,
            body.channel.streamMode,
            transcodeConfig,
            body.channel.useEtvNext,
            req.serverCtx.featureFlagService.get('ersatzTvNextEnabled'),
          );
          if (squeezeError)
            return res.status(400).send({ error: squeezeError });
          insertResult = await Result.attemptAsync(() =>
            req.serverCtx.channelDB.saveChannel(body.channel),
          );
          break;
        }
      }

      if (insertResult.isFailure()) {
        throw insertResult.error;
      }

      const inserted = insertResult.get();

      GlobalScheduler.getScheduledJob(UpdateXmlTvTask.ID)
        .runNow(true)
        .catch((err) => logger.error(err, 'Error regenerating guide'));
      await req.serverCtx.m3uService.regenerateCache();

      return res.status(201).send(dbChannelToApiChannel(inserted));
    },
  );

  fastify.put(
    '/channels/:id',
    {
      schema: {
        body: UpdateChannelRequestSchema,
        tags: ['Channels'],
        params: z.object({ id: z.string() }),
        response: {
          200: ChannelSchema,
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
          500: z.void(),
        },
      },
    },
    async (req, res) => {
      try {
        const channel = await req.serverCtx.channelDB.getChannelOrm(
          req.params.id,
        );

        if (isNil(channel)) {
          return res
            .status(404)
            .send({ error: `Channel with ID ${req.params.id} not found.` });
        }

        const mirrorPictureError = mirrorCrtUpdateError(channel, req.body.crt);
        if (mirrorPictureError)
          return res.status(400).send({ error: mirrorPictureError });

        const mirrorSqueezeError = mirrorCreditSqueezeUpdateError(
          channel,
          req.body.creditSqueeze,
        );
        if (mirrorSqueezeError)
          return res.status(400).send({ error: mirrorSqueezeError });

        const lineupConfig = await req.serverCtx.channelDB.loadLineupConfig(
          channel.uuid,
        );

        const transcodeConfig = await req.serverCtx.transcodeConfigDB.getById(
          req.body.transcodeConfigId,
        );
        if (!transcodeConfig) {
          return res.status(400).send({
            error: `Transcode config with ID ${req.body.transcodeConfigId} not found`,
          });
        }

        const crtError = crtConfigurationError(
          req.body.crt === undefined ? channel.crt : req.body.crt,
          req.body.streamMode,
          transcodeConfig,
        );
        if (crtError) return res.status(400).send({ error: crtError });

        const squeezeError = await creditSqueezeConfigurationError(
          req.body.creditSqueeze === undefined
            ? channel.creditSqueeze
            : req.body.creditSqueeze,
          req.body.advanceAtFinalCredits ?? channel.advanceAtFinalCredits,
          req.body.streamMode,
          transcodeConfig,
          req.body.useEtvNext,
          req.serverCtx.featureFlagService.get('ersatzTvNextEnabled'),
        );
        if (squeezeError) return res.status(400).send({ error: squeezeError });

        // A source also owns its mirrors' streaming configuration. Check their
        // independent pictures before propagating an incompatible config.
        for (const mirrorId of req.serverCtx.channelDB.getOffsetChannelIds(
          channel.uuid,
        )) {
          const mirror = await req.serverCtx.channelDB.getChannel(mirrorId);
          if (!mirror) continue;
          const mirrorError = crtConfigurationError(
            offsetChannelCrt(
              req.body.crt === undefined ? channel.crt : req.body.crt,
              mirror.offsetPicture,
            ),
            req.body.streamMode,
            transcodeConfig,
          );
          if (mirrorError)
            return res
              .status(400)
              .send({ error: `${mirror.name}: ${mirrorError}` });
        }

        const channelUpdate = {
          ...req.body,
        };

        // If icon is being cleared and the old icon was a local upload, delete it from disk
        try {
          await deleteIfLocalAndCleared(
            channel.icon?.path ?? '',
            req.body.icon?.path ?? '',
            globalOptions().databaseDirectory,
          );
        } catch (e) {
          logger.warn(e, 'Could not delete old channel icon file from disk');
        }

        let updatedChannel = await req.serverCtx.channelDB.updateChannel(
          channel.uuid,
          channelUpdate,
        );
        const subtitlePreferences =
          await req.serverCtx.channelDB.getChannelSubtitlePreferences(
            channel.uuid,
          );

        const needsGuideRegen =
          channel.guideMinimumDuration !==
            updatedChannel.channel.guideMinimumDuration ||
          channel.startTime !== updatedChannel.channel.startTime ||
          isNil(lineupConfig.onDemandConfig) !==
            isNil(updatedChannel.lineup.onDemandConfig);

        if (isNonEmptyString(channel.offsetSourceChannelId)) {
          // updateChannel re-copied the offset channel from its source, which
          // owns its clock and programming; regenerating here would replace
          // the copy.
          await req.serverCtx.guideService.updateCachedChannel(
            channel.uuid,
            true,
          );
        } else if (
          channel.advanceAtFinalCredits !==
          updatedChannel.channel.advanceAtFinalCredits
        ) {
          (
            await container
              .get<
                () => ReconcileProgramDurationsTask
              >(autoFactoryKey(ReconcileProgramDurationsTask))()
              .run({ type: 'channel', channelId: channel.uuid })
          ).getOrThrow();
          const refreshed =
            await req.serverCtx.channelDB.loadChannelAndLineupOrm(channel.uuid);
          if (refreshed) updatedChannel = { ...updatedChannel, ...refreshed };
          await req.serverCtx.guideService.updateCachedChannel(
            channel.uuid,
            true,
          );
        } else if (needsGuideRegen) {
          logger.debug(
            'Regenerating lineup for channel %s after property change',
            channel.uuid,
          );
          await container
            .get<RegenerateChannelLineupCommand>(RegenerateChannelLineupCommand)
            .execute({ channelId: channel.uuid });
        } else {
          await req.serverCtx.guideService.updateCachedChannel(channel.uuid);
        }

        await req.serverCtx.m3uService.regenerateCache();

        const apiChannel = omit(
          dbChannelToApiChannel({
            ...updatedChannel,
            channel: {
              ...updatedChannel.channel,
              subtitlePreferences,
            },
          }),
          'programs',
        );

        return res.send(apiChannel);
      } catch (err) {
        const badRequest = findBadRequestError(err);
        if (badRequest) {
          return res.status(400).send({ error: badRequest.message });
        }
        logger.error(err, req.routeOptions.config.url);
        return res.status(500).send();
      }
    },
  );

  const setChannelOffset = async (
    ctx: ServerContext,
    channelId: string,
    offset: ChannelOffset | null,
  ): Promise<{ channel: Channel } | { status: 400 | 404; message: string }> => {
    const result = await Result.attemptAsync(() =>
      ctx.channelDB.setChannelOffset(channelId, offset),
    );
    if (result.isFailure()) {
      const badRequest = findBadRequestError(result.error);
      if (badRequest) return { status: 400, message: badRequest.message };
      const notFound = unwrapError(result.error);
      if (notFound instanceof ChannelNotFoundError) {
        return { status: 404, message: notFound.message };
      }
      throw result.error;
    }

    GlobalScheduler.getScheduledJob(UpdateXmlTvTask.ID)
      .runNow(true, { channelId } satisfies UpdateXmlTvTaskRequest)
      .catch((error) =>
        logger.error(error, 'Error regenerating guide after offset change'),
      );
    await ctx.m3uService.regenerateCache();

    const channelAndLineup =
      await ctx.channelDB.loadChannelAndLineupOrm(channelId);
    if (!channelAndLineup) {
      return { status: 404, message: `Channel ${channelId} not found` };
    }
    return {
      channel: dbChannelToApiChannel({
        ...channelAndLineup,
        channel: {
          ...channelAndLineup.channel,
          subtitlePreferences:
            await ctx.channelDB.getChannelSubtitlePreferences(channelId),
        },
      }),
    };
  };

  fastify.put(
    '/channels/:id/offset',
    {
      schema: {
        operationId: 'SetChannelOffset',
        description:
          "Make this channel an offset channel: it plays the source channel's lineup this many whole hours later and follows every change to it. Zero hours creates a simultaneous mirror. The source's programming and settings replace this channel's; its identity and explicit picture choice are kept. Omit picture to preserve the existing choice, which defaults to following the source.",
        tags: ['Channels'],
        params: BasicIdParamSchema,
        body: ChannelOffsetSchema,
        response: {
          200: ChannelSchema,
          400: BaseErrorSchema,
          404: BaseErrorSchema,
        },
      },
    },
    async (req, res) => {
      const source = await req.serverCtx.channelDB.getChannel(
        req.body.sourceChannelId,
      );
      const mirror = await req.serverCtx.channelDB.getChannel(req.params.id);
      if (!source || !mirror)
        return res
          .status(404)
          .send({ message: 'Source or mirror channel not found.' });
      const config = await req.serverCtx.transcodeConfigDB.getById(
        source.transcodeConfigId,
      );
      if (!config)
        return res
          .status(400)
          .send({ message: 'Source transcode configuration not found.' });
      const crtError = crtConfigurationError(
        offsetChannelCrt(
          source.crt,
          req.body.picture ??
            (isNonEmptyString(mirror.offsetSourceChannelId)
              ? mirror.offsetPicture
              : null),
        ),
        source.streamMode,
        config,
      );
      if (crtError) return res.status(400).send({ message: crtError });
      const result = await setChannelOffset(
        req.serverCtx,
        req.params.id,
        req.body,
      );
      if ('status' in result) {
        return res.status(result.status).send({ message: result.message });
      }
      return res.send(result.channel);
    },
  );

  fastify.delete(
    '/channels/:id/offset',
    {
      schema: {
        operationId: 'ClearChannelOffset',
        description:
          'Stop following the source channel. The channel keeps the programming it has now and becomes an ordinary channel.',
        tags: ['Channels'],
        params: BasicIdParamSchema,
        response: {
          200: ChannelSchema,
          400: BaseErrorSchema,
          404: BaseErrorSchema,
        },
      },
    },
    async (req, res) => {
      const result = await setChannelOffset(req.serverCtx, req.params.id, null);
      if ('status' in result) {
        return res.status(result.status).send({ message: result.message });
      }
      return res.send(result.channel);
    },
  );

  fastify.delete(
    '/channels/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        tags: ['Channels'],
        response: {
          200: z.void(),
          404: z.void(),
        },
      },
    },
    async (req, res) => {
      const channel = await req.serverCtx.channelDB.getChannel(req.params.id);

      if (isNil(channel)) {
        return res.status(404).send();
      }

      await req.serverCtx.channelDB.deleteChannel(channel.uuid);
      await req.serverCtx.m3uService.regenerateCache();

      try {
        await req.serverCtx.guideService.removeCachedChannel(channel.uuid);
      } catch (e) {
        logger.error(e, 'Error removing channel from guide cache');
      }

      return res.send();
    },
  );

  fastify.get(
    '/channels/:id/programs',
    {
      schema: {
        params: BasicIdParamSchema,
        querystring: z.object({
          ...PagingParams.shape,
          type: ContentProgramTypeSchema.optional(),
        }),
        tags: ['Channels'],
        response: {
          200: PagedResult(z.array(TerminalProgramSchema)),
          404: z.void(),
        },
      },
    },
    async (req, res) => {
      const { results: programs, total } =
        await req.serverCtx.channelDB.getChannelPrograms(
          req.params.id,
          {
            offset: req.query.offset,
            limit: req.query.limit,
          },
          req.query.type,
        );

      const materializer = container.get<MaterializeProgramsCommand>(
        MaterializeProgramsCommand,
      );
      const materialized = await materializer.execute(programs);

      return res.send({
        result: materialized,
        size: materialized.length,
        total,
      });
    },
  );

  fastify.get(
    '/channels/:id/shows',
    {
      schema: {
        params: BasicIdParamSchema,
        querystring: PagingParams,
        response: {
          200: PagedResult(z.array(ShowSchema)),
        },
      },
    },
    async (req, res) => {
      const { total, results: shows } =
        await req.serverCtx.channelDB.getChannelTvShows(
          req.params.id,
          req.query,
        );

      const apiGroupings = await container
        .get<MaterializeProgramGroupings>(MaterializeProgramGroupings)
        .execute(shows);
      const apiShows = apiGroupings.filter((group) => group.type === 'show');

      return res.send({
        total,
        result: apiShows,
        size: apiShows.length,
      });
    },
  );

  fastify.get(
    '/channels/:id/artists',
    {
      schema: {
        params: BasicIdParamSchema,
        querystring: PagingParams,
        response: {
          200: PagedResult(z.array(MusicArtist)),
        },
      },
    },
    async (req, res) => {
      const { total, results: musicArtists } =
        await req.serverCtx.channelDB.getChannelMusicArtists(
          req.params.id,
          req.query,
        );

      const apiGroupings = await container
        .get<MaterializeProgramGroupings>(MaterializeProgramGroupings)
        .execute(musicArtists);
      const artists = apiGroupings.filter((group) => group.type === 'artist');

      return res.send({
        total,
        result: artists,
        size: artists.length,
      });
    },
  );

  fastify.get(
    '/channels/:id/programming',
    {
      schema: {
        params: BasicIdParamSchema,
        querystring: BasicPagingSchema,
        tags: ['Channels'],
        response: {
          200: CondensedChannelProgrammingSchema,
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      const exists = await req.serverCtx.channelDB.channelExists(req.params.id);

      if (!exists) {
        return res.status(404).send({ error: 'Channel Not Found' });
      }

      const apiLineup = await req.serverCtx.channelDB.loadCondensedLineup(
        req.params.id,
        req.query.offset ?? 0,
        req.query.limit ?? -1,
      );

      if (isNil(apiLineup)) {
        return res
          .status(404)
          .send({ error: 'Could not find channel lineup.' });
      }

      // TODO: get rid of this
      return res.serializer(JSON.stringify).send(apiLineup);
    },
  );

  fastify.post(
    '/channels/:id/programming',
    {
      bodyLimit: 1024 * 1024 * 100,
      // Fastify's own validation error is an object, which the string 400
      // schema cannot serialize, so answer it here.
      attachValidation: true,
      schema: {
        params: BasicIdParamSchema,
        tags: ['Channels'],
        body: UpdateChannelProgrammingRequestSchema,
        response: {
          200: CondensedChannelProgrammingSchema,
          400: z.string(),
          404: z.void(),
          500: z.void(),
          501: z.void(),
        },
      },
    },
    async (req, res) => {
      if (req.validationError) {
        return res.status(400).send(req.validationError.message);
      }

      if (isNil(await req.serverCtx.channelDB.getChannel(req.params.id))) {
        return res.status(404).send();
      }

      // The schedule-time-slots / schedule-slots preview endpoints validate
      // slot groups, but this save path persisted whatever schedule it was
      // given verbatim. Run the same validation here and persist the
      // sanitized slots (linkMode stripped from slots without an
      // iterationGroup) so an invalid or unsanitized group can't be saved
      // and then regenerated badly by RegenerateChannelLineupCommand.
      let programmingRequest = req.body;
      if (req.body.type === 'time') {
        const strictSchedule = StrictTimeSlotScheduleSchema.safeParse(
          req.body.schedule,
        );
        if (!strictSchedule.success) {
          return res
            .status(400)
            .send(
              strictSchedule.error.issues
                .map((issue) => issue.message)
                .join('; '),
            );
        }
        const groupValidation = validateSlotGroups(req.body.schedule.slots, {
          scheduleType: 'time',
        });
        if (!groupValidation.valid) {
          return res.status(400).send(groupValidation.errors.join('; '));
        }
        programmingRequest = {
          ...req.body,
          schedule: {
            ...req.body.schedule,
            slots: groupValidation.sanitizedSlots,
          },
        };
      } else if (req.body.type === 'random') {
        const strictSchedule = StrictRandomSlotScheduleSchema.safeParse(
          req.body.schedule,
        );
        if (!strictSchedule.success) {
          return res
            .status(400)
            .send(
              strictSchedule.error.issues
                .map((issue) => issue.message)
                .join('; '),
            );
        }
        const groupValidation = validateSlotGroups(req.body.schedule.slots, {
          scheduleType: 'random',
        });
        if (!groupValidation.valid) {
          return res.status(400).send(groupValidation.errors.join('; '));
        }
        programmingRequest = {
          ...req.body,
          schedule: {
            ...req.body.schedule,
            slots: groupValidation.sanitizedSlots,
          },
        };
      }

      const updateResult = await Result.attemptAsync(() =>
        req.serverCtx.channelDB.updateLineup(req.params.id, programmingRequest),
      );
      if (updateResult.isFailure()) {
        const badRequest = findBadRequestError(updateResult.error);
        if (badRequest) {
          return res.status(400).send(badRequest.message);
        }
        throw unwrapError(updateResult.error);
      }
      const result = updateResult.get();

      if (isNil(result)) {
        return res.status(500).send();
      }

      try {
        // Scope the refresh to the channel we just saved. Without a channel id
        // the task rebuilds every channel's guide and regenerates the whole
        // XMLTV document, which blocks the event loop long enough to stall
        // in-flight HLS segment requests on every other live channel.
        GlobalScheduler.getScheduledJob(UpdateXmlTvTask.ID)
          .runNow(true, {
            channelId: req.params.id,
          } satisfies UpdateXmlTvTaskRequest)
          .catch((err) => logger.error(err, 'Error regenerating guide'));
      } catch (e) {
        logger.error(e, 'Unable to update guide after lineup update');
      }

      // Schedule-generated updates already materialized every program in order
      // to build the lineup, so the response is assembled from that rather than
      // loading it all again. Reloading meant a second relational query over
      // every program plus a second full materialization — about 200ms of
      // blocked event loop on a 2200 item lineup, which is what option (1) in
      // the note that used to live here was worried about.
      //
      // Manual edits still take the long path: the request carries program ids
      // rather than program details, so nothing was materialized.
      const newLineup = await timeNamedAsync(
        'build fresh lineup',
        LoggerFactory.root,
        () =>
          result.materializedPrograms
            ? req.serverCtx.channelDB.condensedLineupFromMaterialized(
                req.params.id,
                result.materializedPrograms,
              )
            : req.serverCtx.channelDB.loadCondensedLineup(req.params.id),
      );

      if (isNil(newLineup)) {
        return res.status(500).send();
      }

      return res.status(200).serializer(JSON.stringify).send(newLineup);
    },
  );

  fastify.get(
    '/channels/:id/fallbacks',
    {
      schema: {
        params: BasicIdParamSchema,
        operationId: 'GetChannelFallbacks',
        description: "Returns a channel's fallback programs.",
        tags: ['Channels'],
        querystring: ChannelLineupQuery,
        response: {
          200: ContentProgramSchema.optional(),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      const fallback = await req.serverCtx.channelDB.getChannelFallbackPrograms(
        req.params.id,
      );
      if (fallback && fallback.mediaSourceId && fallback.libraryId) {
        const mediaSource = await req.serverCtx.mediaSourceDB.getById(
          fallback.mediaSourceId,
        );
        const library = mediaSource?.libraries.find(
          (lib) => lib.uuid === fallback.libraryId,
        );
        const converted =
          req.serverCtx.programConverter.programOrmToContentProgram(
            fallback,
            mediaSource,
            library,
          );
        if (converted) {
          return res.send(converted);
        }
      }
      return res.send();
    },
  );

  fastify.get(
    '/channels/all/lineups',
    {
      schema: {
        description: `Returns every channel's guide. ${GUIDE_PROGRAM_FIELDS_NOTE}`,
        querystring: ChannelLineupQuery,
        tags: ['Channels'],
        response: {
          200: z.array(ChannelLineupSchema),
          400: z.string(),
        },
      },
    },
    async (req, res) => {
      const dateRange = OpenDateTimeRange.create(req.query.from, req.query.to);

      if (isNull(dateRange)) {
        return res.status(400).send('Invalid date range');
      }

      return res
        .status(200)
        .send(await req.serverCtx.guideService.getAllChannelGuides(dateRange));
    },
  );

  fastify.get(
    '/channels/:id/lineup',
    {
      schema: {
        description: `Returns a channel's guide. ${GUIDE_PROGRAM_FIELDS_NOTE}`,
        params: BasicIdParamSchema,
        tags: ['Channels'],
        querystring: ChannelLineupQuery,
        response: {
          200: ChannelLineupSchema,
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      const dateRange = OpenDateTimeRange.create(req.query.from, req.query.to);

      if (isNull(dateRange)) {
        return res.status(400).send({ error: 'Invalid date range' });
      }

      const guide = await req.serverCtx.guideService.getChannelGuide(
        req.params.id,
        dateRange,
      );

      if (isUndefined(guide)) {
        return res.status(404).send({ error: 'Guide data not found' });
      }

      return res.send(guide);
    },
  );

  fastify.get(
    '/channels/:id/now_playing',
    {
      schema: {
        description: `Returns the program airing now on a channel. ${GUIDE_PROGRAM_FIELDS_NOTE}`,
        params: BasicIdParamSchema,
        tags: ['Channels'],
        response: {
          200: TvGuideProgramSchema,
          400: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (req, res) => {
      const now = dayjs();
      const guide = await req.serverCtx.guideService.getChannelGuide(
        req.params.id,
        OpenDateTimeRange.create(now, now.add(1))!,
      );

      if (isUndefined(guide) || isEmpty(guide.programs)) {
        return res.status(404).send({ error: 'Guide data not found' });
      }

      return res.send(head(guide.programs));
    },
  );

  fastify.get(
    '/channels/:id/transcode_config',
    {
      schema: {
        params: z.object({
          id: z.string(),
        }),
        response: {
          200: TranscodeConfigSchema,
        },
      },
    },
    async (req, res) => {
      const config = await req.serverCtx.transcodeConfigDB.getChannelConfig(
        req.params.id,
      );
      return res.send(transcodeConfigOrmToDto(config));
    },
  );

  fastify.post(
    '/channels/:channelId/schedule-time-slots',
    {
      schema: {
        tags: ['Channels'],
        params: z.object({
          channelId: z.string(),
        }),
        body: z.object({
          schedule: StrictTimeSlotScheduleSchema,
        }),
        response: {
          200: TimeSlotScheduleWithPrograms,
          400: z.string(),
          404: z.string(),
        },
      },
    },
    async (req, res) => {
      const channel = await req.serverCtx.channelDB.getChannel(
        req.params.channelId,
      );

      if (!channel) {
        return res
          .status(404)
          .send(`Channel ID ${req.params.channelId} not found`);
      }

      const groupValidation = validateSlotGroups(req.body.schedule.slots, {
        scheduleType: 'time',
      });
      if (!groupValidation.valid) {
        return res.status(400).send(groupValidation.errors.join('; '));
      }

      const sanitizedSchedule = {
        ...req.body.schedule,
        slots: groupValidation.sanitizedSlots,
      };

      const scheduleResult = await Result.attemptAsync(() =>
        req.serverCtx.workerPool.queueTask({
          request: {
            type: 'channel',
            channelId: req.params.channelId,
            schedule: sanitizedSchedule,
            startTime: channel.startTime,
            strictValidation: true,
          },
          type: 'time-slots',
        }),
      );
      if (scheduleResult.isFailure()) {
        const badRequest = findBadRequestError(scheduleResult.error);
        if (badRequest) {
          return res.status(400).send(badRequest.message);
        }
        throw unwrapError(scheduleResult.error);
      }
      const { result } = scheduleResult.get();

      const programsById = await container
        .get(MaterializeLineupCommand)
        .execute({
          lineup: result.lineup,
        });

      return res.serializer(JSON.stringify).send({
        ...result,
        programs: programsById,
      });
    },
  );

  fastify.post(
    '/channels/:channelId/schedule-slots',
    {
      schema: {
        tags: ['Channels'],
        params: z.object({
          channelId: z.string(),
        }),
        body: z.object({
          schedule: StrictRandomSlotScheduleSchema,
        }),
        response: {
          200: SlotScheduleWithPrograms,
          400: z.string(),
          404: z.string(),
        },
      },
    },
    async (req, res) => {
      const channel = await req.serverCtx.channelDB.getChannel(
        req.params.channelId,
      );

      if (!channel) {
        return res
          .status(404)
          .send(`Channel ID ${req.params.channelId} not found`);
      }

      const groupValidation = validateSlotGroups(req.body.schedule.slots, {
        scheduleType: 'random',
      });
      if (!groupValidation.valid) {
        return res.status(400).send(groupValidation.errors.join('; '));
      }

      const sanitizedSchedule = {
        ...req.body.schedule,
        slots: groupValidation.sanitizedSlots,
      };

      const scheduleResult = await Result.attemptAsync(() =>
        req.serverCtx.workerPool.queueTask({
          request: {
            type: 'channel',
            channelId: req.params.channelId,
            schedule: sanitizedSchedule,
            startTime: channel.startTime,
            strictValidation: true,
          },
          type: 'schedule-slots',
        }),
      );
      if (scheduleResult.isFailure()) {
        const badRequest = findBadRequestError(scheduleResult.error);
        if (badRequest) {
          return res.status(400).send(badRequest.message);
        }
        throw unwrapError(scheduleResult.error);
      }
      const { result } = scheduleResult.get();

      const programsById = await container
        .get(MaterializeLineupCommand)
        .execute({
          lineup: result.lineup,
        });

      return res.serializer(JSON.stringify).send({
        ...result,
        programs: programsById,
      });
    },
  );

  fastify.get(
    '/channels/:id/schedule',
    {
      schema: {
        tags: ['Channels', 'Scheduling'],
        params: z.object({
          id: z.uuid(),
        }),
        response: {
          200: z.object({
            schedule: MaterializedSchedule.optional(),
          }),
        },
      },
    },
    async (req, res) => {
      const result = await container
        .get(GetMaterializedChannelScheduleCommand)
        .execute({
          channelId: req.params.id,
        });

      if (!result) {
        return res.send();
      }

      return res.serializer(JSON.stringify).send({ schedule: result });
    },
  );
};

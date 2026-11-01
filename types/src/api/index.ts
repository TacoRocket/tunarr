import { z } from 'zod/v4';
import { FeatureFlagsSchema } from '../FeatureFlags.js';
import {
  LogCategoriesSchema,
  LoggingSettingsSchema,
  LogLevelsSchema,
  LogRollConfigSchema,
  ServerSettingsSchema,
  SystemSettingsSchema,
} from '../SystemSettings.js';
import { JellyfinItemFields, JellyfinItemKind } from '../jellyfin/index.js';
import { TruthyQueryParam } from '../schemas/utilSchemas.js';
import { SearchRequestSchema } from '../schemas/SearchRequest.js';
import {
  SessionConcatStreamModes,
  SessionStreamModes,
  StreamDegradationsSchema,
  StreamRequestReportsSchema,
} from '../schemas/channelSchema.js';
import {
  CondensedChannelProgramSchema,
  CondensedContentProgramSchema,
  CondensedCustomProgramSchema,
  CondensedFillerProgramSchema,
  ContentProgramSchema,
  CustomProgramSchema,
  FlexProgramSchema,
  RedirectProgramSchema,
} from '../schemas/lineups.js';
import {
  Episode,
  ItemOrFolder,
  MusicAlbum,
  MusicTrack,
  Season,
} from '../schemas/programmingSchema.js';
import {
  BackupSettingsSchema,
  EmbyServerSettingsSchema,
  JellyfinServerSettingsSchema,
  LocalMediaSourceSchema,
  PlexServerSettingsSchema,
} from '../schemas/settingsSchemas.js';
import { MaterializedSlot, RandomSlotScheduleSchema } from './RandomSlots.js';
import { MaterializedTimeSlot, TimeSlotScheduleSchema } from './TimeSlots.js';

export * from './CommonSlots.js';
export * from './BlockProgramming.js';
export * from './RefreshFiller.js';
export * from './RandomSlots.js';
export * from './Scheduling.js';
export * from './ShowSchedulingPresets.js';
export * from './TimeSlots.js';
export * from './plexSearch.js';
export * from './search.js';

export const IdPathParamSchema = z.object({
  id: z.string(),
});

export function PagedResult<T extends z.ZodType>(schema: T) {
  return z.object({
    total: z.number(),
    result: schema,
    size: z.number(),
    offset: z.number().optional(),
  });
}

export type PagedResult<T> = {
  total: number;
  result: T;
  size: number;
  offset?: number;
};

export const ChannelNumberParamSchema = z.object({
  number: z.coerce.number(),
});

export const ChannelLineupQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  includePrograms: TruthyQueryParam.default(false),
});

export const LookupExternalProgrammingSchema = z.object({
  externalId: z
    .string()
    .transform((s) => s.split('|', 3) as [string, string, string]),
});

export const BatchLookupExternalProgrammingSchema = z.object({
  externalIds: z.array(z.string()),
});

export const CreateCustomShowRequestSchema = z.object({
  name: z.string(),
  programs: z.array(CondensedContentProgramSchema).default([]),
  syncMediaSourceId: z.string().nullable(),
  syncMediaSourceType: z.enum(['plex']).nullable(),
  syncExternalPlaylistId: z.string().nullable(),
});

export type CreateCustomShowRequest = z.infer<
  typeof CreateCustomShowRequestSchema
>;

// `programs` has no default here. Omitting it leaves membership alone, while
// an explicit list, including an empty one, replaces it.
export const UpdateCustomShowRequestSchema =
  CreateCustomShowRequestSchema.partial().extend({
    programs: z.array(CondensedContentProgramSchema).optional(),
    enableSync: z.boolean(),
  });

export type UpdateCustomShowRequest = z.infer<
  typeof UpdateCustomShowRequestSchema
>;

const FillerListRequestFields = z.object({
  name: z.string(),
  // A filler list with no programs can't contribute anything to a channel or
  // a slot schedule, so don't let one be persisted.
  programs: z
    .array(
      z.discriminatedUnion('type', [ContentProgramSchema, CustomProgramSchema]),
    )
    .min(1, 'A filler list must have at least one program.'),
});

// A list linked to a smart collection takes its programs from the
// collection's results instead of the request.
export const CreateFillerListRequestSchema = FillerListRequestFields.partial({
  programs: true,
})
  .extend({ smartCollectionId: z.uuid().optional() })
  .refine((req) => !!req.programs !== !!req.smartCollectionId, {
    message: 'Provide either programs or smartCollectionId, not both.',
  });

export type CreateFillerListRequest = z.infer<
  typeof CreateFillerListRequestSchema
>;

// smartCollectionId: a UUID links the list, null unlinks it and keeps its
// current programs, and omitting it leaves the link alone.
export const UpdateFillerListRequestSchema =
  FillerListRequestFields.partial().extend({
    smartCollectionId: z.uuid().nullable().optional(),
  });

export const SmartFillerSyncResultSchema = z.object({
  fillerListId: z.string(),
  smartCollectionId: z.string(),
  programCount: z.number(),
  // Shows, seasons, artists and albums the search matched. A filler list
  // holds whole clips, so these are left out rather than expanded.
  skippedGroupings: z.number(),
  // Matched clips that are missing or have no playable duration.
  skippedUnplayable: z.number(),
});

export type SmartFillerSyncResult = z.infer<typeof SmartFillerSyncResultSchema>;

export type UpdateFillerListRequest = z.infer<
  typeof UpdateFillerListRequestSchema
>;

export const BasicIdParamSchema = z.object({
  id: z.string(),
});

export const BasicPagingSchema = z.object({
  offset: z.coerce.number().optional(),
  limit: z.coerce.number().optional(),
});

// A zero-length item can never play, so a saved lineup needs a positive
// duration on every item, content included.
const ManualLineupProgramSchema = z.discriminatedUnion('type', [
  CondensedContentProgramSchema.extend({ duration: z.number().positive() }),
  CondensedCustomProgramSchema,
  CondensedFillerProgramSchema,
  RedirectProgramSchema,
  FlexProgramSchema,
]);

export const ManualProgramLineupSchema = z.object({
  type: z.literal('manual'),
  lineup: ManualLineupProgramSchema.array(),
  append: z.boolean().default(false),
});

export const TimeBasedProgramLineupSchema = z.object({
  type: z.literal('time'),
  // This must be the list of programs BEFORE any scheduling
  // We do this so that we can potentially create longer schedules
  // on the server-side. However, we can filter this list down to only
  // programs included in at least one time slot...
  programs: z.array(z.string()),
  schedule: TimeSlotScheduleSchema,
  seed: z.number().array().optional(),
  discardCount: z.number().optional(),
});

export const RandomSlotProgramLineupSchema = z.object({
  type: z.literal('random'),
  programs: z.array(z.string()),
  schedule: RandomSlotScheduleSchema,
  seed: z.number().array().optional(),
  discardCount: z.number().optional(),
});

export const UpdateChannelProgrammingRequestSchema = z.discriminatedUnion(
  'type',
  [
    ManualProgramLineupSchema,
    TimeBasedProgramLineupSchema,
    RandomSlotProgramLineupSchema,
  ],
);

export type UpdateChannelProgrammingRequest = z.infer<
  typeof UpdateChannelProgrammingRequestSchema
>;

export const UpdateMediaSourceRequestSchema = z.discriminatedUnion('type', [
  PlexServerSettingsSchema.partial({
    sendGuideUpdates: true,
    sendPlayStatusUpdates: true,
    clientIdentifier: true,
  }).omit({ libraries: true }),
  JellyfinServerSettingsSchema.partial({
    sendPlayStatusUpdates: true,
  }).omit({
    libraries: true,
  }),
  EmbyServerSettingsSchema.omit({ libraries: true }),
  LocalMediaSourceSchema.omit({ libraries: true }),
]);

export type UpdateMediaSourceRequest = z.infer<
  typeof UpdateMediaSourceRequestSchema
>;

export const UpdatePlexServerRequestSchema = PlexServerSettingsSchema.partial({
  sendGuideUpdates: true,
  clientIdentifier: true,
  id: true,
});

export type UpdatePlexServerRequest = z.infer<
  typeof UpdatePlexServerRequestSchema
>;

export const InsertMediaSourceRequestSchema = z.discriminatedUnion('type', [
  PlexServerSettingsSchema.partial({
    sendGuideUpdates: true,
    index: true,
    clientIdentifier: true,
  })
    .omit({ id: true, libraries: true })
    .required({ accessToken: true }),
  JellyfinServerSettingsSchema.omit({ id: true, libraries: true }).required({
    accessToken: true,
  }),
  EmbyServerSettingsSchema.omit({ id: true, libraries: true }).required({
    accessToken: true,
  }),
  LocalMediaSourceSchema.omit({ id: true, libraries: true }),
]);

export type InsertMediaSourceRequest = z.infer<
  typeof InsertMediaSourceRequestSchema
>;

export const VersionApiResponseSchema = z.object({
  tunarr: z.string(),
  ffmpeg: z.string(),
});

export type VersionApiResponse = z.infer<typeof VersionApiResponseSchema>;

export const BaseErrorSchema = z.object({
  message: z.string(),
});

const FfmpegCoderDetails = z.object({
  name: z.string(),
  ffmpegName: z.string(),
});

export const FfmpegInfoResponse = z.object({
  audioEncoders: z.array(FfmpegCoderDetails),
  videoEncoders: z.array(FfmpegCoderDetails),
  hardwareAccelerationTypes: z.array(z.string()),
});

export const SystemSettingsResponseSchema = SystemSettingsSchema.extend({
  dataDirectory: z.string(),
  logging: LoggingSettingsSchema.extend({
    environmentLogLevel: LogLevelsSchema.optional(),
  }),
  searchServerAddress: z.url(),
});

export type SystemSettingsResponse = z.infer<
  typeof SystemSettingsResponseSchema
>;

/**
 * Declared field by field rather than as `LoggingSettingsSchema.pick(...)
 * .partial()`. `.partial()` wraps a field's `.default()` instead of removing
 * it, so a key the client omitted still arrived populated with its default —
 * `useEnvVarLevel` came through as `true` on every request, and
 * `logRollConfig` as the default object. The handler could not distinguish
 * "omitted" from "sent" and reset settings the request never mentioned.
 *
 * `categoryLogLevel` values are nullish: an explicit null clears one category,
 * while a category that is absent is left alone.
 */
export const UpdateSystemSettingsRequestSchema = z.object({
  logging: z
    .object({
      logLevel: LogLevelsSchema.optional(),
      useEnvVarLevel: z.boolean().optional(),
      logRollConfig: LogRollConfigSchema.optional(),
      categoryLogLevel: z
        .partialRecord(LogCategoriesSchema, LogLevelsSchema.nullish())
        .optional(),
    })
    .optional(),
  backup: BackupSettingsSchema.optional(),
  server: ServerSettingsSchema.optional(),
});

export type UpdateSystemSettingsRequest = z.infer<
  typeof UpdateSystemSettingsRequestSchema
>;

export const UpdateBackupSettingsRequestSchema = BackupSettingsSchema;

export const JellyfinLoginRequest = z.object({
  url: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
});

export const EmbyLoginRequest = z.object({
  url: z.string().url(),
  username: z.string().min(1),
  password: z.string().min(1),
});

export const StreamConnectionDetailsSchema = z.object({
  ip: z.ipv4().or(z.ipv6()),
  userAgent: z.string().optional(),
  lastHeartbeat: z.number().nonnegative().optional(),
});

export type StreamConnectionDetails = z.infer<
  typeof StreamConnectionDetailsSchema
>;

export const ChannelSessionsResponseSchema = z.object({
  // TODO: Share types with session
  type: z.enum([...SessionStreamModes, ...SessionConcatStreamModes]),
  state: z.string(),
  numConnections: z.number().nonnegative(),
  connections: z.array(StreamConnectionDetailsSchema),
  degradations: StreamDegradationsSchema,
  instanceId: z.uuid().optional(),
  requests: StreamRequestReportsSchema,
});

export type ChannelSessionsResponse = z.infer<
  typeof ChannelSessionsResponseSchema
>;

export const JellyfinGetLibraryItemsQuerySchema = z.object({
  offset: z.coerce.number().nonnegative().optional(),
  limit: z.coerce.number().positive().optional(),
  itemTypes: z
    .string()
    .optional()
    .transform((s) => s?.split(','))
    .pipe(JellyfinItemKind.array().optional()),
  extraFields: z
    .string()
    .optional()
    .transform((s) => s?.split(','))
    .pipe(JellyfinItemFields.array().optional()),
  // pipe delimited
  genres: z
    .string()
    .optional()
    .transform((s) => s?.split('|').filter((s) => s.trim().length > 0)),
  nameStartsWithOrGreater: z.string().min(1).optional(),
  nameStartsWith: z.string().min(1).optional(),
  nameLessThan: z.string().min(1).optional(),
});

export const MediaSourceHealthyStatusSchema = z.object({
  healthy: z.literal(true),
});

export const MediaSourceUnhealthyStatusSchema = z.object({
  healthy: z.literal(false),
  status: z.enum(['unreachable', 'auth', 'timeout', 'bad_response', 'unknown']),
});

export type MediaSourceUnhealthyStatus = z.infer<
  typeof MediaSourceUnhealthyStatusSchema
>;

export const MediaSourceStatusSchema = MediaSourceHealthyStatusSchema.or(
  MediaSourceUnhealthyStatusSchema,
);

export type MediaSourceStatus = z.infer<typeof MediaSourceStatusSchema>;

export const TimeSlotScheduleResult = z.object({
  startTime: z.number().positive(),
  lineup: CondensedChannelProgramSchema.array(),
  // programs: z.record(z.string(), ContentProgramSchema),
  seed: z.number().array(),
  discardCount: z.number(),
});

export type TimeSlotScheduleResult = z.infer<typeof TimeSlotScheduleResult>;

export const TimeSlotScheduleWithPrograms = z.object({
  ...TimeSlotScheduleResult.shape,
  programs: z.record(z.string(), ContentProgramSchema),
});

export type TimeSlotScheduleWithPrograms = z.infer<
  typeof TimeSlotScheduleWithPrograms
>;

export const SlotScheduleResult = z.object({
  startTime: z.number().positive(),
  lineup: CondensedChannelProgramSchema.array(),
  seed: z.number().array(),
  discardCount: z.number(),
});

export type SlotScheduleResult = z.infer<typeof SlotScheduleResult>;

export const SlotScheduleWithPrograms = z.object({
  ...SlotScheduleResult.shape,
  programs: z.record(z.string(), ContentProgramSchema),
});

export type SlotScheduleWithPrograms = z.infer<typeof SlotScheduleWithPrograms>;

export const ProgramChildrenResult = PagedResult(
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('season'),
      programs: Season.array(),
    }),
    z.object({
      type: z.literal('album'),
      programs: MusicAlbum.array(),
    }),
    z.object({
      type: z.literal('episode'),
      programs: Episode.array(),
    }),
    z.object({
      type: z.literal('track'),
      programs: MusicTrack.array(),
    }),
  ]),
);

export type ProgramChildrenResult = z.infer<typeof ProgramChildrenResult>;

export const UpdateMediaSourceLibraryRequest = z.object({
  enabled: z.boolean(),
});

export const ProgramSearchRequest = z.object({
  query: SearchRequestSchema,
  restrictSeachTo: z.array(z.string()).optional(),
  mediaSourceId: z.string().optional(),
  libraryId: z.string().optional(), // Limit search to a specific library
  page: z.number().optional(),
  limit: z.number().optional(),
  expandParents: z.boolean().optional(),
});

export const ProgramSearchResponse = z.object({
  results: z.array(ItemOrFolder),
  page: z.number(),
  totalPages: z.number(),
  totalHits: z.number(),
  facetDistribution: z
    .record(z.string(), z.record(z.string(), z.number()))
    .optional(),
});

export type ProgramSearchResponse = z.infer<typeof ProgramSearchResponse>;

const NotScanningSchema = z.object({
  state: z.literal('not_scanning'),
});

const InProgressScanSchema = z.object({
  state: z.literal('in_progress'),
  startedAt: z.number(), // timestamp
  percentComplete: z.number().min(0).max(100),
});

const QueuedProgressScanSchema = z.object({
  state: z.literal('queued'),
});

export const ScanProgressSchema = z.discriminatedUnion('state', [
  InProgressScanSchema,
  NotScanningSchema,
  QueuedProgressScanSchema,
]);

export type ScanProgress = z.infer<typeof ScanProgressSchema>;

export const EmptyTrashJobStateSchema = z.enum([
  'idle',
  'running',
  'cancelling',
  'failed',
]);

export type EmptyTrashJobState = z.infer<typeof EmptyTrashJobStateSchema>;

/**
 * Progress of the background "empty trash" drain. Flat rather than a
 * discriminated union so the UI can render `deleted`/`total` as a lingering
 * summary of the last run regardless of state.
 */
export const EmptyTrashStatusSchema = z.object({
  state: EmptyTrashJobStateSchema,
  total: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  /** Epoch millis. */
  startedAt: z.number().nullable(),
  /** Epoch millis. */
  finishedAt: z.number().nullable(),
  error: z.string().nullable(),
  // "Only unused": items that channels, custom shows or filler lists still
  // use stay in the Trash instead of turning into flex.
  onlyUnused: z.boolean(),
  // Items left in the Trash because something still uses them.
  kept: z.number().int().nonnegative(),
});

export type EmptyTrashStatus = z.infer<typeof EmptyTrashStatusSchema>;

// Repairing re-added items. When a media server re-adds something under a
// new ID (a library rebuild, an upgraded file), the old record goes to the
// Trash while channels still use it. A repair moves everything that uses the
// old record onto its healthy copy, then removes the old record.

const TrashRepairItemSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  showTitle: z.string().nullable(),
  seasonNumber: z.number().nullable(),
  episodeNumber: z.number().nullable(),
  year: z.number().nullable(),
});

export const TrashRepairUsesSchema = z.object({
  channels: z.number().int().nonnegative(),
  customShows: z.number().int().nonnegative(),
  fillerLists: z.number().int().nonnegative(),
  playHistory: z.number().int().nonnegative(),
});

export const TrashRepairMatchSchema = z.object({
  old: TrashRepairItemSchema,
  healthy: TrashRepairItemSchema,
  matchedOn: z.array(z.string()),
  uses: TrashRepairUsesSchema,
});

export const TrashRepairQuestionSchema = z.object({
  old: TrashRepairItemSchema,
  question: z.literal('Same show, new file?'),
  reason: z.enum([
    'several_copies',
    'other_media_source',
    'details_match_only',
  ]),
  candidates: z.array(
    TrashRepairItemSchema.extend({ matchedOn: z.array(z.string()) }),
  ),
  uses: TrashRepairUsesSchema,
});

export const TrashRepairPlanSchema = z.object({
  // Merged without asking: one healthy copy from the same media source that
  // shares a stable ID.
  exact: z.array(TrashRepairMatchSchema),
  // Not touched until confirmed or dismissed.
  questions: z.array(TrashRepairQuestionSchema),
  // Trashed items with no healthy copy at all: really gone.
  gone: z.number().int().nonnegative(),
  dismissed: z.number().int().nonnegative(),
});

export const TrashRepairRequestSchema = z.object({
  dryRun: z.boolean().default(false),
  // Answers "yes" to questions: merge this trashed item into this copy.
  confirm: z
    .array(z.object({ oldId: z.uuid(), healthyId: z.uuid() }))
    .optional(),
});

export const TrashRepairResultSchema = TrashRepairPlanSchema.extend({
  dryRun: z.boolean(),
  merged: z.array(z.object({ oldId: z.string(), healthyId: z.string() })),
  // Where the removed records were saved: one file per batch of merges.
  receipts: z.array(z.string()),
});

export const TrashRepairDismissRequestSchema = z.object({
  oldIds: z.array(z.uuid()).nonempty(),
});

// What emptying the Trash would do right now: which trashed items channels,
// custom shows and filler lists still use, so nothing goes dark by surprise.
export const EmptyTrashImpactSchema = z.object({
  // Programs in the Trash.
  total: z.number().int().nonnegative(),
  // Merged into their healthy copies before anything is deleted, because
  // automatic repairs are on.
  repairedFirst: z.number().int().nonnegative(),
  // Deleted by either kind of Empty Trash: nothing uses them.
  unused: z.number().int().nonnegative(),
  // Deleted only by a full Empty Trash, which turns their spots into flex.
  // "Only unused" leaves them in the Trash.
  used: z.array(
    TrashRepairItemSchema.extend({
      uses: TrashRepairUsesSchema,
      // 'exact': a repair would merge it into its healthy copy (automatic
      // repairs are off). 'question': an unanswered "Same show, new file?".
      repair: z.enum(['exact', 'question']).nullable(),
    }),
  ),
  // Distinct places a full Empty Trash would change.
  affected: z.object({
    channels: z.number().int().nonnegative(),
    customShows: z.number().int().nonnegative(),
    fillerLists: z.number().int().nonnegative(),
  }),
});

export type TrashRepairItem = z.infer<typeof TrashRepairItemSchema>;
export type EmptyTrashImpact = z.infer<typeof EmptyTrashImpactSchema>;
export type TrashRepairPlan = z.infer<typeof TrashRepairPlanSchema>;
export type TrashRepairMatch = z.infer<typeof TrashRepairMatchSchema>;
export type TrashRepairQuestion = z.infer<typeof TrashRepairQuestionSchema>;
export type TrashRepairUses = z.infer<typeof TrashRepairUsesSchema>;
export type TrashRepairRequest = z.infer<typeof TrashRepairRequestSchema>;
export type TrashRepairResult = z.infer<typeof TrashRepairResultSchema>;

export const MaterializedTimeSlotSchedule = z.object({
  ...TimeSlotScheduleSchema.shape,
  slots: MaterializedTimeSlot.array(),
});

export type MaterializedTimeSlotSchedule = z.infer<
  typeof MaterializedTimeSlotSchedule
>;

export const MaterializedSlotSchedule = z.object({
  ...RandomSlotScheduleSchema.shape,
  slots: MaterializedSlot.array(),
});

export type MaterializedSlotSchedule = z.infer<typeof MaterializedSlotSchedule>;

export const MaterializedSchedule = z.discriminatedUnion('type', [
  MaterializedTimeSlotSchedule,
  MaterializedSlotSchedule,
]);

export type MaterializedSchedule = z.infer<typeof MaterializedSchedule>;

export const FeatureFlagResponseMetaSchema = z.object({
  key: z.string(),
  displayName: z.string(),
  description: z.string(),
  category: z.enum(['experimental', 'escape-hatch']),
  envOverride: z.boolean(),
});

export type FeatureFlagResponseMeta = z.infer<
  typeof FeatureFlagResponseMetaSchema
>;

export const GetFeatureFlagsResponseSchema = z.object({
  flags: FeatureFlagsSchema,
  metadata: z.array(FeatureFlagResponseMetaSchema),
});

export type GetFeatureFlagsResponse = z.infer<
  typeof GetFeatureFlagsResponseSchema
>;

/**
 * Declared field by field rather than as `FeatureFlagsSchema.partial()`. Every
 * flag carries `.default(false)`, and `.partial()` wraps a default rather than
 * removing it, so all six arrived populated whatever the client sent. The
 * handler's `Object.assign(file.featureFlags, req.body)` then wrote all six,
 * which meant turning one flag on turned every other flag off.
 *
 * Zod omits an absent optional key from its output entirely, so `Object.assign`
 * is the correct handler for this shape once the schema is genuinely partial.
 *
 * A flag added to FeatureFlagsSchema must be added here too, or it will not be
 * updatable. `featureFlagsRequest.test.ts` fails if the two drift apart.
 */
export const UpdateFeatureFlagsRequestSchema = z.object({
  proxyArtwork: z.boolean().optional(),
  tonemapEnabled: z.boolean().optional(),
  webvttSidecarEnabled: z.boolean().optional(),
  disableSearchSnapshotInBackup: z.boolean().optional(),
  disableVulkan: z.boolean().optional(),
  disableVaapiPad: z.boolean().optional(),
  xmltvCreditImagesEnabled: z.boolean().optional(),
  ersatzTvNextEnabled: z.boolean().optional(),
});

export type UpdateFeatureFlagsRequest = z.infer<
  typeof UpdateFeatureFlagsRequestSchema
>;

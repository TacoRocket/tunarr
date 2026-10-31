import z from 'zod/v4';
import type { TupleToUnion } from '../util.js';
import { ResolutionSchema } from './miscSchemas.js';
import { ProgramSchema } from './programmingSchema.js';
import { SubtitlePreference } from './subtitleSchema.js';
import {
  ChannelIconSchema,
  ContentProgramTypeSchema,
  StrictChannelIconSchema,
} from './utilSchemas.js';

export const ChannelCrtSettingsSchema = z.object({
  enabled: z.boolean(),
  look: z
    .enum(['subtle', 'classic-flat', 'strong', 'dvd-broadcast', 'tv-broadcast'])
    .default('subtle'),
  processing: z
    .enum(['quality', 'performance', 'experimental'])
    .default('quality'),
  broadcastGrain: z.union([z.boolean(), z.literal('half')]).optional(),
  broadcastComposite: z.boolean().optional(),
  broadcastTexture: z.enum(['light', 'classic-flat']).optional(),
});

export type ChannelCrtSettings = z.infer<typeof ChannelCrtSettingsSchema>;

export const WatermarkSchema = z.object({
  url: z.string().optional(),
  enabled: z.boolean(),
  position: z
    .union([
      z.literal('top-left'),
      z.literal('top-right'),
      z.literal('bottom-left'),
      z.literal('bottom-right'),
    ])
    .default('bottom-right'),
  width: z.number().positive(),
  verticalMargin: z.number().min(0).max(100),
  horizontalMargin: z.number().min(0).max(100),
  duration: z.number().min(0).default(0),
  fixedSize: z.boolean().optional(),
  animated: z.boolean().optional(),
  opacity: z.number().min(0).max(100).int().optional().catch(100).default(100),
  fadeConfig: z
    .array(
      z.object({
        programType: ContentProgramTypeSchema.optional().catch(undefined),
        // Encodes on/off period of displaying the watermark in mins.
        // e.g. a 5m period fades in the watermark every 5th min and displays it
        // for 5 mins.
        periodMins: z.number().positive().min(1),
        // If true, the watermark will fade in immediately on channel stream start.
        // If false, the watermark will start not visible and fade in after periodMins.
        leadingEdge: z.boolean().optional().catch(true),
      }),
    )
    .optional(),
});

/**
 * The watermark as accepted from a client.
 *
 * Same split as StrictChannelIconSchema: identical handling of a *missing*
 * field, validation failure instead of silent substitution for an *invalid*
 * one. The `.catch()` calls in WatermarkSchema above are kept because that
 * schema also sits on channel responses, which are serialized from an
 * unvalidated JSON column.
 *
 * What they were hiding:
 * - `opacity: 150`, `-10`, `50.5` or `"50"` was stored as 100, fully opaque.
 * - `fadeConfig[].programType: "movies"` (not a ContentProgramType) became
 *   undefined, which means "no restriction" — so a fade rule the user scoped
 *   to one program type silently applied to every program on the channel.
 * - `fadeConfig[].leadingEdge: "false"`, as a form serialiser would send it,
 *   became true, the opposite of what was asked for.
 */
export const StrictWatermarkSchema = WatermarkSchema.extend({
  opacity: z.number().min(0).max(100).int().optional().default(100),
  fadeConfig: z
    .array(
      z.object({
        programType: ContentProgramTypeSchema.optional(),
        periodMins: z.number().positive().min(1),
        leadingEdge: z.boolean().optional(),
      }),
    )
    .optional(),
});

export const FillerCollectionSchema = z.object({
  id: z.string(),
  weight: z.number(),
  cooldownSeconds: z.number(),
});

export const ChannelOfflineSchema = z.object({
  picture: z.string().optional(),
  soundtrack: z.string().optional(),
  mode: z.union([z.literal('pic'), z.literal('clip')]),
});

export const ChannelTranscodingOptionsSchema = z.object({
  targetResolution: ResolutionSchema.optional(),
  videoBitrate: z.number().optional(),
  videoBufferSize: z.number().optional(),
});

export const HlsChannelStreamMode = 'hls';
export const HlsConcatChannelStreamMode = 'hls_concat';
export const HlsSlowerChannelStreamMode = 'hls_slower';
export const HlsSlowerConcatChannelStreamMode = 'hls_slower_concat';
export const MpegTsChannelStreamMode = 'mpegts';
export const MpegTsConcatChannelStreamMode = 'mpegts_concat';
export const HlsDirectStreamMode = 'hls_direct';
export const HlsDirectConcatStreamMode = 'hls_direct_concat';
export const HlsDirectV2StreamMode = 'hls_direct_v2';
export const HlsDirectV2ConcatStreamMode = 'hls_direct_v2_concat';

export const ChannelStreamMode = {
  Hls: HlsChannelStreamMode,
  HlsSlower: HlsSlowerChannelStreamMode,
  MpegTs: MpegTsChannelStreamMode,
  HlsDirect: HlsDirectStreamMode,
  HlsDirectV2: HlsDirectV2StreamMode,
} as const;

export const ChannelConcatStreamMode = {
  Hls: HlsConcatChannelStreamMode,
  HlsSlower: HlsSlowerConcatChannelStreamMode,
  MpegTs: MpegTsConcatChannelStreamMode,
  HlsDirect: HlsDirectConcatStreamMode,
  HlsDirectV2: HlsDirectV2ConcatStreamMode,
} as const;

export const ChannelStreamModes = [
  ChannelStreamMode.Hls,
  ChannelStreamMode.HlsSlower,
  ChannelStreamMode.MpegTs,
  ChannelStreamMode.HlsDirect,
  ChannelStreamMode.HlsDirectV2,
] as const;

export const ChannelConcatStreamModes = [
  ChannelConcatStreamMode.Hls,
  ChannelConcatStreamMode.HlsSlower,
  ChannelConcatStreamMode.MpegTs,
  ChannelConcatStreamMode.HlsDirect,
  ChannelConcatStreamMode.HlsDirectV2,
] as const;

export type ChannelStreamMode = TupleToUnion<typeof ChannelStreamModes>;
export const ChannelStreamModeSchema = z.enum(ChannelStreamModes);

export type ChannelConcatStreamMode = TupleToUnion<
  typeof ChannelConcatStreamModes
>;
export const ChannelConcatStreamModeSchema = z.enum(ChannelConcatStreamModes);

export const StreamConnectionDetailsSchema = z.object({
  ip: z.ipv4().or(z.ipv6()),
  userAgent: z.string().optional(),
  lastHeartbeat: z.number().nonnegative().optional(),
  lastHeartbeatStr: z.iso.datetime({ offset: true }).optional(),
});

// Ways a live stream is playing but not as configured: Tunarr had what the
// settings asked for and could not use it, so it kept the channel on the air
// another way. Content that simply lacks something (no Spanish audio track)
// is not a degradation.
export const StreamDegradationCodes = [
  // The profile or CRT tier asked for low-power H.264 VAAPI encoding and the
  // device can't do it; regular VAAPI encoding is used.
  'vaapi_low_power_unavailable',
  // The channel has CRT on, and this HDR item is outside the path that can
  // apply it, so CRT is bypassed for this item.
  'crt_hdr_bypassed',
  // The subtitle track the channel's rules picked is embedded text that
  // hasn't been extracted, so a later choice (or none) is shown.
  'subtitle_not_extracted',
  'hardware_decode_unavailable',
  'hardware_encode_unavailable',
  'hardware_tonemap_unavailable',
] as const;

export const StreamDegradationSchema = z.object({
  code: z.enum(StreamDegradationCodes),
  message: z.string(),
  // Epoch milliseconds. Carries across items while the same degradation
  // keeps recurring, so it reads as "since", not "this item".
  firstSeen: z.number().nonnegative(),
});

// Omitted means "can't tell", never "all good": some modes transcode each
// program per request with no live session to collect the reports.
export const StreamDegradationsSchema = z
  .array(StreamDegradationSchema)
  .optional()
  .describe(
    'Ways this live stream is not running as configured, limited to the codes Tunarr reports so far. Omitted when the session cannot report: plain MPEG-TS and HLS Direct transcode each program per request, with no live session to collect them. An empty list means none of the reported codes applies right now; it does not guarantee every setting is in effect.',
  );

export const ChannelSessionSchema = z.object({
  type: z.enum([...ChannelStreamModes, ...ChannelConcatStreamModes]),
  state: z.string(),
  numConnections: z.number().nonnegative(),
  connections: z.array(StreamConnectionDetailsSchema),
  degradations: StreamDegradationsSchema,
});

export const ChannelOffsetPictureSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('source') }),
  z.object({ mode: z.literal('off') }),
  z.object({ mode: z.literal('custom'), crt: ChannelCrtSettingsSchema }),
]);
export type ChannelOffsetPicture = z.infer<typeof ChannelOffsetPictureSchema>;

export const ChannelOffsetSchema = z.object({
  sourceChannelId: z.uuid(),
  hours: z.number().int().min(0).max(168),
  picture: ChannelOffsetPictureSchema.optional().describe(
    'Defaults to following the source; omitted updates preserve the picture choice. Custom replaces the complete CRT configuration.',
  ),
});

export const ChannelSchema = z.object({
  disableFillerOverlay: z.boolean(),
  duration: z.number(),
  fallback: z.array(ProgramSchema).optional(),
  fillerCollections: z.array(FillerCollectionSchema).optional(),
  fillerRepeatCooldown: z.number().optional(),
  groupTitle: z.string(),
  guideFlexTitle: z.string().optional(),
  guideMinimumDuration: z.number(),
  icon: ChannelIconSchema,
  id: z.string(),
  name: z.string(),
  number: z.number(),
  offline: ChannelOfflineSchema,
  startTime: z.number(),
  stealth: z.boolean(),
  transcoding: ChannelTranscodingOptionsSchema.optional(),
  watermark: WatermarkSchema.optional(),
  onDemand: z.object({
    enabled: z.boolean(),
  }),
  programCount: z.number(),
  streamMode: ChannelStreamModeSchema,
  transcodeConfigId: z.uuid(),
  sessions: z.array(ChannelSessionSchema).optional(),
  crt: ChannelCrtSettingsSchema.nullable()
    .optional()
    .describe(
      'Optional CRT effect for VAAPI transcoding. Null disables; omitted updates preserve the setting.',
    ),
  advanceAtFinalCredits: z
    .boolean()
    .optional()
    .describe(
      'End main programs at a valid final credits marker. Defaults to false; omitted updates preserve the current setting.',
    ),
  subtitlesEnabled: z.boolean(),
  subtitlePreferences: z.array(SubtitlePreference).nonempty().optional(),
  offset: ChannelOffsetSchema.nullable()
    .optional()
    .describe(
      'Set when this channel plays another channel this many hours later. Change it with PUT /channels/{id}/offset.',
    ),
});

// The write path validates strictly: a bad icon or watermark value is a 400,
// not a 200 that stored something else. The read path (ChannelSchema, used on
// channel responses) stays lenient so existing rows still serialize.
export const SaveableChannelSchema = ChannelSchema.omit({
  fallback: true, // Figure out how to update this
  programCount: true,
  transcoding: true,
  sessions: true,
  offset: true, // Set through PUT /channels/{id}/offset
})
  .partial({
    onDemand: true,
  })
  .extend({
    icon: StrictChannelIconSchema,
    watermark: StrictWatermarkSchema.optional(),
  });

// A missing startTime leaves the stored value unchanged. Server-computed
// rebases are exact and must survive saves of unrelated settings.
export const UpdateChannelRequestSchema = SaveableChannelSchema.partial({
  startTime: true,
});

export const NewChannelSaveRequestSchema = z.object({
  type: z.literal('new'),
  channel: SaveableChannelSchema,
});

export const CopyChannelSaveRequestSchema = z.object({
  type: z.literal('copy'),
  channelId: z.string().uuid(),
});

export const CreateChannelRequestSchema = z.discriminatedUnion('type', [
  NewChannelSaveRequestSchema,
  CopyChannelSaveRequestSchema,
]);

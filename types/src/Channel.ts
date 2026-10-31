import type z from 'zod/v4';
import type {
  ChannelOffsetSchema,
  ChannelOfflineSchema,
  ChannelSchema,
  ChannelSessionSchema,
  ChannelTranscodingOptionsSchema,
  CopyChannelSaveRequestSchema,
  CreateChannelRequestSchema,
  FillerCollectionSchema,
  NewChannelSaveRequestSchema,
  SaveableChannelSchema,
  StreamDegradationCodes,
  StreamDegradationSchema,
  StreamRequestReportSchema,
  UpdateChannelRequestSchema,
  WatermarkSchema,
} from './schemas/channelSchema.js';
import {
  ChannelStreamMode as ChannelStreamModesArr,
  type ChannelStreamMode as ChannelStreamModeType,
} from './schemas/channelSchema.js';
import type { ChannelIconSchema } from './schemas/index.js';

export type Watermark = z.infer<typeof WatermarkSchema>;

export type FillerCollection = z.infer<typeof FillerCollectionSchema>;

export type ChannelOffline = z.infer<typeof ChannelOfflineSchema>;

export type ChannelIcon = z.infer<typeof ChannelIconSchema>;

export type ChannelTranscodingOptions = z.infer<
  typeof ChannelTranscodingOptionsSchema
>;

export type ChannelSession = z.infer<typeof ChannelSessionSchema>;

export type StreamRequestReport = z.infer<typeof StreamRequestReportSchema>;

export type StreamDegradation = z.infer<typeof StreamDegradationSchema>;

export type StreamDegradationCode = (typeof StreamDegradationCodes)[number];

export type ChannelOffset = z.infer<typeof ChannelOffsetSchema>;

export type Channel = z.infer<typeof ChannelSchema>;

export type SaveableChannel = z.infer<typeof SaveableChannelSchema>;

export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequestSchema>;

export type NewChannelSaveRequest = z.infer<typeof NewChannelSaveRequestSchema>;

export type CopyChannelSaveRequest = z.infer<
  typeof CopyChannelSaveRequestSchema
>;

export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>;

export const ChannelStreamModes = ChannelStreamModesArr;

export type ChannelStreamMode = ChannelStreamModeType;

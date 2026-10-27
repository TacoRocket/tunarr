import { z } from 'zod/v4';
import {
  CondensedChannelProgramSchema,
  ContentProgramSchema,
} from '../schemas/lineups.js';
import { PostProgramPodSchema } from './CommonSlots.js';

export const GenerateBlockRequest = z
  .object({
    channelId: z
      .uuid()
      .optional()
      .describe(
        "Apply this channel's final-credit policy without saving or placing the block.",
      ),
    entries: z.array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('program'), programId: z.uuid() }).strict(),
        z
          .object({ type: z.literal('break'), positions: PostProgramPodSchema })
          .strict(),
      ]),
    ),
    seed: z.array(z.number().int()).nonempty().optional(),
  })
  .strict();

export type GenerateBlockRequest = z.infer<typeof GenerateBlockRequest>;

export const GenerateBlockResult = z.object({
  lineup: z.array(CondensedChannelProgramSchema),
  programs: z.record(z.string(), ContentProgramSchema),
  startTimeOffsets: z.array(z.number().nonnegative()),
  durationMs: z.number().nonnegative(),
  seed: z.array(z.number().int()),
});

export type GenerateBlockResult = z.infer<typeof GenerateBlockResult>;

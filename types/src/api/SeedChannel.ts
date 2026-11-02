import { z } from 'zod/v4';
import { GenerateBlockResult } from './BlockProgramming.js';

export const GenerateSeedChannelRequest = z
  .object({
    channelId: z.uuid(),
    seedProgramIds: z.array(z.uuid()).min(1).max(10),
    hours: z.number().min(1).max(168),
    familiarity: z.number().min(0).max(100),
    seed: z
      .array(z.number().int().min(-2147483648).max(2147483647))
      .min(1)
      .max(32)
      .optional(),
  })
  .strict();
export type GenerateSeedChannelRequest = z.infer<
  typeof GenerateSeedChannelRequest
>;

export const GenerateSeedChannelResult = GenerateBlockResult.extend({
  choices: z.array(
    z.object({
      programId: z.string(),
      title: z.string(),
      sourceTitle: z.string(),
      reasons: z.array(z.string()),
      views: z.number().nonnegative(),
      similarity: z.number().nonnegative(),
      weight: z.number().nonnegative(),
    }),
  ),
  warnings: z.array(z.string()),
});
export type GenerateSeedChannelResult = z.infer<
  typeof GenerateSeedChannelResult
>;

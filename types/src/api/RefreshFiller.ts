import { z } from 'zod/v4';

export const RefreshFillerRequest = z
  .object({
    fillerListIds: z.array(z.uuid()).nonempty(),
    seed: z.array(z.number().int()).nonempty().optional(),
  })
  .strict();

export type RefreshFillerRequest = z.infer<typeof RefreshFillerRequest>;

export const RefreshFillerResult = z.object({
  matchedPositions: z.number().int().nonnegative(),
  refreshedPositions: z.number().int().nonnegative(),
  preservedCurrentIndex: z.number().int().nonnegative().nullable(),
  durationMs: z.number().positive(),
  startTime: z.number(),
  seed: z.array(z.number().int()),
});

export type RefreshFillerResult = z.infer<typeof RefreshFillerResult>;

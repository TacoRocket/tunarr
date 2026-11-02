import { z } from 'zod/v4';

export const SeedChannelGrowthConfigSchema = z.object({
  seedProgramIds: z.array(z.uuid()).min(1).max(10),
  familiarity: z.number().min(0).max(100),
  targetHours: z.number().min(1).max(168),
});
export type SeedChannelGrowthConfig = z.infer<
  typeof SeedChannelGrowthConfigSchema
>;

export const SeedSelectionExplanationSchema = z.object({
  addedAt: z.number(),
  trigger: z
    .object({
      historyId: z.uuid(),
      programId: z.uuid(),
      title: z.string(),
      playedAt: z.number(),
    })
    .optional(),
  reasons: z.array(z.string()),
});
export type SeedSelectionExplanation = z.infer<
  typeof SeedSelectionExplanationSchema
>;

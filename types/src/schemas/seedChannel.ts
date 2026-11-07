import { z } from 'zod/v4';

export const SeedChannelRecommendationModeSchema = z.enum([
  'metadata',
  'semantic',
  'balanced',
]);

export const SeedChannelDiscoverySchema = z.object({
  exploration: z.number().min(0).max(100),
  temperature: z.number().min(0.7).max(1.4),
});
export type SeedChannelDiscovery = z.infer<typeof SeedChannelDiscoverySchema>;
export const BalancedSeedChannelDefaults: SeedChannelDiscovery = {
  exploration: 10,
  temperature: 1,
};

export const SeedChannelRollingConfigSchema = z
  .object({
    minimumHours: z.number().min(1).max(168),
    maximumHours: z.number().min(1).max(168),
    moviePercent: z.number().min(0).max(100),
    candidateCount: z.number().int().min(10).max(200),
  })
  .refine((value) => value.minimumHours <= value.maximumHours, {
    message: 'The extension limit must be at least the minimum hours.',
    path: ['maximumHours'],
  });
export type SeedChannelRollingConfig = z.infer<
  typeof SeedChannelRollingConfigSchema
>;
export const SeedChannelRollingDefaults: SeedChannelRollingConfig = {
  minimumHours: 6,
  maximumHours: 12,
  moviePercent: 30,
  candidateCount: 50,
};

export const SeedChannelGrowthConfigSchema = z
  .object({
    seedProgramIds: z.array(z.uuid()).min(1).max(10),
    familiarity: z.number().min(0).max(100),
    targetHours: z.number().min(1).max(168),
    recommendationMode: SeedChannelRecommendationModeSchema.optional(),
    discovery: SeedChannelDiscoverySchema.optional(),
    rolling: SeedChannelRollingConfigSchema.optional(),
  })
  .refine(
    (value) => !value.rolling || value.recommendationMode === 'balanced',
    {
      message: 'Rolling guides require Balanced matching.',
      path: ['recommendationMode'],
    },
  );
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

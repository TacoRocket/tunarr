import z from 'zod';
import { PostProgramPodSchema } from './CommonSlots.js';

const PresetOptions = z.object({
  showIds: z
    .array(z.uuid())
    .nonempty()
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Choose each show only once',
    ),
  maxDays: z.number().int().positive().default(1),
  postProgramPod: PostProgramPodSchema.optional(),
});

export const ShowSchedulingPresetRequest = z.discriminatedUnion('preset', [
  z.object({
    ...PresetOptions.shape,
    preset: z.enum(['marathon', 'primetime', 'saturday-morning']),
  }),
  z.object({
    ...PresetOptions.shape,
    preset: z.literal('variety'),
    wildcard: z.discriminatedUnion('type', [
      z.object({ type: z.literal('custom-show'), customShowId: z.uuid() }),
      z.object({
        type: z.literal('smart-collection'),
        smartCollectionId: z.uuid(),
      }),
    ]),
  }),
]);

export type ShowSchedulingPresetRequest = z.infer<
  typeof ShowSchedulingPresetRequest
>;

import z from 'zod';
import { PostProgramPodSchema } from './CommonSlots.js';

const PresetOptions = z.object({
  maxDays: z.number().int().positive().default(1),
  postProgramPod: PostProgramPodSchema.optional(),
});

const ShowIds = z
  .array(z.uuid())
  .nonempty()
  .refine(
    (ids) => new Set(ids).size === ids.length,
    'Choose each show only once',
  );

export const ShowSchedulingPresetRequest = z
  .discriminatedUnion('preset', [
    z.object({
      ...PresetOptions.shape,
      preset: z.enum(['marathon', 'primetime', 'saturday-morning']),
      showIds: ShowIds,
    }),
    z.object({
      ...PresetOptions.shape,
      preset: z.literal('variety'),
      showIds: ShowIds.optional(),
      showCollectionId: z.uuid().optional(),
      wildcard: z.discriminatedUnion('type', [
        z.object({ type: z.literal('custom-show'), customShowId: z.uuid() }),
        z.object({
          type: z.literal('smart-collection'),
          smartCollectionId: z.uuid(),
        }),
      ]),
    }),
  ])
  .superRefine((request, ctx) => {
    if (
      request.preset === 'variety' &&
      (request.showIds === undefined) ===
        (request.showCollectionId === undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['showCollectionId'],
        message: 'Provide either showIds or showCollectionId, not both',
      });
    }
  });

export type ShowSchedulingPresetRequest = z.infer<
  typeof ShowSchedulingPresetRequest
>;

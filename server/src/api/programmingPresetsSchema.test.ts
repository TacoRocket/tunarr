import { ShowSchedulingPresetRequest } from '@tunarr/types/api';
import { expect, test } from 'vitest';

test.each(['marathon', 'primetime', 'saturday-morning'] as const)(
  '%s rejects wildcard input instead of silently dropping it',
  (preset) => {
    const result = ShowSchedulingPresetRequest.safeParse({
      preset,
      showIds: ['11111111-1111-4111-8111-111111111111'],
      wildcard: {
        type: 'custom-show',
        customShowId: '22222222-2222-4222-8222-222222222222',
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual([
        'wildcard',
      ]);
    }
  },
);

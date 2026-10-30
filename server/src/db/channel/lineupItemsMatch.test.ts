import { describe, expect, test } from 'vitest';
import type { LineupItem } from '../derived_types/Lineup.ts';
import { lineupItemsMatch } from './lineupItemConversion.ts';

const content = (id: string, durationMs = 1000): LineupItem => ({
  type: 'content',
  id,
  durationMs,
});

describe('lineupItemsMatch', () => {
  test('ignores metadata a client may not echo back', () => {
    expect(
      lineupItemsMatch(
        [{ ...content('a'), customShowId: 'show' }],
        [content('a')],
      ),
    ).toBe(true);
  });

  test('a different order is a change', () => {
    expect(
      lineupItemsMatch(
        [content('a'), content('b')],
        [content('b'), content('a')],
      ),
    ).toBe(false);
  });

  test('a different duration is a change', () => {
    expect(lineupItemsMatch([content('a', 1000)], [content('a', 2000)])).toBe(
      false,
    );
  });

  test('flex vs content at the same position is a change', () => {
    expect(
      lineupItemsMatch([{ type: 'offline', durationMs: 1000 }], [content('a')]),
    ).toBe(false);
  });
});

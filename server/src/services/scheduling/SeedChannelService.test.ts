import { describe, expect, test } from 'vitest';
import type { MaterializeLineupCommand } from '../../commands/MaterializeLineupCommand.ts';
import type { ProgramDB } from '../../db/ProgramDB.ts';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';
import type { MeilisearchService } from '../MeilisearchService.ts';
import type { ChannelProgramDurationService } from './ChannelProgramDurationService.ts';
import { SeedChannelService } from './SeedChannelService.ts';

const showId = '11111111-1111-4111-8111-111111111111';
const episodeId = '22222222-2222-4222-8222-222222222222';
const movieId = '33333333-3333-4333-8333-333333333333';
const hour = 3_600_000;

function createService() {
  const show = {
    id: showId,
    type: 'show',
    title: 'The Mandalorian',
    genres: ['Western'],
  };
  const episode = {
    id: episodeId,
    type: 'episode',
    title: 'Chapter 1',
    grandparent: {
      // Search encodes nested IDs while the source catalog returns UUIDs.
      id: '64rk2c9h64rk2b9h64rk2b9m64rk2b9r64rk2b9h64rk2c9h64rk2c9h64',
    },
  };
  const movie = {
    id: movieId,
    type: 'movie',
    title: 'A Western Movie',
    genres: ['Western'],
  };
  const search = {
    getPrograms: async (ids: string[]) =>
      [show, episode, movie].filter((doc) => ids.includes(doc.id)),
    getSeedChannelSources: async () => [show, movie],
  } as unknown as MeilisearchService;
  const programs = {
    getProgramGroupingDescendants: async (id: string) =>
      id === showId
        ? [
            {
              uuid: episodeId,
              title: episode.title,
              state: 'ok',
              duration: hour,
            },
          ]
        : [],
    getProgramsByIds: async (ids: string[]) =>
      ids.includes(movieId)
        ? [{ uuid: movieId, title: movie.title, state: 'ok', duration: hour }]
        : [],
  } as unknown as ProgramDB;
  const db = {
    query: { channels: { findFirst: async () => ({ uuid: 'channel' }) } },
    select: () => ({
      from: () => ({
        all: () => [],
        innerJoin: () => ({
          where: () => ({ groupBy: () => ({ all: () => [] }) }),
        }),
      }),
    }),
  } as unknown as DrizzleDBAccess;
  const materialize = {
    execute: async () => ({ [episodeId]: episode, [movieId]: movie }),
  } as unknown as MaterializeLineupCommand;
  const durations = {
    finalCreditEnds: async () => new Map(),
  } as unknown as ChannelProgramDurationService;
  return new SeedChannelService(search, programs, db, materialize, durations);
}

describe('seed generation with encoded episode parents', () => {
  test('selects an explicit episode seed from its UUID show catalog entry', async () => {
    const result = await createService().generate({
      channelId: 'channel',
      seedProgramIds: [episodeId],
      hours: 1,
      familiarity: 0,
      seed: [1],
    });
    expect(result.lineup).toEqual([
      expect.objectContaining({
        id: episodeId,
        selectionExplanation: expect.objectContaining({
          reasons: ['Chosen seed'],
        }),
      }),
    ]);
    expect(result.choices[0]?.sourceTitle).toBe('The Mandalorian');
  });

  test('uses a watched episode to select and explain a related continuation', async () => {
    const result = await createService().generate(
      {
        channelId: 'channel',
        seedProgramIds: [showId],
        hours: 1,
        familiarity: 0,
        seed: [1],
      },
      {
        trigger: {
          historyId: '44444444-4444-4444-8444-444444444444',
          programId: episodeId,
          title: 'Chapter 1',
          playedAt: 1000,
        },
        queuedProgramIds: [episodeId],
      },
    );
    expect(result.lineup).toEqual([
      expect.objectContaining({
        id: movieId,
        selectionExplanation: expect.objectContaining({
          trigger: expect.objectContaining({
            programId: episodeId,
            title: 'The Mandalorian — Chapter 1',
          }),
          reasons: expect.arrayContaining([
            'Matches watched title The Mandalorian: Shared genre: Western',
          ]),
        }),
      }),
    ]);
  });
});

import { tag } from '@tunarr/types';
import type { SmartCollectionRandomSlot } from '@tunarr/types/api';
import { randomUUID } from 'node:crypto';
import { anything, instance, mock, when } from 'ts-mockito';
import { expect, test } from 'vitest';
import type { CustomShowDB } from '../../db/CustomShowDB.ts';
import type { FillerDB } from '../../db/FillerListDB.ts';
import type { IChannelDB } from '../../db/interfaces/IChannelDB.ts';
import type { ProgramDB } from '../../db/ProgramDB.ts';
import type { MediaSourceId } from '../../db/schema/base.ts';
import type { SmartCollectionsDB } from '../../db/SmartCollectionsDB.ts';
import { createFakeProgramOrm } from '../../testing/fakes/entityCreators.ts';
import type { ProgramSearchDocument } from '../MeilisearchService.ts';
import type { ChannelProgramDurationService } from './ChannelProgramDurationService.ts';
import { SlotSchedulerHelper } from './SlotSchedulerHelper.ts';

function searchResult(id: string, type: 'show' | 'episode') {
  const document = mock<ProgramSearchDocument>();
  when(document.id).thenReturn(id);
  when(document.type).thenReturn(type);
  return instance(document);
}

test.each(['show', 'episode', 'both'] as const)(
  'retains episode membership when another collection loads the show (main match: %s)',
  async (mainMatch) => {
    const showId = randomUUID();
    const mainId = randomUUID();
    const wildcardId = randomUUID();
    const episodes = [1, 2].map((episode) =>
      createFakeProgramOrm({
        uuid: randomUUID(),
        type: 'episode',
        episode,
        tvShowUuid: showId,
        mediaSourceId: tag<MediaSourceId>(randomUUID()),
        duration: 60_000,
      }),
    );
    const directMatches = episodes.map((p) => searchResult(p.uuid, 'episode'));
    const showMatches = [searchResult(showId, 'show')];
    const programDB = mock<ProgramDB>();
    when(programDB.getProgramGroupingDescendants(showId, 'show')).thenResolve(
      episodes,
    );
    when(programDB.getProgramsByIds(anything())).thenResolve([]);
    const collections = mock<SmartCollectionsDB>();
    when(
      collections.materializeSmartCollection(mainId, true, true),
    ).thenResolve(
      mainMatch === 'both'
        ? [...showMatches, ...directMatches]
        : mainMatch === 'episode'
          ? directMatches
          : showMatches,
    );
    when(
      collections.materializeSmartCollection(wildcardId, false, false),
    ).thenResolve(mainMatch === 'episode' ? showMatches : directMatches);
    const helper = new SlotSchedulerHelper(
      instance(mock<CustomShowDB>()),
      instance(mock<FillerDB>()),
      instance(programDB),
      instance(collections),
      instance(mock<IChannelDB>()),
      instance(mock<ChannelProgramDurationService>()),
    );
    const main: SmartCollectionRandomSlot = {
      id: randomUUID(),
      type: 'smart-collection',
      smartCollectionId: mainId,
      programGrouping: 'show',
      order: 'next',
      direction: 'asc',
      durationSpec: { type: 'dynamic', programCount: 2 },
      weight: 100,
      cooldownMs: 0,
    };
    const wildcard: SmartCollectionRandomSlot = {
      ...main,
      id: randomUUID(),
      smartCollectionId: wildcardId,
      programGrouping: undefined,
      order: 'shuffle',
    };
    const result = await helper.materializeSmartCollections([main, wildcard]);
    expect(result[mainId]?.map((p) => p.uuid)).toEqual(
      episodes.map((p) => p.uuid),
    );
    expect(result[wildcardId]?.map((p) => p.uuid)).toEqual(
      episodes.map((p) => p.uuid),
    );
  },
);

import { faker } from '@faker-js/faker';
import { tag } from '@tunarr/types';
import { MultiExternalIdType } from '@tunarr/types/schemas';
import type { Channel, ChannelOrm } from '../../db/schema/Channel.ts';
import type { ProgramDao } from '../../db/schema/Program.ts';
import { ProgramTypes } from '../../db/schema/Program.ts';
import type { MinimalProgramExternalId } from '../../db/schema/ProgramExternalId.ts';
import type { MediaSourceName } from '../../db/schema/base.js';
import {
  DefaultChannelIcon,
  type MediaSourceId,
} from '../../db/schema/base.js';
import type {
  ProgramGroupingOrmWithRelations,
  ProgramWithExternalIds,
  ProgramWithRelationsOrm,
} from '../../db/schema/derivedTypes.js';

export function createChannel(overrides?: Partial<Channel>): Channel {
  return {
    number: 1,
    updatedAt: null,
    fillerRepeatCooldown: null,
    groupTitle: null,
    guideFlexTitle: null,
    guideMinimumDuration: 30_000,
    icon: { ...DefaultChannelIcon },
    offline: { mode: 'pic' },
    streamMode: 'hls',
    transcodeConfigId: 'test-transcode-config',
    transcoding: null,
    watermark: null,
    crt: null,
    streamSelectionProfileId: null,
    offsetSourceChannelId: null,
    offsetHours: null,
    advanceAtFinalCredits: 0,
    stealth: 0,
    subtitlesEnabled: 0,
    uuid: faker.string.uuid(),
    duration: faker.number.int({ min: 0 }),
    startTime: faker.date.past().getTime(),
    createdAt: null,
    disableFillerOverlay: faker.datatype.boolean() ? 1 : 0,
    name: faker.music.artist(),
    ...(overrides ?? {}),
  } satisfies Channel;
}

export function createChannelOrm(overrides?: Partial<ChannelOrm>): ChannelOrm {
  return {
    number: 1,
    updatedAt: null,
    fillerRepeatCooldown: null,
    groupTitle: null,
    guideFlexTitle: null,
    guideMinimumDuration: 30_000,
    icon: { ...DefaultChannelIcon },
    offline: { mode: 'pic' },
    streamMode: 'hls',
    transcodeConfigId: 'test-transcode-config',
    transcoding: null,
    watermark: null,
    crt: null,
    streamSelectionProfileId: null,
    offsetSourceChannelId: null,
    offsetHours: null,
    advanceAtFinalCredits: false,
    stealth: false,
    subtitlesEnabled: false,
    uuid: faker.string.uuid(),
    duration: faker.number.int({ min: 0 }),
    startTime: faker.date.past().getTime(),
    createdAt: null,
    disableFillerOverlay: faker.datatype.boolean(),
    name: faker.music.artist(),
    ...(overrides ?? {}),
  } satisfies ChannelOrm;
}

function createFakeMultiExternalId(): MinimalProgramExternalId {
  const typ = faker.helpers.arrayElement(MultiExternalIdType);
  return {
    sourceType: typ,
    externalKey: faker.string.alphanumeric(),
    externalSourceId: tag<MediaSourceName>(faker.string.alphanumeric()),
    mediaSourceId: tag<MediaSourceId>(faker.string.uuid()),
  } satisfies MinimalProgramExternalId;
}

const programDefaults = {
  albumName: null,
  albumUuid: null,
  artistName: null,
  artistUuid: null,
  canonicalId: null,
  createdAt: null,
  updatedAt: null,
  episode: null,
  episodeIcon: null,
  externalKey: 'test-key',
  externalSourceId: tag<MediaSourceName>('test-source'),
  mediaSourceId: null,
  libraryId: null,
  localMediaFolderId: null,
  localMediaSourcePathId: null,
  filePath: null,
  grandparentExternalKey: null,
  icon: null,
  originalAirDate: null,
  parentExternalKey: null,
  plexFilePath: null,
  plexRatingKey: null,
  plot: null,
  rating: null,
  seasonIcon: null,
  seasonNumber: null,
  seasonUuid: null,
  showIcon: null,
  showTitle: null,
  sourceType: 'plex',
  state: 'ok',
  streamSelectionProfileId: null,
  tagline: null,
  tvShowUuid: null,
} satisfies Omit<
  ProgramDao,
  'uuid' | 'duration' | 'year' | 'title' | 'type' | 'summary'
>;

export function createFakeProgram(
  overrides?: Partial<ProgramDao>,
): ProgramWithExternalIds {
  return {
    ...programDefaults,
    uuid: faker.string.uuid(), // programId2,
    duration: faker.number.int({ min: 1 }), //lineup[1].durationMs,
    year: faker.date.past().getFullYear(),
    title: faker.music.songName(),
    externalIds: [createFakeMultiExternalId()],
    type: faker.helpers.arrayElement(ProgramTypes),
    summary: faker.lorem.sentences(),
    ...(overrides ?? {}),
  } satisfies ProgramWithExternalIds;
}

export function createFakeProgramOrm(
  overrides?: Partial<ProgramWithRelationsOrm>,
): ProgramWithRelationsOrm {
  const uuid = faker.string.uuid();
  return {
    ...programDefaults,
    uuid: uuid, // programId2,
    duration: faker.number.int({ min: 1 }), //lineup[1].durationMs,
    year: faker.date.past().getFullYear(),
    title: faker.music.songName(),
    externalIds: [
      {
        sourceType: faker.helpers.arrayElement(MultiExternalIdType),
        externalKey: faker.string.alphanumeric(),
        externalSourceId: tag<MediaSourceName>(faker.string.alphanumeric()),
        mediaSourceId: tag<MediaSourceId>(faker.string.uuid()),
        createdAt: 0,
        uuid: faker.string.uuid(),
        updatedAt: 0,
        programUuid: uuid,
        directFilePath: null,
        externalFilePath: null,
      },
    ],
    type: faker.helpers.arrayElement(ProgramTypes),
    summary: faker.lorem.sentences(),
    ...(overrides ?? {}),
  } satisfies ProgramWithRelationsOrm;
}

export function createFakeShow(
  overrides?: Partial<ProgramGroupingOrmWithRelations>,
): ProgramGroupingOrmWithRelations {
  const uuid = faker.string.uuid();
  return {
    uuid: uuid,
    type: 'show',
    title: 'Test Show',
    artistUuid: null,
    showUuid: null,
    libraryId: null,
    rating: null,
    releaseDate: null,
    sourceType: null,
    state: 'ok',
    tagline: null,
    year: null,
    externalIds: [],
    icon: faker.image.url(),
    index: 0,
    createdAt: faker.date.past().getMilliseconds(),
    updatedAt: null,
    canonicalId: null,
    plot: faker.lorem.sentences(),
    summary: faker.lorem.sentences(),
    externalKey: faker.string.alphanumeric(),
    mediaSourceId: tag<MediaSourceId>(faker.string.uuid()),
    ...(overrides ?? {}),
  } satisfies ProgramGroupingOrmWithRelations;
}

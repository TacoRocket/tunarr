import { SaveableChannel } from '@tunarr/types';
import { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { v4 } from 'uuid';
import { container } from '../src/container.ts';
import { ChannelDB } from '../src/db/ChannelDB.ts';
import { CustomShowDB } from '../src/db/CustomShowDB.ts';
import { FileSystemService } from '../src/services/FileSystemService.ts';
import { TranscodeConfigDB } from '../src/db/TranscodeConfigDB.ts';
import { KEYS } from '../src/types/inject.ts';
import { getAvailablePort } from '../src/util/net.ts';
import { initTestApp } from './testServer.js';
import {
  makeTimeSlotSchedule,
  saveTimeSlotSchedule,
  seedCustomShow,
  seedPrograms,
} from './support/seed.ts';

let app: FastifyInstance;
let validTranscodeConfigId: string;

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

function makeChannelPayload(
  transcodeConfigId: string,
): Partial<SaveableChannel> {
  return {
    name: 'Test Channel',
    number: 8001,
    duration: 60000,
    groupTitle: 'test',
    guideMinimumDuration: 30000,
    icon: {
      path: '',
      width: 0,
      duration: 0,
      position: 'bottom-right',
    },
    id: NON_EXISTENT_UUID,
    startTime: 0,
    stealth: false,
    offline: { mode: 'pic' },
    streamMode: 'hls',
    transcodeConfigId,
    disableFillerOverlay: false,
    subtitlesEnabled: false,
  };
}

beforeAll(async () => {
  app = await initTestApp(await getAvailablePort());
  const transcodeConfigDB = container.get(TranscodeConfigDB);
  const defaultConfig = await transcodeConfigDB.getDefaultConfig();
  if (!defaultConfig) {
    throw new Error('Default transcode config not found after bootstrap');
  }
  validTranscodeConfigId = defaultConfig.uuid;
});

afterAll(async () => {
  await app?.close();
});

let nextChannelNumber = 8001;

async function createChannel(): Promise<string> {
  const channelDB = container.get<ChannelDB>(KEYS.ChannelDB);
  const result = await channelDB.saveChannel({
    ...makeChannelPayload(validTranscodeConfigId),
    name: 'Programming Validation Channel',
    number: nextChannelNumber++,
  } as SaveableChannel);
  return result.channel.uuid;
}

describe('POST /channels/:id/programming - slot group validation on the save path', () => {
  test('rejects a schedule whose slots share an iterationGroup with mismatched ordering', async () => {
    const channelId = await createChannel();
    const groupId = v4();
    const customShowId = v4();

    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/programming`,
      payload: {
        type: 'time',
        programs: [],
        schedule: {
          type: 'time',
          flexPreference: 'distribute',
          latenessMs: 0,
          maxDays: 1,
          padMs: 60 * 60 * 1000,
          period: 'day',
          timeZoneOffset: 0,
          slots: [
            {
              type: 'custom-show',
              customShowId,
              id: v4(),
              startTime: 0,
              order: 'next',
              direction: 'asc',
              iterationGroup: groupId,
            },
            {
              type: 'custom-show',
              customShowId,
              id: v4(),
              startTime: 0,
              order: 'shuffle',
              direction: 'asc',
              iterationGroup: groupId,
            },
          ],
        },
      },
    });

    // The two slots share an iterationGroup but disagree on ordering — the
    // schedule must be rejected on the save path just like the preview
    // endpoints reject it, instead of being persisted and regenerated badly.
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('mismatched orderings');
  });
});

describe('rejected programming leaves stored state unchanged', () => {
  const oneHour = 60 * 60 * 1000;

  async function saveFlexLineup(channelId: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/programming`,
      payload: {
        type: 'manual',
        lineup: [{ type: 'flex', duration: oneHour }],
      },
    });
    expect(res.statusCode).toBe(200);
  }

  async function snapshot(channelId: string) {
    const channelDB = container.get<ChannelDB>(KEYS.ChannelDB);
    const channel = await channelDB.getChannel(channelId);
    const cached = await channelDB.loadLineup(channelId);
    const file = JSON.parse(
      await readFile(
        container.get(FileSystemService).getChannelLineupPath(channelId),
        'utf-8',
      ),
    ) as { items: unknown };
    return {
      duration: channel?.duration,
      cachedItems: structuredClone(cached.items),
      fileItems: file.items,
    };
  }

  async function createEmptyCustomShow() {
    return container.get(CustomShowDB).createShow({
      name: 'Empty Show',
      programs: [],
      syncExternalPlaylistId: null,
      syncMediaSourceId: null,
      syncMediaSourceType: null,
    });
  }

  const randomSchedule = (
    customShowId: string,
    durationSpec: Record<string, unknown>,
  ) => ({
    type: 'random',
    flexPreference: 'end',
    maxDays: 0,
    padMs: 1,
    padStyle: 'slot',
    randomDistribution: 'none',
    slots: [
      {
        id: v4(),
        type: 'custom-show',
        customShowId,
        order: 'next',
        direction: 'asc',
        weight: 1,
        cooldownMs: 0,
        durationSpec,
      },
    ],
  });

  test('a random schedule that references an empty custom show is rejected', async () => {
    const channelId = await createChannel();
    await saveFlexLineup(channelId);
    const before = await snapshot(channelId);
    const customShowId = await createEmptyCustomShow();

    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/programming`,
      payload: {
        type: 'random',
        programs: [],
        schedule: randomSchedule(customShowId, {
          type: 'dynamic',
          programCount: 1,
        }),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Slot 0');
    expect(res.body).toContain(customShowId);
    expect(await snapshot(channelId)).toEqual(before);

    const version = await app.inject({ method: 'GET', url: '/api/version' });
    expect(version.statusCode).toBe(200);
  });

  test('a random schedule with a zero fixed duration is rejected', async () => {
    const channelId = await createChannel();
    await saveFlexLineup(channelId);
    const before = await snapshot(channelId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/programming`,
      payload: {
        type: 'random',
        programs: [],
        schedule: randomSchedule(v4(), { type: 'fixed', durationMs: 0 }),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Slot 0');
    expect(await snapshot(channelId)).toEqual(before);
  });

  test('random and time previews reject an empty custom show', async () => {
    const channelId = await createChannel();
    const customShowId = await createEmptyCustomShow();

    const random = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/schedule-slots`,
      payload: {
        schedule: randomSchedule(customShowId, {
          type: 'dynamic',
          programCount: 1,
        }),
      },
    });
    expect(random.statusCode).toBe(400);
    expect(random.body).toContain(customShowId);

    const time = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/schedule-time-slots`,
      payload: {
        schedule: {
          type: 'time',
          flexPreference: 'end',
          latenessMs: 0,
          maxDays: 1,
          padMs: oneHour,
          period: 'day',
          timeZoneOffset: 0,
          slots: [
            {
              id: v4(),
              type: 'custom-show',
              customShowId,
              startTime: 0,
              order: 'next',
              direction: 'asc',
            },
          ],
        },
      },
    });
    expect(time.statusCode).toBe(400);
    expect(time.body).toContain(customShowId);
  });

  test('a manual lineup with zero-duration content is rejected', async () => {
    const channelId = await createChannel();
    await saveFlexLineup(channelId);
    const before = await snapshot(channelId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/programming`,
      payload: {
        type: 'manual',
        lineup: [{ type: 'content', id: v4(), duration: 0 }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('lineup/0/duration');
    expect(await snapshot(channelId)).toEqual(before);
  });

  test('a time schedule with a fractional start time is rejected', async () => {
    const channelId = await createChannel();
    await saveFlexLineup(channelId);
    const before = await snapshot(channelId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/programming`,
      payload: {
        type: 'time',
        programs: [],
        schedule: {
          type: 'time',
          flexPreference: 'end',
          latenessMs: 0,
          maxDays: 1,
          padMs: oneHour,
          period: 'day',
          timeZoneOffset: 0,
          slots: [{ id: v4(), type: 'flex', startTime: 1234.567 }],
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('startTime');
    expect(await snapshot(channelId)).toEqual(before);
  });

  test('a random schedule that references a deleted filler list is rejected', async () => {
    const channelId = await createChannel();
    await saveFlexLineup(channelId);
    const before = await snapshot(channelId);
    const fillerListId = v4();

    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/programming`,
      payload: {
        type: 'random',
        programs: [],
        schedule: {
          ...randomSchedule(v4(), { type: 'fixed', durationMs: oneHour }),
          slots: [
            {
              id: v4(),
              type: 'filler',
              fillerListId,
              order: 'shuffle_prefer_short',
              direction: 'asc',
              decayFactor: 0.5,
              durationWeighting: 'linear',
              recoveryFactor: 0.05,
              weight: 1,
              cooldownMs: 0,
              durationSpec: { type: 'fixed', durationMs: oneHour },
            },
          ],
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(fillerListId);
    expect(await snapshot(channelId)).toEqual(before);
  });

  test('a manual lineup with an unknown program is rejected', async () => {
    const channelId = await createChannel();
    await saveFlexLineup(channelId);
    const before = await snapshot(channelId);
    const missingId = v4();

    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/programming`,
      payload: {
        type: 'manual',
        lineup: [{ type: 'content', id: missingId, duration: oneHour }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain(missingId);
    expect(await snapshot(channelId)).toEqual(before);
  });

  test('an empty manual lineup is still accepted', async () => {
    const channelId = await createChannel();
    await saveFlexLineup(channelId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/programming`,
      payload: { type: 'manual', lineup: [] },
    });

    expect(res.statusCode).toBe(200);
    const after = await snapshot(channelId);
    expect(after.cachedItems).toEqual([]);
    expect(after.duration).toBe(0);
  });
});

describe('custom show API', () => {
  test('DELETE of an unknown custom show answers 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/custom-shows/${v4()}`,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('a manual lineup stays put after a schedule was attached (#76)', () => {
  const halfHour = 30 * 60 * 1000;

  async function lineupFile(channelId: string) {
    return JSON.parse(
      await readFile(
        container.get(FileSystemService).getChannelLineupPath(channelId),
        'utf-8',
      ),
    ) as {
      items: { type: string; id?: string; durationMs: number }[];
      schedule?: { type: string };
      scheduleSeed?: number[];
      scheduleDetached?: boolean;
    };
  }

  async function saveSlots(
    channelId: string,
    programIds: string[],
    customShowId: string,
  ) {
    const res = await saveTimeSlotSchedule(
      app,
      channelId,
      programIds,
      makeTimeSlotSchedule({ customShowId, maxDays: 1 }),
    );
    expect(res.statusCode).toBe(200);
  }

  async function saveManual(channelId: string, programIds: string[]) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/programming`,
      payload: {
        type: 'manual',
        lineup: programIds.map((id) => ({
          type: 'content',
          id,
          duration: halfHour,
        })),
      },
    });
    expect(res.statusCode).toBe(200);
  }

  async function shiftStartTime(channelId: string, byMs: number) {
    const current = await app.inject({
      method: 'GET',
      url: `/api/channels/${channelId}`,
    });
    expect(current.statusCode).toBe(200);
    const channel = current.json() as { startTime: number };
    const res = await app.inject({
      method: 'PUT',
      url: `/api/channels/${channelId}`,
      payload: { ...channel, startTime: channel.startTime + byMs },
    });
    expect(res.statusCode).toBe(200);
  }

  test('a start-time change does not regenerate over a hand-built lineup', async () => {
    const programIds = await seedPrograms(4, { durationMs: halfHour });
    const customShowId = await seedCustomShow(programIds, halfHour);
    const channelId = await createChannel();

    await saveSlots(channelId, programIds, customShowId);
    expect((await lineupFile(channelId)).schedule?.type).toBe('time');

    // The hand-built order: last program first, then the first one.
    const manual = [programIds[3]!, programIds[0]!];
    await saveManual(channelId, manual);
    const afterManual = await lineupFile(channelId);
    expect(afterManual.scheduleDetached).toBe(true);
    // The schedule is kept so the slot editor can reopen it.
    expect(afterManual.schedule?.type).toBe('time');

    await shiftStartTime(channelId, 60_000);

    const afterShift = await lineupFile(channelId);
    expect(
      afterShift.items.filter((i) => i.type === 'content').map((i) => i.id),
    ).toEqual(manual);
    expect(afterShift.scheduleDetached).toBe(true);
  });

  test('saving from a slot editor again re-attaches the schedule', async () => {
    const programIds = await seedPrograms(3, { durationMs: halfHour });
    const customShowId = await seedCustomShow(programIds, halfHour);
    const channelId = await createChannel();

    await saveSlots(channelId, programIds, customShowId);
    await saveManual(channelId, [programIds[2]!]);
    expect((await lineupFile(channelId)).scheduleDetached).toBe(true);

    await saveSlots(channelId, programIds, customShowId);
    const reattached = await lineupFile(channelId);
    expect(reattached.scheduleDetached).toBeUndefined();
    expect(reattached.scheduleSeed?.length).toBeGreaterThan(0);
  });

  test('a manual save that leaves the items unchanged does not detach', async () => {
    const programIds = await seedPrograms(3, { durationMs: halfHour });
    const customShowId = await seedCustomShow(programIds, halfHour);
    const channelId = await createChannel();

    await saveSlots(channelId, programIds, customShowId);
    const generated = (await lineupFile(channelId)).items;
    const res = await app.inject({
      method: 'POST',
      url: `/api/channels/${channelId}/programming`,
      payload: {
        type: 'manual',
        lineup: generated.map((item) =>
          item.type === 'content'
            ? { type: 'content', id: item.id, duration: item.durationMs }
            : { type: 'flex', duration: item.durationMs },
        ),
      },
    });
    expect(res.statusCode).toBe(200);

    expect((await lineupFile(channelId)).scheduleDetached).toBeUndefined();
  });
});

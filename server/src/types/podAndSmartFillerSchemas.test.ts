import {
  CreateFillerListRequestSchema,
  PostProgramPodSchema,
  UpdateFillerListRequestSchema,
} from '@tunarr/types/api';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';

const pool = randomUUID();
const collection = randomUUID();
const program = {
  type: 'custom' as const,
  id: randomUUID(),
  customShowId: randomUUID(),
  index: 0,
  persisted: true,
  duration: 30_000,
};

describe('PostProgramPodSchema', () => {
  test('a position can play several clips', () => {
    expect(
      PostProgramPodSchema.safeParse([{ fillerListIds: [pool], count: 3 }])
        .success,
    ).toBe(true);
  });

  test.each([0, -1, 1.5])('count %s is rejected', (count) => {
    expect(
      PostProgramPodSchema.safeParse([{ fillerListIds: [pool], count }])
        .success,
    ).toBe(false);
  });

  test('a pod without count reads back exactly as submitted', () => {
    const pod = [{ fillerListIds: [pool] }];
    expect(PostProgramPodSchema.parse(pod)).toStrictEqual(pod);
  });
});

describe('filler list requests', () => {
  test('a list is created from programs or from a smart collection', () => {
    expect(
      CreateFillerListRequestSchema.safeParse({
        name: 'Hand built',
        programs: [program],
      }).success,
    ).toBe(true);
    expect(
      CreateFillerListRequestSchema.safeParse({
        name: 'Nintendo',
        smartCollectionId: collection,
      }).success,
    ).toBe(true);
  });

  test('a list cannot be created from both, or from neither', () => {
    expect(
      CreateFillerListRequestSchema.safeParse({
        name: 'Both',
        programs: [program],
        smartCollectionId: collection,
      }).success,
    ).toBe(false);
    expect(
      CreateFillerListRequestSchema.safeParse({ name: 'Neither' }).success,
    ).toBe(false);
  });

  test('an update can unlink with null or leave the link alone', () => {
    expect(
      UpdateFillerListRequestSchema.parse({ smartCollectionId: null }),
    ).toEqual({ smartCollectionId: null });
    expect(UpdateFillerListRequestSchema.parse({ name: 'Renamed' })).toEqual({
      name: 'Renamed',
    });
  });
});

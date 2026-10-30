import type { CondensedChannelProgram } from '@tunarr/types';
import { isEqual, isUndefined, omitBy } from 'lodash-es';
import { match } from 'ts-pattern';
import type { LineupItem } from '../derived_types/Lineup.ts';

export function condensedProgramToLineupItem(
  p: CondensedChannelProgram,
): LineupItem {
  return match(p)
    .returnType<LineupItem>()
    .with({ type: 'content' }, (program) => ({
      type: 'content',
      id: program.id,
      durationMs: program.duration,
      startOffsetMs: program.startOffsetMs,
    }))
    .with({ type: 'custom' }, (program) => ({
      type: 'content',
      durationMs: program.duration,
      id: program.id,
      customShowId: program.customShowId,
      startOffsetMs: program.startOffsetMs,
    }))
    .with({ type: 'filler' }, (program) => ({
      type: 'content',
      durationMs: program.duration,
      id: program.id,
      fillerListId: program.fillerListId,
      fillerType: program.fillerType,
    }))
    .with({ type: 'redirect' }, (program) => ({
      type: 'redirect',
      channel: program.channel,
      durationMs: program.duration,
    }))
    .with({ type: 'flex' }, (program) => ({
      type: 'offline',
      durationMs: program.duration,
      fillerConfig: program.fillerConfig,
    }))
    .exhaustive();
}

/**
 * Whether two lineups play the same thing: the same items in the same order,
 * with the same durations, start offsets, filler roles and flex filler
 * settings. Provenance a client may not echo back (the custom show an item
 * came from) is ignored, and an omitted start offset equals zero, so re-saving
 * an unchanged lineup is not mistaken for a hand edit.
 */
export function lineupItemsMatch(
  a: readonly LineupItem[],
  b: readonly LineupItem[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((left, index) => {
    const right = b[index]!;
    if (left.type !== right.type || left.durationMs !== right.durationMs) {
      return false;
    }
    if (left.type === 'content' && right.type === 'content') {
      return (
        left.id === right.id &&
        (left.startOffsetMs ?? 0) === (right.startOffsetMs ?? 0) &&
        left.fillerType === right.fillerType &&
        left.fillerListId === right.fillerListId
      );
    }
    if (left.type === 'offline' && right.type === 'offline') {
      return isEqual(
        omitBy(left.fillerConfig ?? {}, isUndefined),
        omitBy(right.fillerConfig ?? {}, isUndefined),
      );
    }
    if (left.type === 'redirect' && right.type === 'redirect') {
      return left.channel === right.channel;
    }
    return true;
  });
}

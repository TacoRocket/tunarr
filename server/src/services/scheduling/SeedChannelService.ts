import type { CondensedChannelProgram } from '@tunarr/types';
import type {
  GenerateSeedChannelRequest,
  GenerateSeedChannelResult,
} from '@tunarr/types/api';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { createEntropy, MersenneTwister19937, Random } from 'random-js';
import { MaterializeLineupCommand } from '../../commands/MaterializeLineupCommand.ts';
import type { ProgramDB } from '../../db/ProgramDB.ts';
import { FillerShowContent } from '../../db/schema/FillerShowContent.ts';
import { Program } from '../../db/schema/Program.ts';
import { ProgramPlayHistory } from '../../db/schema/ProgramPlayHistory.ts';
import type { ProgramOrmWithExternalIds } from '../../db/schema/derivedTypes.ts';
import type { DrizzleDBAccess } from '../../db/schema/index.ts';
import { ScheduleValidationError } from '../../types/errors.ts';
import { KEYS } from '../../types/inject.ts';
import {
  decodeCaseSensitiveId,
  MeilisearchService,
  type SeedChannelSource,
} from '../MeilisearchService.ts';
import { ChannelProgramDurationService } from './ChannelProgramDurationService.ts';
import { hasSchedulableDuration } from './slotSchedulerUtil.ts';

function metadataMatch(left: SeedChannelSource, right: SeedChannelSource) {
  let score = 0;
  const reasons: string[] = [];
  const fields = [
    ['genres', 4, 'genre'],
    ['tags', 6, 'tag'],
    ['actors', 2, 'cast'],
    ['director', 3, 'director'],
    ['studio', 1, 'studio'],
  ] as const;
  for (const [field, importance, label] of fields) {
    const names = (doc: SeedChannelSource) => {
      const values: readonly (string | { name: string })[] = doc[field] ?? [];
      return new Map<string, string>(
        values
          .map((value) => {
            const name = typeof value === 'string' ? value : value.name;
            return [name.trim().toLowerCase(), name] as const;
          })
          .filter(([name]) => name.length > 0),
      );
    };
    const a = names(left);
    const b = names(right);
    const shared = [...a].filter(([name]) => b.has(name));
    if (shared.length > 0) {
      score +=
        (importance * shared.length) / new Set([...a.keys(), ...b.keys()]).size;
      reasons.push(
        `Shared ${label}: ${shared.map(([, name]) => name).join(', ')}`,
      );
    }
  }
  // Era is supporting evidence; it cannot make unrelated titles candidates.
  if (
    score > 0 &&
    left.originalReleaseYear &&
    right.originalReleaseYear &&
    Math.abs(left.originalReleaseYear - right.originalReleaseYear) <= 10
  ) {
    score += 0.5;
    reasons.push('Released within ten years');
  }
  return { score, reasons };
}

@injectable()
export class SeedChannelService {
  constructor(
    @inject(MeilisearchService) private search: MeilisearchService,
    @inject(KEYS.ProgramDB) private programs: ProgramDB,
    @inject(KEYS.DrizzleDB) private db: DrizzleDBAccess,
    @inject(MaterializeLineupCommand)
    private materialize: MaterializeLineupCommand,
    @inject(ChannelProgramDurationService)
    private durations: ChannelProgramDurationService,
  ) {}

  async generate(
    request: GenerateSeedChannelRequest,
  ): Promise<GenerateSeedChannelResult> {
    const channel = await this.db.query.channels.findFirst({
      where: (c, { eq }) => eq(c.uuid, request.channelId),
    });
    if (!channel)
      throw new ScheduleValidationError(
        'Choose an existing channel before generating.',
      );
    const seedIds = [...new Set(request.seedProgramIds)];
    const seeds = await this.search.getPrograms(seedIds);
    if (
      seeds.length !== seedIds.length ||
      seeds.some((s) => !['show', 'episode', 'movie'].includes(s.type))
    ) {
      throw new ScheduleValidationError(
        'Every seed must be an indexed show, episode, or movie.',
      );
    }
    const catalog = await this.search.getSeedChannelSources();
    const byId = new Map(catalog.map((source) => [source.id, source]));
    const orderedSeeds = seedIds.map((id) => seeds.find((s) => s.id === id));
    const anchors: SeedChannelSource[] = [];
    const initial: { source: SeedChannelSource; programId?: string }[] = [];
    for (const seedDoc of orderedSeeds) {
      if (!seedDoc)
        throw new ScheduleValidationError('Seed disappeared from the index.');
      const sourceId =
        seedDoc.type === 'episode'
          ? seedDoc.grandparent && decodeCaseSensitiveId(seedDoc.grandparent.id)
          : seedDoc.id;
      const source = sourceId ? byId.get(sourceId) : undefined;
      if (!source)
        throw new ScheduleValidationError(
          `Seed ${seedDoc.title} has no available show or movie in the index.`,
        );
      anchors.push(source);
      initial.push({
        source,
        programId: seedDoc.type === 'episode' ? seedDoc.id : undefined,
      });
    }

    const history = this.db
      .select({
        programId: ProgramPlayHistory.programUuid,
        showId: Program.tvShowUuid,
        views: sql<number>`count(*)`.mapWith(Number),
        lastPlayed: sql<number>`max(${ProgramPlayHistory.playedAt})`.mapWith(
          Number,
        ),
      })
      .from(ProgramPlayHistory)
      .innerJoin(Program, eq(Program.uuid, ProgramPlayHistory.programUuid))
      .where(
        and(
          eq(ProgramPlayHistory.channelUuid, request.channelId),
          isNull(ProgramPlayHistory.fillerListId),
        ),
      )
      .groupBy(ProgramPlayHistory.programUuid)
      .all();
    const views = new Map<string, number>();
    for (const row of history) {
      const id = row.showId ?? row.programId;
      views.set(id, (views.get(id) ?? 0) + row.views);
    }
    const fillerIds = new Set(
      this.db
        .select({ id: FillerShowContent.programUuid })
        .from(FillerShowContent)
        .all()
        .map((p) => p.id),
    );
    let recent = history
      .sort((a, b) => b.lastPlayed - a.lastPlayed)
      .slice(0, 20)
      .map((p) => p.programId)
      .reverse();
    const pools = new Map<string, ProgramOrmWithExternalIds[]>();
    const ends = new Map<string, number>();
    const loadPool = async (source: SeedChannelSource) => {
      const cached = pools.get(source.id);
      if (cached) return cached;
      const programs = (
        source.type === 'show'
          ? await this.programs.getProgramGroupingDescendants(source.id, 'show')
          : await this.programs.getProgramsByIds([source.id])
      ).filter(
        (p) =>
          p.state === 'ok' &&
          hasSchedulableDuration(p.duration) &&
          !fillerIds.has(p.uuid),
      );
      pools.set(source.id, programs);
      const finalCredits = await this.durations.finalCreditEnds(
        request.channelId,
        programs.map((p) => p.uuid),
      );
      for (const [id, end] of finalCredits) ends.set(id, end);
      return programs;
    };
    const drawSeed = request.seed ?? createEntropy();
    const random = new Random(MersenneTwister19937.seedWithArray(drawSeed));
    const lineup: CondensedChannelProgram[] = [];
    const choices: GenerateSeedChannelResult['choices'] = [];
    const warnings = new Set<string>();
    const repeatWarning =
      'Related content exhausted the 20-item repeat window; repeats were allowed to fill the requested length.';
    const pickUnplayed = (pool: ProgramOrmWithExternalIds[]) => {
      const eligible = pool.filter((program) => !recent.includes(program.uuid));
      return eligible.length > 0 ? random.pick(eligible) : undefined;
    };
    const offsets: number[] = [];
    let durationMs = 0;
    let previous = anchors[0];
    const append = (
      source: SeedChannelSource,
      program: ProgramOrmWithExternalIds,
      reasons: string[],
      similarity: number,
      weight: number,
    ) => {
      offsets.push(durationMs);
      const duration = ends.get(program.uuid) ?? program.duration;
      lineup.push({ type: 'content', id: program.uuid, duration });
      choices.push({
        programId: program.uuid,
        title: program.title,
        sourceTitle: source.title,
        reasons,
        views: views.get(source.id) ?? 0,
        similarity,
        weight,
      });
      durationMs += duration;
      recent = [...recent, program.uuid].slice(-20);
      previous = source;
    };
    for (const item of initial) {
      const pool = await loadPool(item.source);
      let program = item.programId
        ? pool.find((p) => p.uuid === item.programId)
        : pickUnplayed(pool);
      if (!program && !item.programId && pool.length > 0) {
        program = random.pick(pool);
        warnings.add(repeatWarning);
      }
      if (!program)
        throw new ScheduleValidationError(
          `Seed ${item.source.title} has no playable non-filler item.`,
        );
      append(item.source, program, ['Chosen seed'], 0, 0);
    }

    while (durationMs < request.hours * 3_600_000 && lineup.length < 2000) {
      const ranked = catalog
        .map((source) => {
          const anchorMatch = anchors
            .map((anchor) => metadataMatch(anchor, source))
            .sort((a, b) => b.score - a.score)[0];
          const priorMatch = previous
            ? metadataMatch(previous, source)
            : undefined;
          const similarity =
            ((anchorMatch?.score ?? 0) + (priorMatch?.score ?? 0)) / 2;
          const matches = new Set([
            ...(anchorMatch?.reasons ?? []),
            ...(priorMatch?.reasons ?? []),
          ]);
          const count = views.get(source.id) ?? 0;
          const boost =
            1 + (request.familiarity / 100) * Math.min(4, Math.log2(1 + count));
          return {
            source,
            similarity,
            weight: similarity * boost,
            reasons: [...matches],
          };
        })
        .filter(
          (candidate) =>
            candidate.weight > 0 &&
            pools.get(candidate.source.id)?.length !== 0,
        );
      if (ranked.length === 0)
        throw new ScheduleValidationError(
          'No related playable titles were found. Add seeds with genres or tags.',
        );
      // Give other related titles a turn before returning to the same show.
      const alternatives = ranked.filter(
        (candidate) => candidate.source.id !== previous?.id,
      );
      const pending =
        alternatives.length > 0
          ? [
              ...alternatives,
              ...ranked.filter(
                (candidate) => candidate.source.id === previous?.id,
              ),
            ]
          : [...ranked];
      let selected = false;
      while (pending.length > 0) {
        const otherTitles = pending.filter((c) => c.source.id !== previous?.id);
        const eligible = otherTitles.length > 0 ? otherTitles : pending;
        let ticket = random.real(
          0,
          eligible.reduce((sum, c) => sum + c.weight, 0),
          false,
        );
        let candidate = eligible[eligible.length - 1];
        for (const item of eligible) {
          ticket -= item.weight;
          if (ticket < 0) {
            candidate = item;
            break;
          }
        }
        if (!candidate) break;
        pending.splice(pending.indexOf(candidate), 1);
        const pool = await loadPool(candidate.source);
        const program = pickUnplayed(pool);
        if (program) {
          append(
            candidate.source,
            program,
            candidate.reasons,
            candidate.similarity,
            candidate.weight,
          );
          selected = true;
        }
        if (selected) break;
      }
      if (!selected) {
        if (recent.length === 0)
          throw new ScheduleValidationError(
            'Related titles have no playable non-filler content.',
          );
        recent = [];
        warnings.add(repeatWarning);
      }
    }
    if (durationMs < request.hours * 3_600_000)
      warnings.add('Stopped at 2,000 items before the requested length.');
    const programs = await this.materialize.execute({ lineup });
    if (choices.some((choice) => !programs[choice.programId]))
      throw new ScheduleValidationError(
        'A selected program disappeared before preview. Generate again.',
      );
    return {
      lineup,
      programs,
      startTimeOffsets: offsets,
      durationMs,
      seed: drawSeed,
      choices,
      warnings: [...warnings],
    };
  }
}

import type { CondensedChannelProgram } from '@tunarr/types';
import type {
  GenerateSeedChannelRequest,
  GenerateSeedChannelResult,
} from '@tunarr/types/api';
import type { SeedSelectionExplanation } from '@tunarr/types/schemas';
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
import throttle from '../../util/throttle.ts';
import {
  createSeedChannelScorer,
  SEED_SCORING_BATCH_SIZE,
} from './SeedChannelScorer.ts';
import { createSemanticSeedChannelScorer } from './SemanticSeedChannelScorer.ts';

export type SeedChannelContinuation = {
  trigger: NonNullable<SeedSelectionExplanation['trigger']>;
  previousProgramId?: string;
  queuedProgramIds: string[];
};

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
    continuation?: SeedChannelContinuation,
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

    const continuationDocs = continuation
      ? await this.search.getPrograms([
          continuation.trigger.programId,
          ...(continuation.previousProgramId
            ? [continuation.previousProgramId]
            : []),
        ])
      : [];
    const sourceForProgram = (id: string | undefined) => {
      const doc = continuationDocs.find((item) => item.id === id);
      const sourceId =
        doc?.type === 'episode'
          ? doc.grandparent && decodeCaseSensitiveId(doc.grandparent.id)
          : doc?.id;
      return sourceId ? byId.get(sourceId) : undefined;
    };
    const watched = sourceForProgram(continuation?.trigger.programId);
    if (continuation && !watched)
      throw new ScheduleValidationError(
        'The watched title is unavailable in the search index.',
      );
    const trigger = continuation
      ? {
          ...continuation.trigger,
          title:
            watched && watched.title !== continuation.trigger.title
              ? `${watched.title} — ${continuation.trigger.title}`
              : continuation.trigger.title,
        }
      : undefined;

    const semanticScorer =
      request.recommendationMode === 'semantic'
        ? await createSemanticSeedChannelScorer(this.search, catalog, anchors)
        : undefined;
    const scorer =
      semanticScorer ?? (await createSeedChannelScorer(catalog, anchors));

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
    const queuedIds = new Set(continuation?.queuedProgramIds);
    const addedAt = Date.now();
    const lineup: CondensedChannelProgram[] = [];
    const choices: GenerateSeedChannelResult['choices'] = [];
    const warnings = new Set<string>();
    const repeatWarning =
      'Related content exhausted the 20-item repeat window; repeats were allowed to fill the requested length.';
    const pickUnplayed = (pool: ProgramOrmWithExternalIds[]) => {
      const eligible = pool.filter(
        (program) =>
          !recent.includes(program.uuid) && !queuedIds.has(program.uuid),
      );
      return eligible.length > 0 ? random.pick(eligible) : undefined;
    };
    const offsets: number[] = [];
    let durationMs = 0;
    let previous =
      sourceForProgram(continuation?.previousProgramId) ?? anchors[0];
    const append = (
      source: SeedChannelSource,
      program: ProgramOrmWithExternalIds,
      reasons: string[],
      similarity: number,
      weight: number,
    ) => {
      offsets.push(durationMs);
      const duration = ends.get(program.uuid) ?? program.duration;
      lineup.push({
        type: 'content',
        id: program.uuid,
        duration,
        selectionExplanation: {
          addedAt,
          trigger,
          reasons,
        },
      });
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
    for (const item of continuation ? [] : initial) {
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

    const maxItems = continuation ? 1 : 2000;
    while (durationMs < request.hours * 3_600_000 && lineup.length < maxItems) {
      if (semanticScorer) {
        if (previous) await semanticScorer.prepareSource(previous.id);
        if (watched) await semanticScorer.prepareSource(watched.id);
      }
      const ranked: {
        source: SeedChannelSource;
        similarity: number;
        weight: number;
        boost: number;
      }[] = [];
      for (const [index, source] of catalog.entries()) {
        if (index % SEED_SCORING_BATCH_SIZE === 0) await throttle();
        const anchorMatch = scorer.seedMatch(source.id);
        const priorScore = previous ? scorer.score(previous.id, source.id) : 0;
        const watchedScore = watched ? scorer.score(watched.id, source.id) : 0;
        const similarity =
          (anchorMatch.score + priorScore + watchedScore) / (watched ? 3 : 2);
        const count = views.get(source.id) ?? 0;
        const boost =
          1 + (request.familiarity / 100) * Math.min(4, Math.log2(1 + count));
        const weight = similarity * boost;
        if (weight > 0 && pools.get(source.id)?.length !== 0) {
          ranked.push({ source, similarity, weight, boost });
        }
      }
      if (ranked.length === 0)
        throw new ScheduleValidationError(
          semanticScorer
            ? 'No related playable titles were found for these semantic seeds.'
            : 'No related playable titles were found. Add seeds with genres or tags.',
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
          const seed = scorer.seedMatch(candidate.source.id).seed;
          const reasons = new Set([
            ...scorer
              .explain(seed.id, candidate.source.id)
              .map((reason) => `Matches seed ${seed.title}: ${reason}`),
            ...(previous
              ? scorer
                  .explain(previous.id, candidate.source.id)
                  .map(
                    (reason) =>
                      `Matches preceding title ${previous?.title}: ${reason}`,
                  )
              : []),
            ...(watched
              ? scorer
                  .explain(watched.id, candidate.source.id)
                  .map(
                    (reason) =>
                      `Matches watched title ${watched.title}: ${reason}`,
                  )
              : []),
          ]);
          if (candidate.boost > 1)
            reasons.add(
              `${views.get(candidate.source.id) ?? 0} recorded plays on this channel increased its selection weight by ${candidate.boost.toFixed(2)}×.`,
            );
          append(
            candidate.source,
            program,
            [...reasons],
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
    if (!continuation && durationMs < request.hours * 3_600_000)
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

import type { ProgramStreamLineupItem } from '../db/derived_types/StreamLineup.ts';
import { finalCreditsStart } from '../util/programChapterUtil.ts';
import type { StreamDetails } from './types.ts';

export function watchedProgram(
  item: ProgramStreamLineupItem,
  details: StreamDetails,
  airingStartMs: number,
) {
  const runtime = Math.min(
    item.program.duration,
    details.sourceDuration?.asMilliseconds() ?? item.program.duration,
  );
  return {
    programUuid: item.program.uuid,
    airingStartMs: Math.round(airingStartMs),
    airingDurationMs: Math.round(item.duration),
    sourceOffsetMs: Math.floor(item.startOffset ?? 0),
    contentEndMs: finalCreditsStart(details.chapters ?? [], runtime) ?? runtime,
  };
}

export type WatchWindow = {
  startMs: number;
  finishMs: number;
  program: ReturnType<typeof watchedProgram>;
};

type Segment = { start: number; end: number; sequence: number };
type Progress = {
  at: number;
  sequence: number;
  cursor: number;
  deliveredEnd: number;
};

const retainedMs = 10 * 60_000;

// The session owns this timeline. A new encoder session can reuse file names.
export class SeedWatchTimeline {
  private programs: WatchWindow[] = [];
  private segments = new Map<string, Segment>();
  private clients = new Map<string, Progress>();

  replaceFrom(startMs: number, windows: WatchWindow[]) {
    this.programs = this.programs
      .filter(
        (w) => w.startMs < startMs && w.finishMs > Date.now() - retainedMs,
      )
      .map((w) => ({ ...w, finishMs: Math.min(w.finishMs, startMs) }))
      .concat(windows);
  }

  readPlaylist(playlist: string) {
    if (!this.programs.length) return;
    let start = NaN;
    let duration = NaN;
    for (const line of playlist.split(/\r?\n/)) {
      if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        start = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
      } else if (line.startsWith('#EXTINF:')) {
        duration = Math.round(Number.parseFloat(line.slice(8)) * 1000);
      } else if (line && !line.startsWith('#')) {
        const name = line.slice(line.lastIndexOf('/') + 1);
        const match = /^(?:data|live)(\d+)\.(?:ts|mp4)$/.exec(name);
        if (match && Number.isFinite(start) && duration > 0) {
          this.segments.set(name, {
            start,
            end: start + duration,
            sequence: Number(match[1]),
          });
        }
        start = duration = NaN;
      }
    }
    // Keep recent manifests for viewers requesting a slightly older window.
    while (this.segments.size > 256)
      this.segments.delete(this.segments.keys().next().value!);
    const cutoff = performance.now() - retainedMs;
    for (const [client, progress] of this.clients) {
      if (progress.at < cutoff) this.clients.delete(client);
    }
  }

  hasSegment(file: string) {
    return this.segments.has(file);
  }

  delivered(file: string, client: string, at: number) {
    const segment = this.segments.get(file);
    if (!segment) return [];
    const previous = this.clients.get(client);
    if (previous && previous.sequence >= segment.sequence) return [];
    const gap = previous ? at - previous.at : 0;
    const duration = segment.end - segment.start;
    // Players can fetch several segments together, then play the whole batch
    // before requesting another. An idle gap must exceed that buffered span.
    const buffered = previous ? previous.deliveredEnd - previous.cursor : 0;
    if (
      !previous ||
      previous.sequence + 1 !== segment.sequence ||
      gap > Math.max(2 * duration, buffered + duration) + 1000
    ) {
      this.clients.set(client, {
        at,
        sequence: segment.sequence,
        cursor: segment.start,
        deliveredEnd: segment.end,
      });
      return [];
    }
    const from = previous.cursor;
    const to = Math.min(segment.end, from + Math.max(0, Math.floor(gap)));
    this.clients.set(client, {
      at,
      sequence: segment.sequence,
      cursor: to,
      deliveredEnd: segment.end,
    });
    return this.programs.flatMap(({ startMs, finishMs, program }) => {
      const fromMs = program.sourceOffsetMs + Math.max(startMs, from) - startMs;
      const toMs = Math.min(
        program.contentEndMs,
        program.sourceOffsetMs + Math.min(finishMs, to) - startMs,
      );
      return toMs > fromMs ? [{ ...program, fromMs, toMs }] : [];
    });
  }
}

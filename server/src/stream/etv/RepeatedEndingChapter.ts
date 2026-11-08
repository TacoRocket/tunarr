import type { MediaChapter } from '@tunarr/types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const pixels = 16 * 12;

type Episode = { path: string; duration: number; chapters: MediaChapter[] };

function meanDifference(first: Buffer, second: Buffer) {
  let sum = 0;
  for (let i = 0; i < pixels; i++) sum += Math.abs(first[i]! - second[i]!);
  return sum / pixels;
}

async function sampleChapter(
  ffmpeg: string,
  path: string,
  chapter: MediaChapter,
) {
  const frames: Buffer[] = [];
  for (const fraction of [0.25, 0.5, 0.75]) {
    const ms =
      chapter.startTime + fraction * (chapter.endTime - chapter.startTime);
    const { stdout } = await run(
      ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-ss',
        String(ms / 1000),
        '-i',
        path,
        '-map',
        '0:v:0',
        '-an',
        '-sn',
        '-frames:v',
        '1',
        '-vf',
        'scale=16:12:flags=area,format=gray',
        '-threads',
        '1',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { encoding: 'buffer', timeout: 5000, maxBuffer: 64 * 1024 },
    );
    if (stdout.length !== pixels)
      throw new Error('Incomplete ending chapter frame');
    frames.push(stdout);
  }
  return frames;
}

async function sampleEndingCandidates(ffmpeg: string, episode: Episode) {
  const late = episode.chapters
    .filter(
      (c) =>
        c.chapterType === 'chapter' &&
        c.startTime >= episode.duration * 0.8 &&
        c.startTime < c.endTime &&
        c.startTime < episode.duration,
    )
    .sort((a, b) => a.startTime - b.startTime);
  // Avoid sampling an unbounded number of tiny chapters in an unusual file.
  if (late.length < 2 || late.length > 4) return [];
  const samples: { chapter: MediaChapter; frames: Buffer[] }[] = [];
  for (const chapter of late) {
    samples.push({
      chapter,
      frames: await sampleChapter(ffmpeg, episode.path, chapter),
    });
  }
  return samples.flatMap(({ chapter, frames }, i) => {
    const following = samples[i + 1];
    if (
      !following ||
      following.chapter.startTime !== chapter.endTime ||
      !/^(?:chapter\s*)?\d*$/i.test(chapter.title?.trim() ?? '') ||
      meanDifference(frames[0]!, frames[1]!) < 12 ||
      meanDifference(frames[1]!, frames[2]!) < 12
    )
      return [];
    return [{ chapter, frames, next: following.frames }];
  });
}

// A repeated moving ending should match throughout the chapter, then diverge
// in the following chapter. A still card or shared opening is insufficient.
export async function findRepeatedEnding(
  ffmpeg: string,
  first: Episode,
  second: Episode,
) {
  if (first.path === second.path) return;
  const a = await sampleEndingCandidates(ffmpeg, first);
  if (!a.length) return;
  const b = await sampleEndingCandidates(ffmpeg, second);
  const matches = a.flatMap((left) =>
    b
      .filter(
        (right) =>
          left.frames.every(
            (frame, i) => meanDifference(frame, right.frames[i]!) <= 6,
          ) &&
          left.next.filter(
            (frame, i) => meanDifference(frame, right.next[i]!) >= 15,
          ).length >= 2,
      )
      .map((right) => [left.chapter, right.chapter] as const),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

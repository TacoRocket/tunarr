import type { MediaChapter } from '@tunarr/types';

export function finalCreditsStart(
  chapters: ReadonlyArray<
    Pick<MediaChapter, 'chapterType' | 'isFinal' | 'startTime' | 'endTime'>
  >,
  duration: number,
): number | undefined {
  const finals = chapters.filter(
    (chapter) => chapter.chapterType === 'outro' && chapter.isFinal === true,
  );
  const marker = finals.length === 1 ? finals[0] : undefined;
  if (
    marker &&
    Number.isFinite(marker.startTime) &&
    Number.isFinite(marker.endTime) &&
    marker.startTime > 0 &&
    marker.startTime < marker.endTime &&
    marker.endTime <= duration
  )
    return marker.startTime;
  return undefined;
}

export function episodeEndingChapter(
  chapters: readonly MediaChapter[],
  duration: number,
  sampled?: Pick<MediaChapter, 'startTime' | 'endTime'>,
): MediaChapter | undefined {
  const endings = chapters.filter(
    (chapter) =>
      chapter.chapterType === 'chapter' &&
      /^(ed|ending(?: credits| theme)?|end credits|credits|outro)$/i.test(
        chapter.title?.trim() ?? '',
      ),
  );
  if (endings.length > 1) return;
  const ending =
    endings[0] ??
    (sampled &&
      chapters.find(
        (chapter) =>
          chapter.chapterType === 'chapter' &&
          chapter.startTime === sampled.startTime &&
          chapter.endTime === sampled.endTime,
      ));
  if (
    ending &&
    ending.startTime > 0 &&
    ending.startTime < ending.endTime &&
    ending.endTime <= duration
  )
    return ending;
  return undefined;
}

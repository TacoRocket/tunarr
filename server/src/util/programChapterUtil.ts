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

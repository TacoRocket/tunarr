import { GlobalScheduler } from '../../src/services/Scheduler.ts';
import { SubtitleExtractorTask } from '../../src/tasks/SubtitleExtractorTask.ts';
import { UpdateXmlTvTask } from '../../src/tasks/UpdateXmlTvTask.ts';

/**
 * Returns a check that turns true once the guide refresh, and the subtitle
 * sweep it fires after writing the guide, have both finished since this call.
 *
 * Use as `settledWhen` so a measurement ends when the background work does
 * rather than after a fixed wait. Call it right before the operation. The
 * check stays false, so the full settle window applies, when the jobs are not
 * registered (`initTestApp(port, { registerGuideTask: true })`) or one is
 * already running: an earlier run ending would otherwise look like the
 * measured one finishing.
 *
 * Only use it where the measured operation is the sole source of runs. A job's
 * `running` flag follows its latest start or finish, so with overlapping runs
 * it can read false while an earlier run is still in flight.
 */
export function guideRefreshFinished(): () => boolean {
  const since = Date.now();
  const ids = [UpdateXmlTvTask.ID, SubtitleExtractorTask.ID];
  const jobs = ids.flatMap((id) => GlobalScheduler.getScheduledJobs(id) ?? []);
  if (jobs.length !== ids.length || jobs.some((job) => job.running)) {
    return () => false;
  }
  return () =>
    jobs.every(
      (job) =>
        !job.running &&
        job.lastExecution !== undefined &&
        +job.lastExecution >= since,
    );
}

# Server settings

Environment variables the fork adds or changes. Everything else is in [Tunarr's list](https://tunarr.com/getting-started/run/).

| Variable | CLI | Default | What it does |
| --- | --- | --- | --- |
| `TUNARR_WORKER_POOL_SIZE` | N/A | CPU count, up to 8 | Number of scheduling workers started at boot, or the maximum when idle retirement is enabled. Recommended: no more than the number of CPUs on the host. |
| `TUNARR_WORKER_IDLE_TIMEOUT_MS` | N/A | `0` | Opt in with `60000` to start scheduling workers on demand and retire them after 60 seconds with no outstanding jobs. The pool can return to zero workers; the next scheduling request pays worker startup time. The default `0` starts the full pool at boot and keeps it running. |

The worker pool keeps slot scheduling off the server's main thread. Optional idle retirement releases unused workers while retaining the same configured maximum concurrency. Active playback uses separate FFmpeg processes. Idle retirement waits for queued and running scheduling jobs to finish; it does not cancel them. The implementation is in `server/src/services/TunarrWorkerPool.ts`.

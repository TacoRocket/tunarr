# Server settings

Environment variables the fork adds or changes. Everything else is in [Tunarr's list](https://tunarr.com/getting-started/run/).

| Variable | CLI | Default | What it does |
| --- | --- | --- | --- |
| `TUNARR_WORKER_POOL_SIZE` | N/A | CPU count, up to 8 | Number of scheduling workers started at boot, or the maximum when idle retirement is enabled. Recommended: no more than the number of CPUs on the host. |
| `TUNARR_WORKER_IDLE_TIMEOUT_MS` | N/A | `0` | Opt in with `60000` to start scheduling workers on demand and retire them after 60 seconds with no outstanding jobs. The pool can return to zero workers; the next scheduling request pays worker startup time. The default `0` starts the full pool at boot and keeps it running. |
| `TUNARR_PLEX_SCAN_METADATA_BATCH_SIZE` | N/A | `1` | Opt in with `20` to fetch Plex movie and episode metadata in groups. Integers above 100 are capped at 100; invalid values and values below 2 use individual requests. Restart Tunarr after changing this setting. |

The worker pool keeps slot scheduling off the server's main thread. Optional idle retirement releases unused workers while retaining the same configured maximum concurrency. Active playback uses separate FFmpeg processes. Idle retirement waits for queued and running scheduling jobs to finish; it does not cancel them. The implementation is in `server/src/services/TunarrWorkerPool.ts`.


## Plex scan batching

Batching reduces the number of requests Tunarr makes to Plex during a library scan. Set `TUNARR_PLEX_SCAN_METADATA_BATCH_SIZE=20` and restart Tunarr to try it. Leave it unset or set it to `1` to keep individual requests.

The scanner still walks the full library and requests the same metadata, including chapters and markers. Show and season relationships, path filters, and force-scan behavior stay the same. Failed batches and missing or unconvertible items fall back to individual requests. A failed batch adds a request and delay before recovery. Cancellation stops further batches but does not interrupt a request already in flight.

In one copied-data comparison on Bun 1.4.4 and Meilisearch 1.52.4, an incremental scan of 1,418 movies finished in 20.2 seconds with batches of 20, compared with 31.7 seconds using individual requests. Catalog contents matched. Peak container anonymous memory rose from 367 to 405 MiB; 20 seconds after completion it was 301 versus 309 MiB.

That was one sequential comparison of a mostly unchanged movie library, not a full reindex or TV-library benchmark. Plex caching and library contents affect the result. Batching is an opt-in speed setting and can use more memory; it does not add indexing pacing or a separate post-scan indexing phase.

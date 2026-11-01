# Server settings

Environment variables the fork adds or changes. Everything else is in [Tunarr's list](https://tunarr.com/getting-started/run/).

| Variable | CLI | Default | What it does |
| --- | --- | --- | --- |
| `TUNARR_WORKER_POOL_SIZE` | N/A | CPU count, up to 8 | Number of scheduling workers started at boot, or the maximum when idle retirement is enabled. Recommended: no more than the number of CPUs on the host. |
| `TUNARR_WORKER_IDLE_TIMEOUT_MS` | N/A | `0` | Opt in with `60000` to start scheduling workers on demand and retire them after 60 seconds with no outstanding jobs. The pool can return to zero workers; the next scheduling request pays worker startup time. The default `0` starts the full pool at boot and keeps it running. |
| `TUNARR_PLEX_SCAN_METADATA_BATCH_SIZE` | N/A | `1` | Opt in with `20` to fetch Plex movie and episode metadata in groups. Integers above 100 are capped at 100; invalid values and values below 2 use individual requests. Restart Tunarr after changing this setting. |
| `TUNARR_PLEX_NOTIFICATIONS` | N/A | `false` | Opt in with `true` to refresh Plex movies and affected TV shows from item notifications between normal scans. Restart after changing this setting. The normal scan schedule stays unchanged. |

The worker pool keeps slot scheduling off the server's main thread. Optional idle retirement releases unused workers while retaining the same configured maximum concurrency. Active playback uses separate FFmpeg processes. Idle retirement waits for queued and running scheduling jobs to finish; it does not cancel them. The implementation is in `server/src/services/TunarrWorkerPool.ts`.


## Plex scan batching

Batching reduces the number of requests Tunarr makes to Plex during a library scan. Set `TUNARR_PLEX_SCAN_METADATA_BATCH_SIZE=20` and restart Tunarr to try it. Leave it unset or set it to `1` to keep individual requests.

The scanner still walks the full library and requests the same metadata, including chapters and markers. Show and season relationships, path filters, and force-scan behavior stay the same. Failed batches and missing or unconvertible items fall back to individual requests. A failed batch adds a request and delay before recovery. Cancellation stops further batches but does not interrupt a request already in flight.

In one copied-data comparison on Bun 1.4.4 and Meilisearch 1.52.4, an incremental scan of 1,418 movies finished in 20.2 seconds with batches of 20, compared with 31.7 seconds using individual requests. Catalog contents matched. Peak container anonymous memory rose from 367 to 405 MiB; 20 seconds after completion it was 301 versus 309 MiB.

That was one sequential comparison of a mostly unchanged movie library, not a full reindex or TV-library benchmark. Plex caching and library contents affect the result. Batching is an opt-in speed setting and can use more memory; it does not add indexing pacing or a separate post-scan indexing phase.


## Plex notifications

Plex notifications refresh changed movies and TV shows between scans, and let the next normal scan reuse successful item refreshes. Set `TUNARR_PLEX_NOTIFICATIONS=true` and restart Tunarr to try it. Leave it unset or set it to `false` to use scans alone. Only enabled, available Plex movie and TV libraries participate; the scan schedule stays unchanged.

A completed item notification refreshes that movie, or the affected show's seasons and episodes, through the existing importer and search index. TV updates include specials; they do not assume a season alone describes a show. Repeated events are coalesced for five seconds. Refreshes share the normal scan queue and library locks, and retain subtitle handling, duration reconciliation, trash repair, and smart filler synchronization.

After an item is successfully imported or confirmed unchanged using full metadata, Tunarr keeps a small, one-use acknowledgement. The next ordinary scan still lists the library for additions and deletions, but skips that item's full-detail request if its saved metadata and listing-visible fields still match. Batching also excludes those items from detail requests. Failed imports do not earn an acknowledgement. Forced scans always fetch details; collections, show/season traversal, and uncovered items keep their existing scan behavior.

Library scan activity, item events outside the scan-echo window, or a disconnect discard acknowledgements for the affected library or source. Reconnecting does not replay missed events or start an extra full scan. Connections retry within 30 seconds, and source, credential, or library availability changes are picked up on the same interval. Acknowledgements are held in memory, capped at 10,000 items, and disappear on restart or eviction; all of those cases restore normal detail reads.

Keep normal scans enabled. Plex listings omit streams and markers, and the trial did not establish complete intro/credits marker notification coverage. Reuse lasts for one scan only: an unannounced detail-only change can wait until the following scan, one interval longer than scans alone. The next scan still checks an item if visible fields changed or an invalidating event arrived. A sidecar subtitle addition in the Plex trial emitted library activity rather than an item notification; that activity restores normal detail reads.

Plex metadata reads can themselves emit notifications. Tunarr ignores timeline echoes for a library while it is scanning or handling a notification, and for five seconds after a notification refresh. Deletion events and library scan activity still invalidate acknowledgements during that window. An indistinguishable detail-only change during the window has the same one-extra-scan limit. The pending queue holds at most 100 distinct items; excess events and failed refreshes defer to normal scans. Disconnects and failed refreshes are logged.

This reduces duplicate detail reads after a notification refresh. It does not promise fewer total requests than scans alone: refreshing an affected TV show still walks its seasons and episodes. Notifications provide earlier updates; batching separately reduces request count during scans.

# ErsatzTV next integration

## Credit advertisement plans

`CreditSqueezeAdPlanner` uses the existing uniform shuffle-bag iterators and
`selectWholePod` to materialize one ad sequence per channel/program airing.
`node-cache` owns TTL expiration; the singleton service caches the in-flight
promise so concurrent writers share the same plan. The seeded draw is reproducible
across restarts for unchanged pool contents. This is process-local retention,
not a durable schedule.

The writer resolves each selected source through the usual media source fetcher
and caps the returned item at the next ad boundary, ending chapter boundary, or original program end. Both
dynamic callbacks and pre-materialized windows use that same result. Source
points retain program and ad positions independently; the regular after-show
pod remains in the original lineup. No selection occurs in the worker.

`EpisodeEndingPreparation` checks the upcoming guide through
`PrepareEpisodeEndingsTask`. `RepeatedEndingChapter` compares three downscaled
grayscale frames from each late chapter of two episodes. A matched sequence
must move within each episode and diverge in the next chapter. Preparation
persists the outcome for the source revision. An exclusive file creation
reserves the single Plex scan request before dispatch, so a lost response or
restart can trigger a metadata read without repeating the request.

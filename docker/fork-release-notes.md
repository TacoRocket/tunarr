# 2026.10.4-trfork.9

A small release on purpose: one search engine update, on its own, so it's easy to check and easy to undo.

## Under the hood

- **Search engine update.** Meilisearch moves from 1.39.0 to 1.52.4. It powers library search, smart collections and the filler lists that follow them, so we keep it current the way we keep FFmpeg current. Versions 1.40 through 1.52.3 were skipped on purpose: they use a memory allocator that can crash or leak threads under load. (#87)

## Before you upgrade

- **The search upgrade is one-way.** On first start, Meilisearch converts your search index in place, and older images can't open it afterwards. Stop Tunarr and copy the `data.ms` and `ms-snapshots` folders from your Tunarr data folder first, so you can go back. [How to back up and roll back](https://github.com/TacoRocket/tunarr/blob/main/docs/fork/container.md#search-engine-upgrades)
- **Running your own Meilisearch** with `TUNARR_MEILISEARCH_PATH`? It needs version 1.51 or newer now.
- Nothing else changes from trfork.8: same database, same FFmpeg runtime.

# Repair re-added items

When Plex (or another media server) rebuilds a library or swaps in an upgraded file, the item comes back under a new ID. Tunarr sees a brand-new item and puts the old record in the Trash, while your channels, custom shows and filler lists still point at the old one. Emptying the Trash would turn every one of those spots into flex.

A **repair** fixes that instead. Tunarr finds the old item's healthy copy and merges the old record into it:

- **How you use the show moves to the copy:** channel lineups (same spot, same schedule and seed, same clock), custom shows, filler lists, watch history and collections.
- **Facts about the old file go with it:** its streams, chapters, subtitles, artwork and file paths. The copy has its own.
- **The old record is removed only after nothing uses it,** and a full copy of it is saved first in `trash-repairs/` inside Tunarr's data folder.

The Trash is then left holding only things that are really gone.

## Exact matches are repaired; everything else is a question

A trashed item is repaired without asking only when there is **exactly one healthy copy, from the same media source, of the same type, sharing a stable ID**: Plex's GUID, IMDb, TMDB or TVDB. Episodes also have to keep the same season and episode numbers.

Anything less certain is never changed on its own. It becomes a **"Same show, new file?"** question:

| Reason | Example |
| --- | --- |
| `several_copies` | Two healthy copies share the ID (a 4K and a 1080p file) |
| `other_media_source` | The only copy is in a different server, such as the same film in Jellyfin |
| `numbers_differ` | The ID matches but the episode numbers don't |
| `details_match_only` | No shared ID, but the same show, season and episode, or the same title and year |

Answer "yes" to merge into the copy you pick, or dismiss it. A dismissed question comes back only if a different healthy copy turns up.

## Turning it on

Repairs run automatically **at startup, after every library scan, and right before the Trash is emptied** once this is on:

```bash
TUNARR=http://localhost:8000
curl -s $TUNARR/api/settings/media-source \
  | jq '.repairReaddedItems = true' \
  | curl -s -X PUT $TUNARR/api/settings/media-source \
      -H 'Content-Type: application/json' -d @-
```

It's off by default. You can always run a repair by hand:

```bash
curl -s $TUNARR/api/trash/repair                     # what would happen; changes nothing
curl -s -X POST $TUNARR/api/trash/repair \
  -H 'Content-Type: application/json' -d '{"dryRun": true}'
curl -s -X POST $TUNARR/api/trash/repair \
  -H 'Content-Type: application/json' -d '{}'        # repair the exact matches
curl -s -X POST $TUNARR/api/trash/repair \
  -H 'Content-Type: application/json' \
  -d '{"confirm": [{"oldId": "...", "healthyId": "..."}]}'   # answer a question
curl -s -X POST $TUNARR/api/trash/repair/dismiss \
  -H 'Content-Type: application/json' -d '{"oldIds": ["..."]}'
```

## Good to know

- If the healthy copy is a different length, Tunarr's usual duration fix runs for it afterwards. Slot channels are regenerated from the same seed, and other channels keep their place in the loop.
- A channel that plays another channel's lineup (an offset channel, #55) is updated through its source.
- The receipt is a record, not a one-click undo. It holds everything needed to put an old record back by hand.

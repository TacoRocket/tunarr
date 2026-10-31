# Repair re-added items

When Plex (or another media server) rebuilds a library or swaps in an upgraded file, the item comes back under a new ID. Tunarr sees a brand-new item and puts the old record in the Trash, while your channels, custom shows and filler lists still point at the old one. Emptying the Trash would turn every one of those spots into flex.

A **repair** fixes that instead. Tunarr finds the old item's healthy copy and merges the old record into it:

- **How you use the show moves to the copy:** channel lineups (same spot, same schedule and seed, same clock), custom shows, filler lists, watch history and collections.
- **Facts about the old file go with it:** its streams, chapters, subtitles, artwork and file paths. The copy has its own.
- **The old record is removed only after nothing uses it,** and a full copy of it is saved first in `trash-repairs/` inside Tunarr's data folder.

The Trash is then left holding only things that are really gone.

## Exact matches are repaired; everything else is a question

A trashed item is repaired without asking only when there is **exactly one healthy copy, from the same media source, of the same type, sharing a stable ID**: Plex's GUID, IMDb, TMDB or TVDB. Season and episode numbers don't count against it: when Sonarr re-files a season finale as a special, its IDs still match and it's repaired.

Anything less certain is never changed on its own. It becomes a **"Same show, new file?"** question:

| Reason | Example |
| --- | --- |
| `several_copies` | Two healthy copies share the ID (a 4K and a 1080p file) |
| `other_media_source` | The only copy is in a different server, such as the same film in Jellyfin |
| `details_match_only` | No shared ID, but the same show, season and episode, or the same title and year |

Answer "yes" to merge into the copy you pick, or dismiss it. A dismissed question comes back only if a different healthy copy turns up.

## Turning it on

Repairs run automatically **after every library scan and right before the Trash is emptied** once this is on:

```bash
TUNARR=http://localhost:8000
curl -s $TUNARR/api/settings/media-source \
  | jq '.repairReaddedItems = true' \
  | curl -s -X PUT $TUNARR/api/settings/media-source \
      -H 'Content-Type: application/json' -d @-
```

It's off by default. Repairing at startup is a separate option, also off, so a big Trash never adds work while Tunarr is starting. Add it with `.repairReaddedItemsOnStartup = true` in the same command. It runs once Tunarr is already online.

Large repairs run in batches of 250 with a pause between, like Empty Trash, so streams and the web UI stay responsive. Each batch gets its own receipt file.

You can always run a repair by hand:

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

## Before you empty the Trash

Ask what emptying would do. Nothing changes:

```bash
curl -s $TUNARR/api/trash/impact
```

```json
{
  "total": 40,
  "repairedFirst": 4,
  "unused": 33,
  "used": [
    {
      "id": "...", "title": "Six Month Leave", "showTitle": "Mad Men",
      "uses": { "channels": 2, "customShows": 1, "fillerLists": 0, "playHistory": 3 },
      "repair": "question"
    }
  ],
  "affected": { "channels": 2, "customShows": 1, "fillerLists": 0 }
}
```

- `repairedFirst`: merged into their healthy copies before anything is deleted (automatic repairs are on).
- `unused`: nothing plays them anywhere. Either kind of Empty Trash removes them.
- `used`: a channel, custom show or filler list still plays them. A full Empty Trash turns those spots into flex. `repair` says when a repair could save one instead: `"question"` is an unanswered "Same show, new file?", and `"exact"` means automatic repairs are off but a repair would merge it.

Channel use is read from the lineups themselves, the same ones Empty Trash rewrites. Watch history is listed, but on its own it doesn't count as a use.

To empty only what nothing uses:

```bash
curl -s -X DELETE "$TUNARR/api/trash?onlyUnused=true"
```

Everything in `used` stays in the Trash and keeps playing. The status (`GET /api/trash/status`) shows `"onlyUnused": true` and how many items were `kept`. Like a full Empty Trash, it repairs first when automatic repairs are on, resumes after a restart in the same mode, and if checking what is still used fails, nothing is deleted.

## Good to know

- If the repair right before Empty Trash fails (for example, Tunarr can't write the receipt), **nothing is deleted**. Empty Trash shows as failed with the reason, and it tries again the next time Tunarr starts. A failed repair after a library scan is only logged.
- If the healthy copy is a different length, Tunarr's usual duration fix runs for it afterwards. Slot channels are regenerated from the same seed, and other channels keep their place in the loop.
- A channel that plays another channel's lineup (an offset channel, #55) is updated through its source.
- The receipt is a record, not a one-click undo. It holds everything needed to put an old record back by hand.

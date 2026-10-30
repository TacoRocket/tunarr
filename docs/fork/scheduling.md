## After-show pod configuration through the API

Program-count content slots can include `postProgramPod`, an ordered array of positions. Each position selects one whole clip from one of its `fillerListIds`. For example, two commercial positions followed by a cross-channel promo and a closer use four entries:

```json
{
  "postProgramPod": [
    { "fillerListIds": ["00000000-0000-4000-8000-000000000001"] },
    { "fillerListIds": ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"] },
    { "fillerListIds": ["00000000-0000-4000-8000-000000000003"] },
    { "fillerListIds": ["00000000-0000-4000-8000-000000000004"] }
  ]
}
```

Replace these example IDs with existing filler lists and add the field to a content slot with `durationSpec.type: "dynamic"`. The field is accepted by the existing scheduling API; there is no pod editor in the UI yet. Add or remove positions to set the commercial count, or give a position a `count`: `{ "fillerListIds": ["..."], "count": 3 }` plays three clips from it, the same as repeating the position three times. A clip already in the break is skipped while its pool has another one, so a catch-all pool alongside a category pool doesn't play the same clip twice in one break. A pool smaller than the break repeats. A one-item pool intentionally supplies the same clip every time. Existing uniform shuffle selection handles larger pools.

A pool can fill itself from a saved search instead of a hand-picked list. See [Filler lists from a Smart Collection](/configure/library/filler#filler-lists-from-a-smart-collection).

The pod follows each complete program, and its full duration is included before the next program starts. It replaces that slot's legacy single post-program filler; head, pre and tail filler remain independent. Empty or missing selected pools fail generation instead of producing a partial break. Fixed-duration and time-slot schedules reject pods. Schedules without `postProgramPod` keep their existing behavior.

Commercial, promo and closer are example assignments, not required roles. A supplied recipe must contain at least one position; an empty array is rejected. Omitting `postProgramPod` retains the legacy post-filler configuration. Clips are selected when the schedule is generated or regenerated and saved in the lineup, rather than selected again during each airing.

## Filler Lists From a Smart Collection

A filler list can be linked to a [Smart Collection](/configure/library/smart-collections), so its programs come from a saved search instead of being picked by hand. Local libraries of other videos tag each file with its folder path and with any `<tag>` in its `.nfo` file, so a folder of commercials can become a filler list:

```
tags = "/commercials/Nintendo" AND type = "other_video"
```

Keep a `type` condition in the search, so that a show or movie sharing a tag never ends up in a commercial break.

Linking is available through the API for now:

- Create a linked list: `POST /api/filler-lists` with `name` and `smartCollectionId` instead of `programs`.
- Link an existing list: `PUT /api/filler-lists/{id}` with `smartCollectionId`. This replaces the list's programs.
- Unlink: `PUT /api/filler-lists/{id}` with `"smartCollectionId": null`. The list keeps its current programs and can be edited by hand again.
- Sync now: `POST /api/filler-lists/{id}/sync`.

A linked list is synced when it is linked, after every library scan, and when the sync endpoint is called. A sync copies the search's current playable clips into the list. Matching shows, seasons, artists and albums are skipped rather than expanded into everything they contain. If the search finds no playable clips, can't run, or indexing is detected before the search or after resolving the playable clips, the list keeps its previous programs. These checks do not lock the index or guarantee that it stayed unchanged throughout the search. A Smart Collection with no search filter or keywords matches the whole library, so it can't be linked. While a list is linked, it can be renamed but its programs can't be edited by hand. Deleting the Smart Collection unlinks the list and keeps its programs.

Everything that uses filler lists works the same way with a linked list, including channel flex filler, slot filler, after-show pods and filler refresh. A lineup that was already generated keeps the clips it drew; regenerate or refresh it to pick up new ones.

A filler list can also take its programs from a Smart Collection, so commercials, bumpers or trailers that match a saved search are added to filler without editing the list. See [Filler lists from a Smart Collection](/configure/library/filler#filler-lists-from-a-smart-collection).

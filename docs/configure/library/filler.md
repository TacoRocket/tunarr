# Filler

Filler lists are collections of content that are used by [Flex](/configure/channels/flex) to pad time between episodes. One reason to use Filler is to simulate traditional television by playing advertisements between episode airings. 

There are many places to source filler videos from. [DizqueTV's Wiki](https://github.com/vexorian/dizquetv/wiki) has plenty of filler repositories listed. Many of these are YouTube playlists, so you can use tools like MeTube to rip the playlist, and then add a new library to Plex with these filler videos, which can then be used by Tunarr's Filler lists. 

To get started, from the side panel select "Library", "EDIT FILLERS", then "NEW".

![Library](/assets/library.png)

![Filler](/assets/library-filler.png)

![Filler new](/assets/library-filler-new.png)

Add a name for your filler list, then select "ADD MEDIA". 

![Filler new add media](/assets/library-filler-new-addmedia.png)

Select the library with your Filler content, then select "ADD MOVIE" for each item you'd like to include. 

![Filler new add media 2](/assets/library-filler-new-addmedia2.png)

Expand the menu on the right to view a summary of your changes, then select "ADD ITEMS" followed by "SAVE". 

![Filler menu](/assets/library-filler-menu.png)

![Filler add items](/assets/library-filler-additems.png)

![Filler add items save](/assets/library-filler-save.png)

To use a filler list with your channels, edit your channel and select the [Flex](/configure/channels/flex) tab.

For how Tunarr decides which clip to play at each break, see [How Filler Is Chosen](/configure/library/filler-selection).

## Filler Types

When using slot-based scheduling tools ([Slot Editor](/configure/scheduling/random-slots), [Time Slots](/configure/scheduling/time-slots)), filler lists can be assigned to specific positions within a slot:

| Type | When it plays |
|------|--------------|
| **Head** | At the beginning of each slot |
| **Pre** | Before each program within a slot |
| **Post** | After each program within a slot |
| **Tail** | At the end of each slot |
| **Mid** | During [mid-roll breaks](/configure/scheduling/mid-roll-breaks) inserted within a program |
| **Fallback** | During flex time in the slot |

!!! note
    These filler types are only available in slot-based schedulers. When adding filler directly to a channel via the Flex tab, the filler is used to fill flex time only.

For details on mid-roll breaks, see the [Mid-Roll Breaks](/configure/scheduling/mid-roll-breaks) scheduling guide.

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

A linked list is synced when it is linked, after every library scan, and when the sync endpoint is called. A sync copies the search's current playable clips into the list. Matching shows, seasons, artists and albums are skipped rather than expanded into everything they contain. If the search finds no playable clips, can't run, or the search index is still updating, the list keeps its previous programs. A Smart Collection with no search filter or keywords matches the whole library, so it can't be linked. While a list is linked, it can be renamed but its programs can't be edited by hand. Deleting the Smart Collection unlinks the list and keeps its programs.

Everything that uses filler lists works the same way with a linked list, including channel flex filler, slot filler, after-show pods and filler refresh. A lineup that was already generated keeps the clips it drew; regenerate or refresh it to pick up new ones.

# Scheduling

The fork adds a few things that make a channel feel like real TV: commercial breaks between shows, skipping the end credits, and commercials that keep themselves up to date.

## Show scheduling presets

Presets build a rotation of shows without setting up every slot by hand. They are API-only while upstream's UI redesign is in progress.

| Preset | Starting pattern |
| --- | --- |
| `marathon` | Four sequential episodes of each selected show, then the next show. |
| `primetime` | Two sequential episodes of each show in a recurring rotation. |
| `saturday-morning` | One episode per show, rotating through the cartoons you select. |
| `variety` | Two sequential episodes of one show, then two shuffled wildcard programs; repeat for the next show. |

Call `POST /api/programming/presets` with the shows in rotation order, or use a Smart Collection for Variety's main shows as described below. It returns an ordinary Random Slots schedule, without generating programming or changing a channel:

```bash
TUNARR=http://localhost:8000
curl -fsS "$TUNARR/api/programming/presets" \
  -H 'Content-Type: application/json' \
  -d '{
    "preset": "variety",
    "showIds": ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"],
    "wildcard": {"type": "custom-show", "customShowId": "00000000-0000-4000-8000-000000000003"},
    "maxDays": 1,
    "postProgramPod": [{"fillerListIds": ["00000000-0000-4000-8000-000000000004"], "count": 2}]
  }' > schedule.json
```

Replace these example IDs with Tunarr show, Custom Show and filler-list IDs. Variety follows the Colony Drop pattern: a pair from one series, then two wildcards. Its wildcard pool can be a Custom Show or a Smart Collection (`{"type":"smart-collection","smartCollectionId":"..."}`) containing episodes, movies or specials. Each wildcard turn continues the same shuffle rather than restarting it. Selected shows keep their own episode progression, separate from the wildcard pool.

For the other presets, omit `wildcard`. Omit `postProgramPod` for no ads, or supply an existing [after-show pod recipe](#after-show-ad-pods); the recipe is applied after every program, including wildcards. `maxDays` defaults to `1` and has the same meaning as the existing Random Slots generation setting.

### Main shows from a Smart Collection

For Variety, replace `showIds` with `showCollectionId` to avoid listing every series:

```json
{
  "preset": "variety",
  "showCollectionId": "00000000-0000-4000-8000-000000000001",
  "wildcard": {
    "type": "smart-collection",
    "smartCollectionId": "00000000-0000-4000-8000-000000000002"
  }
}
```

Supply exactly one of `showIds` and `showCollectionId`. With a main collection, Tunarr shuffles the eligible shows, plays two sequential episodes from one show, then two wildcard programs. Every eligible show gets one turn before the shows are reshuffled. A series with more episodes does not get extra turns. Each show keeps its own episode position for that generated lineup; it wraps to its first eligible episode after reaching the end. The same show can appear at the end of one shuffle cycle and the beginning of the next.

Collections matching shows include their episodes; matching seasons or individual episodes limits the pool to those matches. Selection does not pull in other episodes merely because they belong to the same show. Non-episodes and shows with fewer than two playable matching episodes are excluded. If no show qualifies, generation fails with an explanation. Missing collections or invalid/empty saved searches also fail instead of silently selecting the entire library.

The returned schedule retains the collection ID in a normal Smart Collection slot with `programGrouping: "show"`. Preview or regeneration resolves its current membership; a library change does not rewrite an already-generated lineup by itself. For direct slot configuration, this mode requires a program-count duration and `order: "next", direction: "asc"`. Changing the count changes the group size and minimum eligible episode count.

Episode positions are held during generation, not across separate regenerations; continue/restart behavior is tracked in #119. Main-show and wildcard pools remain independent, so overlapping pools can still produce nearby repeats (#120). This is API-only; no editor controls are added.

### Preview and save

Review `schedule.json` and adjust the ordinary slot counts, order or padding as needed. To generate a preview for an existing channel without saving it:

```bash
CHANNEL=paste-the-channel-id-here
jq '{schedule: .}' schedule.json > preview-request.json
curl -fsS "$TUNARR/api/channels/$CHANNEL/schedule-slots" \
  -H 'Content-Type: application/json' \
  --data-binary @preview-request.json > preview.json
```

The preset endpoint builds a recipe from the supplied IDs; it does not look up content. The existing preview/generation path resolves those sources and checks scheduling constraints. Saving remains a separate call to the existing `POST /api/channels/:id/programming` API. A preset starts a new rotation; it does not resume an old schedule's episode position.

These names describe programming styles. Primetime does not automatically start at 8 PM, and Saturday Morning does not restrict playback to Saturdays. Movies and episodes play in full, so a longer wildcard movie makes the rotation longer. Picture and CRT settings remain separate. UI controls are deferred until upstream's redesign lands.

## After-show ad pods

An **ad pod** is a commercial break that plays after each show: for example a bumper, two commercials, then a station ID, each picked from a filler list you choose. Every break comes out a little different, like real TV.

Pods work with [Random Slots](https://tunarr.com/configure/scheduling/random-slots/) schedules. There's no button for them yet, so you add them to a slot or preset request through the API. Here's the shape:

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

A pool can fill itself from a saved search instead of a hand-picked list. See [Filler lists from a Smart Collection](#filler-lists-from-a-smart-collection).

The pod follows each complete program, and its full duration is included before the next program starts. It replaces that slot's legacy single post-program filler; head, pre and tail filler remain independent. Empty or missing selected pools fail generation instead of producing a partial break. Fixed-duration and time-slot schedules reject pods. Schedules without `postProgramPod` keep their existing behavior.

Commercial, promo and closer are example assignments, not required roles. A supplied recipe must contain at least one position; an empty array is rejected. Omitting `postProgramPod` retains the legacy post-filler configuration. Clips are selected when the schedule is generated or regenerated and saved in the lineup, rather than selected again during each airing.

## Skip the end credits

Turn this on and the channel moves on to whatever's next when a movie or episode reaches its **final credits**, the way TV cuts away. Shows without a credits marker just play to the end, and your files are never changed.

```bash
TUNARR=http://localhost:8000
CHANNEL=paste-the-id-here
curl -s $TUNARR/api/channels/$CHANNEL \
  | jq '.advanceAtFinalCredits = true' \
  | curl -s -X PUT $TUNARR/api/channels/$CHANNEL \
      -H 'Content-Type: application/json' -d @-
```

(See [CRT looks](crt.md#turning-it-on) for how to find a channel's ID.) Use `false` to turn it back off.

**Good to know:** the credits markers come from Plex, and Tunarr keeps them up to date on its regular library scans. Nothing to run by hand.

- **Just added something?** Plex finds the credits a little while after you add a movie or episode, so the marker may show up a scan or two later. Until then, that item plays to the end.
- **First scan after updating** re-checks every Plex movie and episode once. On a big library that can take a few hours, so let your nightly scan handle it (see [daily scan time](../../README.md#daily-library-scan-time)). Scans after that are back to normal speed.
- **After Plex refreshes its metadata,** you may see a burst of updates while Tunarr catches up. That's expected.
- No credits marker? The item just plays to the end.

## Filler Lists From a Smart Collection

A filler list can be linked to a [Smart Collection](https://tunarr.com/configure/library/smart-collections/), so its programs come from a saved search instead of being picked by hand. Local libraries of other videos tag each file with its folder path and with any `<tag>` in its `.nfo` file, so a folder of commercials can become a filler list:

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

## Offset channels

An offset channel plays another channel's lineup **a few hours later**, like an East Coast/West Coast feed: miss the 8 pm movie, catch it at 11 on the "+3" channel. It isn't a second channel to program. It follows its source: reprogram, refresh or re-time the source and the offset channel shows the same thing that many hours later, with nothing to copy by hand.

Make a channel the way you normally would (just its name, number and artwork matter), then point it at its source:

```bash
TUNARR=http://localhost:8000
CHANNEL=paste-the-offset-channels-id
SOURCE=paste-the-source-channels-id
curl -s -X PUT $TUNARR/api/channels/$CHANNEL/offset \
  -H 'Content-Type: application/json' \
  -d "{\"sourceChannelId\": \"$SOURCE\", \"hours\": 3}"
```

(See [CRT looks](crt.md#turning-it-on) for how to find a channel's ID.) To stop following, `curl -s -X DELETE $TUNARR/api/channels/$CHANNEL/offset`; the channel keeps the programming it has at that moment and becomes an ordinary channel again.

What to expect:

- **The offset is whole hours**, from 0 to 168 (a week). Zero plays the same schedule at the same time.
- **The mirror keeps its name, number, artwork and picture choice.** Programming, clock and other settings (flex, guide, streaming, audio and subtitles) follow the source. Saving the mirror's ordinary channel settings puts inherited settings back to the source's; change its picture choice through the offset endpoint below. Programming changes to an offset channel are refused; make them on the source.
- **Linking replaces** the offset channel's own programming with the source's.
- **The guide shows the shifted times** on its own.
- An offset channel can't follow another offset channel, and a channel others follow can't follow another channel. On-demand channels only move while someone watches, so they have no schedule to follow: they can't be followed, and a followed channel can't be switched to on-demand.
- Deleting the source leaves the offset channel with its last copy, as an ordinary channel.
- **Daylight saving:** the offset is a fixed number of hours. Between two places that change their clocks on different dates (for example US and European cities), the shows land an hour off for a few weeks a year.

Behind the scenes, an offset channel is stored as a normal channel that Tunarr rewrites from its source every time the source changes, so playback and the guide treat it like any other channel.

### A different picture on the same lineup

Use a zero-hour mirror to offer a plain and a CRT version of one channel, or two different CRT looks, without maintaining two schedules. Shifted mirrors can choose their own picture too. This is available through the offset API; there is no new UI control yet.

Include `picture` in the same `PUT /api/channels/{id}/offset` request:

| Choice | `picture` value | Result |
| --- | --- | --- |
| Follow source (default) | `{"mode":"source"}` | Follows the source's current CRT settings and later changes. |
| CRT off | `{"mode":"off"}` | Keeps CRT off even when the source turns it on. |
| Own look | `{"mode":"custom","crt":{"enabled":true,"look":"tv-broadcast","processing":"quality"}}` | Uses this complete CRT configuration, including the normal defaults for omitted CRT options. |

For example, to make a simultaneous mirror with CRT off, using the variables above:

```bash
curl -s -X PUT "$TUNARR/api/channels/$CHANNEL/offset" \
  -H 'Content-Type: application/json' \
  -d "{\"sourceChannelId\":\"$SOURCE\",\"hours\":0,\"picture\":{\"mode\":\"off\"}}"
```

Omitting `picture` when first linking a channel follows the source. Omitting it when changing an existing mirror's offset preserves its choice. Send `{"mode":"source"}` explicitly to resume following the source's look. A regular channel `PUT` that changes a mirror's `crt` is rejected with HTTP 400 and points to the offset endpoint. Omitting `crt` or echoing its unchanged value is accepted. Custom settings replace the whole CRT object; they do not merge individual options with the source. The available options are documented under [CRT looks](crt.md).

`GET /api/channels/{id}` returns the choice under `offset.picture` and the effective settings under `crt`. Source refreshes and lineup changes preserve the choice. Unlinking or deleting the source leaves the mirror with its last effective picture and lineup as an ordinary channel.

The mirror still uses the source's stream mode and transcoding profile. Enabling its own CRT look requires the same VAAPI encoding and hardware-filter support as any CRT channel. A channel update that would make a mirror's CRT look incompatible is rejected; turn that mirror's CRT off or change its picture choice first. Existing streams keep their current pipeline until a new one is started.

Watching both channels uses separate stream sessions and can require two transcodes. Sharing a lineup reduces programming work, not the processing cost of simultaneous viewers.

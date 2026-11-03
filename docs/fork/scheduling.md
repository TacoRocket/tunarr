# Scheduling

The fork adds a few things that make a channel feel like real TV: commercial breaks between shows, skipping the end credits, and commercials that keep themselves up to date.

## Generate from seeds

Build a finite channel from one or more shows, episodes, or movies. For example,
start with The Mandalorian and Cowboy Bebop, then explore related titles across
shows and movies. Matching uses the library's genres, tags, cast, directors,
and studios. Release year does not affect selection. This default does not
require an embedding model.

1. Create a channel, or open an existing channel's Programming page.
2. Choose **Auto-generation** (also available under **Add → Generate from seeds…**)
   and select up to ten seeds. Leave **Programming mode** at **One-time lineup**
   for a fixed loop.
3. Set a length from 1 to 168 hours and adjust **Familiarity**. Higher familiarity
   gives titles played on this channel a greater chance; other channels do not
   affect it. Zero ignores play counts.
4. Generate a preview. Each choice shows its metadata matches and this channel's
   recorded plays. Regenerate for another draw, or repeat the displayed draw.
5. Choose **Use this lineup**, then **Save**. This replaces the channel's
   programming. Undo remains available before saving.

Seeds play first in the order selected. The generator then balances matches to
the seeds with matches to the previous selection. It draws among related titles,
randomly picks an eligible episode across a show's seasons, and tries another
title before repeating the previous show. Filler-list members are excluded.
It avoids the last twenty program IDs from this channel's history and the new
lineup; when related content runs out, it allows repeats and reports that in the
preview. Whole programs can take the result past the requested length. Generation
stops at 2,000 items and reports when that falls short.

Regenerating the same channel keeps its history. Deleting the channel starts a
fresh experiment. Counts reflect existing playback-start records, not measured
watch time or individual viewers. Generating, previewing and saving do not count
as plays. A specific seed episode starts at that episode; a seed show starts at
a random eligible episode. Later selections also draw randomly, excluding recent
episodes while alternatives remain. There is no season-by-season progression.

With **One-time lineup**, this is a finite lineup and normal channel looping
applies. Regenerate to apply new viewing history. The draw can be repeated while
the library, history, settings and generator version remain unchanged; the time
recorded with each selection will differ. The browser remembers the last inputs.
Sparse or inaccurate metadata can produce broad matches; the explanations help
show why a title was included.

### Let the channel grow as you watch

Choose **Grow when watched** under **Programming mode** and set **Keep about this
many hours ahead**. You can generate an initial six-hour lineup and give it a
twelve-hour target, for example. **Use this lineup** applies both the preview and growth
settings; **Apply growth settings** keeps the current programming. Save on the
Programming page to activate either change. Choose **One-time lineup**, apply
its settings and save to return to a fixed loop. Undo restores both programming
and settings before saving.

Each new recorded main-program play can add one related program at the end.
The choice considers the original seeds, the preceding scheduled title, and
what you just watched, with equal weight for those three metadata matches.
This channel's play counts still give familiar titles a greater chance. Episodes
are chosen randomly across seasons. Programs already in the current/upcoming
tail are excluded from the new draw.

The target decides when to add, not which titles fit. If there are fewer than
twelve hours ahead, a four-hour movie can take the lineup past twelve. At or
above the target, plays still inform later choices, but no item is added. The
currently playing program keeps its playback position and the upcoming tail
stays in order; already-aired entries before the current item are retired when
a new item is appended. With nobody watching, nothing is added or retired and
the saved lineup repeats.

Open an item's information dialog in Programming to see **Why this was added**.
It records the triggering show/episode, addition time, and actual matches to
the watched title, seed, or preceding title. **Added after you watched** identifies
the trigger; the match details explain why that particular choice was eligible.
The explanation belongs to that airing, so another appearance of the same film
can have a different reason. Older/manual items may have no explanation.

Growth uses playback-start records, not measured attention or completed watches.
Guide browsing and filler plays do not trigger it. It runs in the background;
if selection fails, the saved lineup keeps playing and the task failure is
logged. A pending addition can be lost on restart; the next new recorded play
can trigger another. Growth settings and already-saved reasons survive restarts.
This mode requires a normal looping channel without offset followers, not an
on-demand, offset, relay or active slot-scheduled channel. A growing channel
retires aired entries that a delayed follower could still need. Saving a
time/random schedule disables growth.

### Keep a rolling guide

A rolling guide keeps fresh programming ahead without waiting for someone to
watch the channel.

Open **Auto-generation** on the Programming page and choose **Rolling guide**.
This mode uses Balanced matching and requires Potion to be enabled. The same
channel restrictions as watch-driven growth apply. Existing growing channels
stay in **Grow when watched** until you choose this mode and save.

The four rolling controls stay together in the dialog:

- **Minimum ahead (hours)** defaults to 6. Periodic updates fill the guide to
  this minimum even when nobody watches.
- **Extension limit (hours)** defaults to 12. Once the minimum is covered,
  a high movie share can extend the guide toward this limit. Whole episodes and
  movies can take the result beyond it.
- **Movie share extension trigger (%)** defaults to 30. This is a soft trigger
  based on movie airtime, not a hard quota. It does not force the next pick to
  be a movie. Extension prefers related episodes and can still finish above
  this share at the limit. Set it to 100 to disable movie-driven extension;
  at 0, any movie airtime triggers extension toward the limit.
- **Candidate shortlist size** defaults to 50 related shows and movies. The
  shortlist is rebuilt for each refill using the channel's seeds and recorded
  viewing. Watching steers future candidates; it is not required to keep the
  guide moving.

Choose **Generate preview** to inspect a new lineup. **Use this lineup** applies
both that preview and its settings. To keep the current programming and change
only automatic generation, choose **Apply growth settings**. Then **Save** on the
Programming page. The persistent **Auto-generation** button shows the editor's
selected mode and reopens these settings; unsaved changes still need **Save**.

The background task checks every five minutes and recorded plays can also
trigger a refill. It keeps the playing item and future lineup in order, retires
aired programs, and appends new selections. The guide ends at the saved tail
instead of promising a repeated copy of the lineup. If selection fails, the
saved lineup remains available and the task failure is logged.

### Semantic matching

Semantic matching uses titles, genres, tags and descriptions to find related
shows and movies, including ones without exact metadata matches. The container
bundles the English Potion 8M model (about 31 MB); it runs locally in Tunarr.

1. Set `TUNARR_POTION_ENABLED=true` and restart Tunarr. The first startup builds
   vectors for indexed shows and movies before serving requests. Other program
   types do not receive vectors.
2. Choose **Semantic** under **Matching** in the seed dialog, or send
   `recommendationMode: "semantic"` with the normal generation API request.
3. For watch-driven growth, save the same `recommendationMode` in the channel's
   `seedGrowth` configuration. Omitting it uses metadata matching. The browser
   dialog applies the selected mode to previews and saved growth settings.

This first version draws from each context title's closest 50 matches, counting
itself first, and weights them by `1 / rank`. It combines the seed, preceding
item and watched-item contributions using the existing generator rules.
Episodes are still drawn randomly from the selected show. Explanations report
semantic neighbor ranks; a rank is not a probability or a claim that Tunarr
understands a particular theme. Choose **Balanced** for evolving interests and adjustable discovery.

Meilisearch stores the vectors on its existing catalog entries. Moving a file or
marking it missing keeps its vector; missing entries cannot be selected.
Restoring an entry reuses its vector. Changing the descriptive text recomputes
it, and permanently removing an entry removes its vector. Model and text-recipe
updates rebuild affected vectors. No media file is read to create an embedding.

Potion loads when Meilisearch needs to create an embedding, then releases its
weights and tokenizer after five idle minutes. The next indexing burst reloads
the packaged assets. Choosing recommendations uses stored vectors and does not
load Potion. The loopback listener remains available throughout; memory returned
to the operating system depends on runtime garbage collection.

Removing the environment setting disables inference and removes the Potion
vectors on the next startup. Existing lineups keep playing; switch saved semantic
growth configurations to metadata before disabling it if they should keep
appending. Re-enabling builds vectors again. Encoding/index errors remain visible
rather than silently changing the requested matching method.

For source development, run `pnpm --filter @tunarr/server install-potion` before
enabling the setting. Packaged containers already include the pinned assets and
do not contact Hugging Face at runtime.

### Balanced discovery

Choose **Balanced** under **Matching** to start from your seeds and gradually
follow what plays on this channel. It uses the same local Potion model as
Semantic matching. Your existing channels keep their matching mode until you
change it.

Balanced starts with 85.5% of selection weight from current interests, 7.6% from
broader metadata connections, 1.9% from connected exploration, and 5% from
look-back. Detours need a connection to an original seed or a title that played
on this channel. Those are chances on each draw, not a forced return cadence.

Expand **Tune recommendations** to adjust:

- **Discovery:** how much of the current-interest share goes to broader
  connections. Its exploration share splits 80% to metadata and 20% to connected
  exploration. At 25, the overall mix is 71.25/19/4.75/5. At zero, current
  interests get 95% and look-back keeps 5%.
- **Variety:** how concentrated the related choices are. Lower values favor the
  strongest matches; higher values spread weight across more candidates. The
  default is 1, with an adjustable range of 0.7–1.4.
- **Familiarity:** the existing preference boost for titles already played on
  this channel. Current interests still change from recorded plays at zero.

**Reset Balanced** restores Discovery 10, Variety 1 and Familiarity 50. Normal
preview, Apply growth settings, Save and Undo behavior applies. Controls affect
future choices; saved programming and its explanations keep their original
meaning.

Each recorded main-program start moves the interest profile one quarter toward
that title and its relationships. Several Star Trek starts can gradually steer
a space-western channel toward related science fiction. One unrelated start
has a smaller effect than several repeated starts. Seeds play first when
creating a lineup, but their original influence fades as starts accumulate.
Only seeds and recorded viewing steer these relationships. A scheduled title
adds no preference weight merely by appearing in the lineup. Recorded viewing
of a non-seed title caps its self-match at its strongest other catalog match,
so related alternatives can compete. Explicit seeds retain their self-match,
and Familiarity still applies separately. This also caps self-matches from
older watched titles in look-back.

Connections can come from genres, tags (including real holiday tags), cast,
directors, studios, exact content ratings, or Potion similarity. A lone genre,
rating or studio match has reduced weight. Two ties to the same anchor strengthen
the metadata match; a genre is not required. These are soft preferences, not
rating restrictions or a guarantee of mood. A semantic neighbor and a shared
genre can reflect overlapping evidence.

Current interests use this channel's latest 50 available, non-filler starts,
including plays recorded while the lineup was above its ahead target. The window
counts starts, not days or distinct shows. Lifetime Familiarity counts stay intact.
Older starts no longer steer current interests directly. Instead, each draw's
5% look-back uses the original seeds plus up to three distinct older titles,
sampled with preference for those played more often. Potion finds related
candidates for these anchors. The current window stays bounded as the channel ages;
lifetime counts and request-local look-back retrieval still depend on history.
This is a recent-interest window, not a promise that
every pick matches a reconstruction from the full history. Repeated
starts count individually. Plays still marked as filler and other channels do not
contribute. Deleting a filler list currently removes that marker from its old
history, so those old plays can influence recommendations if their titles remain
available. Balanced cannot recover that erased distinction.

Deleting the channel starts fresh; regenerating it retains its history. Existing
history whose show/movie is unavailable is omitted with a preview warning.
Deleting a program also deletes its history, which then stops contributing without
a warning. History or catalog changes can therefore change the reconstructed
interests. There is no separate profile to migrate or reset.

Missing titles, filler-only titles and queued/recent program exclusions apply
before mixing the eligible pools. Connected exploration weights shows and movies
by their seed/watched connections and Familiarity, regardless of episode count.
An empty pool's
share is redistributed among the other enabled pools and reported in the
preview; if none can select an item, generation fails visibly. Existing repeat
relaxation still applies when recent items exhaust the available pool.

**Why this was added** records the selected item's interest, metadata, connected
exploration and look-back contributions, plus supporting ties and the actual
matching titles. Look-back identifies its original seed or older watched anchor.
These weights explain the draw; they are
not confidence scores or measured audience preferences.

For API clients, use `recommendationMode: "balanced"` and optionally
`discovery: { "exploration": 10, "temperature": 1 }` in both generation requests
and saved `seedGrowth` settings. Omitting `discovery` uses the Balanced defaults.
This preset uses recorded starts, not watch duration, skips or dislikes.
It does not reserve airtime for variety. **Rolling guide** adds the periodic
refill and candidate shortlist described above; **One-time lineup** and
**Grow when watched** retain their existing looping and playback-driven behavior.

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

Replace these example IDs with Tunarr show, Custom Show and filler-list IDs. Variety plays a pair from one series, then two wildcards. Its wildcard pool can be a Custom Show or a Smart Collection (`{"type":"smart-collection","smartCollectionId":"..."}`) containing episodes, movies or specials. Only Variety accepts a `wildcard`; other presets reject that field. Each wildcard turn continues the same shuffle rather than restarting it. Selected shows keep their own episode progression, separate from the wildcard pool.

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

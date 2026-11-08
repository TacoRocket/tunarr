# Extension style guide

These guidelines describe what we look for in a Tunarr extension. They are modeled on Home Assistant's integration quality scale: each rule says what is expected, why it matters, and what it looks like in practice. The [package interface](../../server/resources/extensions/README.md) describes what Tunarr accepts; these rules describe what makes an extension easy to set up, easy to trust and easy to support.

These are recommendations for extension API 0.5, an early beta, and they will grow with the API. Our [Bazarr extension](https://github.com/TacoRocket/tunarr-bazarr-extension) is the worked example. The people reading an extension's text are Tunarr operators in Settings. They know their other services by those services' own names, and they are not reading JSON.

## Setup

### `setup-in-settings`

The extension is set up entirely from **Settings → Extensions**. Every value it needs is a declared setting.

**Why it matters:** Operators expect to add an extension the way they add a media source. Asking them to edit files or set environment variables makes setup error-prone and support harder.

**Example:** Bazarr declares two settings, `Bazarr URL` and `API key`, and nothing else.

**Exceptions:** None.

### `test-before-save`

The extension declares a connection test. The test makes one small real request with the entered settings, including the credential if the service needs one, and reports success only when that request succeeds.

**Why it matters:** Most setup problems are a wrong address or key. Finding that out before saving is better than finding it out later from a failed action.

**Example:** Bazarr's test reads one page of one movie from Bazarr's API.

**Exceptions:** Extensions with no settings.

### `settings-explained`

Each setting is labelled with the name the other service uses, has a placeholder that shows its shape, and has a help line that says where to find the value.

**Why it matters:** Operators copy these values out of another app. Matching that app's words and telling them where to look saves a trip to the documentation.

**Example:**

| Label | Placeholder | Help |
|---|---|---|
| Bazarr URL | `http://bazarr:6767` | Include the port and any URL base configured in Bazarr. |
| API key | | In Bazarr, open Settings → General → Security. |

**Exceptions:** None.

## Actions

### `plain-results`

Each action answers with one sentence in `message` that answers the question its button asks. Extra facts go in `details`, labelled with `resultLabels`. The optional `tone` (`success`, `info`, `warning`, `error`) sets the color Settings uses. Use `warning` only for something the operator should act on; a result that is normal for the service, like Bazarr not having a subtitle yet, is `info`.

**Why it matters:** The result is read by a person. An internal code such as `unmatched` tells them nothing; a sentence tells them what Bazarr knows.

**Example:**

| Instead of | The extension returns |
|---|---|
| `status: "unmatched"` | `Bazarr doesn't have Alien in its library.` |
| `status: "matched"`, `missingLanguages: ["en"]` | `Bazarr hasn't found English subtitles for A Boy and His Dog yet.` (tone `info`) |
| `ok: true` after a search | `Bazarr found English subtitles for A Boy and His Dog.` (tone `success`) |

**Exceptions:** None.

### `actionable-errors`

When an action can't complete, the extension throws an error whose message says what happened and what the operator can do about it.

**Why it matters:** A clear error turns a support question into something the operator fixes themselves.

**Example:** `Bazarr refused the API key. Copy it again from Bazarr → Settings → General → Security.` rather than `HTTP 401`. For a program Bazarr can't check: `Choose a movie. This extension checks movies only.`

**Exceptions:** Unexpected internal failures, which Tunarr reports for the extension.

### `appropriate-requests`

The extension makes no more requests than the service's own app would make for the same answer. When it waits for the service, it checks back a few times at most, a few seconds apart.

**Why it matters:** The services an extension talks to belong to the operator, or to someone else entirely. They should not see more load because Tunarr asked.

**Example:** Bazarr's lookup reads the movie list in pages of 200 and stops with a clear message above 10,000 movies. After asking Bazarr to search, it re-checks only that one movie, every 5 seconds, up to 4 times.

**Exceptions:** None.

### `javascript-and-compute`

Write the extension in JavaScript. Keep settings, service calls, storage and decisions about what to do there. Use an optional compiled module for a calculation that takes data in and returns data.

**Why it matters:** An author can read the adapter to see when it contacts a service or changes saved data. Expensive math can still run at compiled speed.

**Example:** Potion calls `embed` to turn descriptions into vectors and `score` to compare them. Its JavaScript chooses which titles to index and saves the results. Bazarr handles its service calls entirely in JavaScript.

**Exceptions:** None.

### `light-footprint`

The extension stays light on memory and disk. We recommend staying under about 30 MB for each.

**Why it matters:** People run several extensions on the same machine as Tunarr, often a small one. They appreciate extensions that leave room for the rest, and they can then try many of them.

**Example:** Bazarr uses the default 16 MiB and almost no disk. Potion declares 192 MiB of memory and 128 MiB of storage for its index. Operators can see both allowances before installing.

**Exceptions:** Extensions that need more, such as a model, declare it in `memoryMiB` and `storageMiB` and explain it in their access guide.

### `simple-storage`

Keep the extension's own data in `storage`: small values as keys, larger data as files.

**Why it matters:** Simple data is easy to inspect, back up and remove on uninstall. If an extension truly needs a database, tell us in the extensions issue tracker, so the API can grow for it instead of each extension working around it.

**Example:** Potion keeps its vectors in files of 1,024 rows and the list of indexed titles as one key.

**Exceptions:** None.

## Trust

### `access-guide`

The manifest includes an `accessGuide`: one plain sentence each for what the extension reads, changes, connects to and downloads.

**Why it matters:** It is the first thing an operator reads before installing. Tunarr shows it next to a line generated from the manifest, so an accurate guide reads as trustworthy and a careless one stands out.

**Example (Bazarr):** Reads: "Uses your selected movie's ID to check subtitle availability in Bazarr." Changes: "Starts a subtitle search when you ask." Connects to: "Contacts your Bazarr server, which may contact your subtitle providers." Downloads: "Bazarr downloads any subtitles it finds."

**Exceptions:** None.

### `declare-what-you-use`

The manifest declares only the service requests the extension actually makes.

**Why it matters:** Settings shows this list before installation. A short, accurate list is how an operator decides whether to trust an extension.

**Example:** Bazarr declares two requests: one that reads its movie list (or a single movie), and one that asks Bazarr to search for a movie's missing subtitles.

**Exceptions:** None.

### `no-secrets-in-output`

Credentials and service addresses never appear in results, error messages or logs.

**Why it matters:** Operators paste results and errors into public bug reports.

**Example:** Bazarr's errors name the problem ("refused the API key") without repeating the key or the address.

**Exceptions:** None.

## Maintenance

### `owner-and-issue-tracker`

The manifest names who maintains the extension and where to report problems.

**Why it matters:** Tunarr's maintainers can't support every extension. Settings shows **Report a problem** with the publisher's link, so bug reports reach the people who can fix them.

**Example:** Bazarr lists its GitHub repository's issue tracker and its maintainer.

**Exceptions:** None.

### `stable-versions`

Releases use semantic versions, declare the extension API they were built for, and keep setting keys stable between versions.

**Why it matters:** Tunarr asks the operator to set an extension up again when a setting's key or type changes. Stable keys mean updates install without a second setup.

**Example:** A Bazarr update that adds a `Language profile` setting adds a new key and leaves `bazarrUrl` and `apiKey` alone. Declaring API 0.5 keeps it running on later 0.x Tunarr releases; declare a later minor only when you use what it adds.

**Exceptions:** A new major version may rename settings, and should say so in its release notes.

## Documentation

### `docs-page`

The extension's README follows the extension page template below, so every extension reads the same way.

**Why it matters:** Operators decide whether an extension fits before installing it, and come back to the same page when something goes wrong. A consistent layout makes both quick.

**Exceptions:** None.

## Extension page template

The sections below, shown with Bazarr's content, make up an extension's README.

```markdown
# Bazarr

The Bazarr extension checks which subtitle languages Bazarr has for a movie in your Tunarr library, and which ones Bazarr's language profile still needs.

## Prerequisites

- Bazarr, connected to Radarr.
- Bazarr's API key, from Bazarr → Settings → General → Security.
- An address Tunarr can reach: the same machine, a shared Docker network, or your LAN.

## Configuration

| Setting | Description |
|---|---|
| Bazarr URL | The address Tunarr uses to reach Bazarr, including the port and any URL base. For example, `http://bazarr:6767`. |
| API key | Bazarr's API key. |

## Actions

### Check subtitles

Choose a movie. The result says whether Bazarr has it, which subtitle languages it found and which ones its profile still needs.

### Search for missing subtitles

Choose a movie. Bazarr searches its subtitle providers for the languages its profile still needs, and the extension checks back for about 20 seconds. If Bazarr is still searching, check again in a minute. Bazarr saves what it finds next to the movie, where your media server picks it up.

## Data updates

The extension contacts Bazarr only when you run an action. A search checks back with Bazarr up to 4 times.

## Known limitations

- Movies only.
- Matching uses the movie's IMDb ID. A movie without exactly one IMDb ID can't be checked.
- Libraries larger than 10,000 movies can't be searched.
- Tunarr doesn't ask Bazarr on its own during playback yet; run the action from Settings.

## Troubleshooting

- **Bazarr refused the API key:** copy the key again from Bazarr → Settings → General → Security, then select **Test**.
- **Tunarr can't reach Bazarr:** use an address that works from where Tunarr runs. In Docker, put both containers on one network and use Bazarr's container name.

## Removing the extension

In Settings → Extensions, choose the Bazarr card, then **Uninstall**. This removes the extension, its settings and its saved API key from Tunarr. Nothing changes in Bazarr.
```

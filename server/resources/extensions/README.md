# Tunarr extension API 0.5

This page describes what Tunarr accepts from an extension package. It is an early beta: we expect to add to it, and we would like to hear what you need. The [extension style guide](../../../docs/fork/extension-style-guide.md) describes what makes an extension pleasant to use, and our [Bazarr extension](https://github.com/TacoRocket/tunarr-bazarr-extension) is a complete example.

## Versions

A package declares the extension API it was built for as `major.minor`, for example `"0.5"`.

- **Minor versions only add.** A package built for 0.5 keeps working on a Tunarr that runs 0.6 or 0.7. It just doesn't use what they add.
- **A package that needs a newer minor** than the Tunarr it is installed on is refused, with a message asking the operator to update Tunarr.
- **A new major version** (1.0, 2.0) is where changes that break packages happen. Tunarr refuses packages built for another major and asks the operator to update the extension. An installed extension built for another major stays listed in Settings, where it can be updated or uninstalled.

## Publishing

A **source** is a public GitHub repository that lists extensions. On its default branch it serves `source-v0.json`, one file per major version of the API:

```json
{
  "schemaVersion": 1,
  "extensions": [
    {
      "id": "bazarr",
      "name": "Bazarr",
      "description": "Check and find subtitles for movies in your Bazarr library.",
      "repository": "TacoRocket/tunarr-bazarr-extension",
      "version": "1.1.0",
      "commit": "<full commit hash>"
    }
  ]
}
```

A **package** is a public GitHub repository. At the listed commit it holds `tunarr-extension.json` (the manifest) and `adapter.js` (the code). On its default branch it serves `feed-v0.json`, which Tunarr reads when the operator checks for an update:

```json
{ "id": "bazarr", "latest": { "version": "1.1.0", "commit": "<full commit hash>" } }
```

One repository can hold several packages. Give each listing a `path` to its folder, such as `"path": "packages/potion"`; the manifest, code, data files and `feed-v0.json` then live in that folder. Operators can hide listings they don't want to see.

Tunarr downloads the manifest and code at the exact commit and checks the code against the manifest's `sha256`. That proves the download matches the manifest; whether to trust the publisher is the operator's decision.

## Manifest

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase identifier, unique within a source. |
| `name` | yes | The name operators see, usually the service's name. |
| `version` | yes | The package version, `major.minor.patch`. |
| `apiVersion` | yes | The extension API it was built for, e.g. `"0.5"`. |
| `entrypoint` | yes | Always `"adapter.js"`. |
| `sha256` | yes | Lowercase hex SHA-256 of `adapter.js`. |
| `maintainer` | yes | Who maintains the package (a name or GitHub handle). |
| `issueTracker` | yes | HTTPS URL where operators report problems. Settings links to it. |
| `description` | no | One or two sentences shown in Settings. |
| `settings` | no | Fields the operator fills in. Each has `key`, `type` (`url`, `secret` or `text`), `label`, and optional `help`, `placeholder`, `required`. |
| `setupHelp` | no | One or two sentences shown above the settings. |
| `credentialHelp` | no | Where to find the credential, shown under the settings. |
| `connectionTest` | no | `true` when the package's `test` action checks the settings. |
| `actions` | yes | Buttons the operator can run. Each has `id`, `label`, `inputs` and optional `resultLabels`. |
| `requests` | no | The service requests the code may make. See below. |
| `accessGuide` | no | Four plain sentences, `reads`, `changes`, `connectsTo` and `downloads`, shown before install as "Access at a glance". Recommended. |
| `memoryMiB` | no | Memory the code may use, 16 (default) to 256. Shown before install. |
| `storageMiB` | no | Disk for the extension's own data, 0 to 1024 (default 1). Shown before install. |
| `files` | no | Data files next to `adapter.js`: each `name`, `bytes` and `sha256`. Downloaded and checked on install and update. |
| `provides` | no | Services Tunarr may call on its own. `"similarity"` is the only one today; see below. |

Action inputs have a `key`, `label`, `type` (`text` or `tunarrProgram`) and optional `help`, `placeholder` and `required`. A `tunarrProgram` input lets the operator search their library; the code receives the program as `{type, identifiers: [{type, id}]}`. Treat identifiers as opaque strings.

## Code

`adapter.js` defines a synchronous `function run(input)`. `input.action` names the action. The operator's `text` settings and the action's inputs are properties of `input`. Service addresses and secrets are never passed to the code.

Two functions are available:

- `request(id, { query, body })` makes a declared service request and returns the decoded JSON reply. A write request whose reply is empty, such as `204 No Content`, returns `null`.
- `wait(seconds)` pauses for up to 10 seconds without using CPU. It is for "ask the service to start something, then check again".
- `readFile(name)` returns one of the package's declared `files` as an `ArrayBuffer`; `readTextFile(name)` returns it as text.
- `storage` holds the extension's own data, within `storageMiB`: `get(key)`, `set(key, value)`, `delete(key)` and `keys()` for strings, and `readFile(name)`, `writeFile(name, data)` and `deleteFile(name)` for binary files. Changes are saved only if the action finishes without an error. Uninstalling removes them.

`run` returns the action's answer:

```js
return {
  message: "Bazarr found English subtitles for A Boy and His Dog.",
  tone: "success",
  details: { found: ["English"], stillMissing: [] },
};
```

`message` is required: one plain sentence that answers the question the button asked. `tone` is `success`, `info`, `warning` or `error`. `details` holds extra facts as strings, numbers, booleans, `null` or lists of strings, labelled with the action's `resultLabels`.

To report a problem, throw an `Error` with a message for the operator, such as `throw new Error("Choose a movie. This extension checks movies only.")`. Tunarr shows that message as it is. Any other exception is shown as an internal error that points the operator at your issue tracker.

The connection test is an action with the id `test`. It passes when it returns an answer and fails when it throws.

## Service requests

Each entry in `requests` declares one request the code may make:

```json
{
  "id": "searchMissing",
  "method": "PATCH",
  "baseUrlSetting": "bazarrUrl",
  "path": "api/movies",
  "query": ["radarrid", "action"],
  "credential": { "setting": "apiKey", "header": "X-API-KEY" }
}
```

- `method` is `GET` (the default), `POST`, `PUT` or `PATCH`.
- `path` is fixed and is added to the address in the `baseUrlSetting` setting, which must be a `url` setting.
- `query` lists the query keys the code may send. A key ending in `[]`, such as `radarrid[]`, may take a list of values.
- `body` lists the top-level keys of a JSON body the code may send. `GET` requests have no body.
- `credential` names a `secret` setting and the header Tunarr puts it in: `Authorization`, `X-API-Key` or `API-Key`.

Tunarr resolves the address and connects to the checked IP, keeping the original name for HTTPS. Redirects are refused. Services on the same machine are allowed, except on Tunarr's own ports. Link-local and cloud metadata addresses are refused. When a request fails, Tunarr ends the action with a plain message naming the service, for example "Bazarr refused the API key."

## Similarity

A package that lists `"similarity"` in `provides` answers two calls that Tunarr makes on its own, outside any button:

- `{"action": "similarity.index", "items": [{"id", "text"}], "removed": [ids]}`: add or update these titles and forget the removed ones. Answer `{"indexed": <number>}`. Tunarr sends new and changed shows and movies about once an hour, a few hundred at a time; the text is the title, genres, tags and summary.
- `{"action": "similarity.query", "id": "<id>", "k": <number>}`: answer `{"matches": [{"id", "score"}]}`, the closest titles first.

Tunarr uses the answers for Semantic and Balanced matching when it has no built-in Potion. The [Potion extension](https://github.com/TacoRocket/tunarr-extensions/tree/main/packages/potion) is the example.

## Limits

| Limit | Value |
|---|---|
| Time per action | 30 seconds |
| Memory for package code | 16 MiB, or the package's `memoryMiB` up to 256 |
| Service requests per action | 50 |
| Time per service request | 8 seconds |
| Size of one reply | 4 MiB |
| Size of the answer | 64 KiB |
| Longest `wait` | 10 seconds |
| Size of `adapter.js` | 128 KiB |
| Data files | 256 MiB each, 512 MiB in all |
| Own data | the package's `storageMiB`, up to 1024 MiB |

Within a major version, limits only grow.

## Sandbox

Every action runs in a fresh QuickJS WebAssembly sandbox on its own worker thread, which is discarded afterwards. Nothing carries over between runs or between extensions. Package code has no filesystem, network, environment or database access beyond its own declared files and storage; it reaches services only through its declared requests, and Tunarr attaches each extension's own credentials to its own requests.

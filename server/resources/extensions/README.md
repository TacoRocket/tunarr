# Tunarr extension API v2

This is a capability-based host for independently published JavaScript packages. A package supplies calculations and a manifest. The host owns all file access, credentials and HTTP reads. The generic implementation has no default publisher. A distribution can set the initial source URL in its image.

## Discovery and installation

A public GitHub source serves `source-v2.json` on its default branch with `schemaVersion: 1` and an `extensions` array. Each entry declares `id`, `name`, `description`, `repository` (owner/repo), `version` (three numeric components) and `commit` (full Git hash). The host reads the manifest and code at that commit. It verifies the code against the manifest’s SHA-256. A package’s own `feed-v2.json` has its `id` and a `latest` object with `version` and `commit`. The administrator selects updates. The source and feed are publisher trust decisions. A checksum detects a mismatch between code and manifest.

## Package contract

`tunarr-extension.json` declares `apiVersion: 2`, an ID, display name, version, `entrypoint: "adapter.js"`, lowercase hex `sha256` and at least one action. Settings may have type `url`, `secret` or `text`. Each field has a `key`, `type`, `label` and optional `required`, `help` and `placeholder`. Actions declare an `id`, a button `label` and an `inputs` array of text or `tunarrProgram` fields. Optional `resultLabels` maps output keys to display labels. A package can include `setupHelp`, `credentialHelp` and `connectionTest: true`. The reserved action `test` must then return `{"status":"connected"}` on success.

The entrypoint defines a synchronous `function run(input)` that returns a JSON object. `input.action` names the invoked action. Named text settings and declared action inputs are available as properties. A selected Tunarr program is projected to `{type, identifiers: [{type, id}]}`. Treat identifiers as opaque strings. The contract exposes a fresh copy per invocation. No general Tunarr HTTP method or database handle is exposed.

External reads are named capabilities. For example, a package can declare:

```json
{
  "id": "items",
  "baseUrlSetting": "serviceUrl",
  "path": "api/items",
  "credential": {"setting": "apiKey", "header": "X-API-Key"},
  "query": ["start", "length"]
}
```

Place the declaration in the manifest’s `reads` array. `readJson("items", {start: 0, length: 10})` returns the decoded response or fails the action. The trusted host issues a GET to the fixed relative path under the operator’s configured URL. Only declared scalar query parameters are accepted. The optional credential comes from a declared secret setting. Supported header names are `Authorization`, `X-API-Key` and `API-Key`. Service URLs, raw credentials, local paths and environment variables are unavailable to package code. Successful responses from the configured service are available to the package, so choose service endpoints and publishers you trust.

## Runtime and limits

Tunarr starts the trusted store host on first access and reaches it over a private Unix socket. Each action runs in a short-lived QuickJS process with a bounded heap, CPU time and wall time. A Linux seccomp allowlist restricts the process to its protocol pipes and computation. The broker resolves external addresses, checks all answers, connects to a checked IP, preserves the TLS hostname and refuses redirects. The peer service controls the meaning of its GET endpoints. A reverse proxy can forward a permitted address elsewhere.

The host supports 50 named reads per action, 4 MiB per service response and 64 KiB of JSON output. A package may update within API v2 while keeping this contract. Incompatible runtime changes require a different API version. The package manager rejects manifests it does not support.

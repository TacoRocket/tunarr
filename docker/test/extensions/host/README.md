# Tunarr extension host

The host reads a public source list and installs packages by publisher, extension ID, version and Git commit. Package manifests supply setup fields, optional connection testing and named actions. The Settings page renders these declarations. Each publisher handles its own service protocol and can distribute updates independently.

## Sources and packages

A source publishes `source.json` at the root of its default branch. Each entry includes the name, description, extension ID, publisher repository, version and full Git commit. The first visit loads the configured default source. Source lists are cached locally. Use **Manage sources → Refresh** to fetch a new list. Choose **Install** to fetch the selected release’s `tunarr-extension.json` and entrypoint. The host verifies its SHA-256 digest before switching the saved installation to that release.

**Check for update** reads `feed.json` from the installed package’s publisher. The administrator chooses whether to apply the offered release. Each installation has its own settings and enabled status. A source change cannot silently replace the publisher of an installed extension.

## Running an action

The host starts the installed Python entrypoint with a JSON object on standard input. The object contains the action ID, its declared inputs and that extension’s settings. A field with type `tunarrProgram` accepts a Tunarr program UUID. The host reads the program through Tunarr’s API and passes the object under the field’s key. The extension handles its meaning. A successful action returns a JSON object on standard output.

## Storage and access

Use the [trial Compose configuration](../compose.yaml). It gives the host only its own volume, a read-only root filesystem and a temporary working directory. Keep the administrator interface on loopback or behind an authenticated proxy. The manager uses Linux user and group switching so each installed package executes as a separate unprivileged identity. Package code receives its own configured values and can contact services on the container network. Install packages from publishers you trust.

`/extensions/state` reports installation metadata. Configuration forms leave stored secrets blank. Saved credentials stay on the host’s private volume. Protect backups of that volume. The store uses a fresh root-owned state directory when moving from the earlier single-extension proof of concept.

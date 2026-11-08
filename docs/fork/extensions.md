# Extension store

> **Early beta.** Extensions use extension API 0.5. Tunarr updates add to the API without breaking the extensions you have installed; a change that would break them waits for API 1.0. See the [roadmap](#roadmap) for what is planned, and tell us what you would use.

Open **Settings → Extensions**. Installed extensions appear as cards. Choose **Add extension** to browse the extensions your sources offer, starting with the [default source](https://github.com/TacoRocket/tunarr-extensions). Each extension’s publisher supplies its settings, actions and updates.

## Install and use

1. In **Add extension**, check the publisher and description, then choose **Install**. The extension’s setup opens.
2. Enter the address of your existing service and any credentials it needs. The address must be reachable from the machine or container running Tunarr. **Test** checks the settings without saving. **Save** turns the extension on; switch off **Enable** first to save it turned off. **Cancel** discards edits.
3. A saved credential stays hidden. Leave its field blank to keep it. If you change the service address, enter the credential again: Tunarr does not send a saved credential to a new address.
4. An enabled extension shows its actions as buttons on its card. An action that needs a program lets you search your library by title.
5. Choose a card to change its settings, check for an update, update or uninstall it. Uninstalling removes the extension, its settings and its saved credentials. Your channels and media are not changed.

**Manage sources** accepts public GitHub repositories with a compatible source list. GitHub caches published files, so a new listing or update can take up to about 10 minutes to appear. Enabling a source fetches its listings. Installing or updating code requires a separate choice. A new installation gets its initial source from `TUNARR_EXTENSION_SOURCE`. An empty value starts with no sources. Saved sources can be enabled or disabled in Settings.

Tunarr includes the extension runtime. Install the service an extension connects to separately. If an action reaches its 30-second limit, Settings shows **Extension timed out.** You can retry it. Channel playback runs independently.

## Before you install

Each listing shows **Access at a glance**: four sentences from the publisher about what the extension reads, changes, connects to and downloads, and a line from Tunarr saying what the extension is actually allowed to do, from its manifest: the services it can reach, the memory and disk it may use, and what it downloads. If the publisher wrote no guide, the listing says so. Use the eye button to hide a listing you don't want to see; **Show hidden** brings it back.

## Who can operate the store

With Tunarr Basic Auth configured, the store uses the same login. Without a login the default is browse-only. To allow management on an instance you keep on a trusted LAN, start Tunarr with the environment variable `TUNARR_EXTENSION_TRUSTED_LAN=true`. For Docker Compose, set it on the service and recreate the container:

```yaml
environment:
  TUNARR_EXTENSION_TRUSTED_LAN: "true"
```

Everyone who can reach that instance can then install packages, test addresses, change settings and run service reads. The flag preserves any Tunarr login you already have. For remote access, use Tunarr’s `TUNARR_BASIC_AUTH_USER` and `TUNARR_BASIC_AUTH_PASSWORD` with HTTPS or a private tunnel.

## What an extension can do

When you select a program, Tunarr gives the extension its media type and identifiers. An extension can calculate a result and ask Tunarr to make a declared request to a service you configured, such as reading Bazarr's movie list or asking Bazarr to search for subtitles. Tunarr attaches the credentials to the outgoing request; the extension's code never sees them.

Services on the same machine as Tunarr work, including over `localhost` and on a shared Docker network, except on Tunarr's own ports. Link-local and cloud metadata addresses are refused, and so are redirects. Use the service's direct address. Tunarr can't recognize itself behind a port mapping or a reverse proxy, so don't point an extension at one that leads back to Tunarr.

Store configuration and credentials live in the private `extension-store` subdirectory of your Tunarr data directory. Protect that volume and its backups. Extensions can't change channels, schedules or media, and package code gets no persistent files. [Package interface](../../server/resources/extensions/README.md)

## Roadmap

Extensions are new. This beta puts the idea in front of people early, so what comes next depends on what you would use them for.

**In 0.5**

- Install extensions from public GitHub sources, update them and uninstall them from Settings.
- Set an extension up with a connection test before saving.
- Run an extension's actions from its card, including actions that ask for a program from your library.
- Requests to services you configure, such as Bazarr.
- Storage for an extension's own data, and data files shipped with it, such as a model.
- Extensions that Tunarr calls on its own: a similarity extension powers Semantic and Balanced matching.
- "Access at a glance" on each listing: the publisher's summary, plus what Tunarr lets the extension do.
- Several extensions in one repository, and hiding listings you don't want to see.
- [Bazarr](https://github.com/TacoRocket/tunarr-bazarr-extension): check which subtitle languages Bazarr has for a movie, and ask Bazarr to search for the missing ones.
- [Potion](https://github.com/TacoRocket/tunarr-extensions/tree/main/packages/potion): semantic recommendations from a small model that runs inside Tunarr, with nothing extra to run.

**Being considered**

- Reading Tunarr data such as programs and channels.
- Scheduled runs.
- Tunarr asking Bazarr for subtitles on its own during playback, when the media server and PGS have none.
- Status and diagnostics on each extension's card.

**Versions.** Each Tunarr update may add to the extension API as a new minor version (0.6, 0.7), and extensions built for an earlier minor keep working. **1.0** will be the first stable API and the first place a change may break extensions; it may come as soon as the next release.

To suggest something or report a problem with the extension store, [open an issue](https://github.com/TacoRocket/tunarr-retuned/issues/new). Problems with a particular extension go to that extension's publisher.

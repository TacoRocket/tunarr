# Extension store

> **Early beta.** Extensions use extension API 0.5. Tunarr updates add to the API without breaking the extensions you have installed; a change that would break them waits for API 1.0. See the [roadmap](#roadmap) for what is planned, and tell us what you would use.

Open **Settings → Extensions**. Installed extensions appear as cards. Choose **Add extension** to browse the extensions your sources offer, starting with the [default source](https://github.com/TacoRocket/tunarr-extensions). Each extension’s publisher supplies its settings, actions and updates.

## Install and use

1. In **Add extension**, check the publisher and description, then choose **Install**. The extension’s details open on **Configuration**, where you set it up.
2. Enter the address of your existing service and any credentials it needs. The address must be reachable from the machine or container running Tunarr. **Test** checks the settings without saving. **Save** turns the extension on; switch off **Enable** first to save it turned off. **Cancel** discards edits.
3. A saved credential stays hidden. Leave its field blank to keep it. If you change the service address, enter the credential again: Tunarr does not send a saved credential to a new address.
4. A card can show up to two **quick actions** its publisher picked for everyday use, such as Bazarr's subtitle checks. An extension with nothing to do day to day, such as Potion, shows none. Quick actions appear while the extension is turned on. An action that needs a program lets you search your library by title.
5. Choose a card to open the extension's details:
   - **Info**: what it does, its version and updates, its status, what it provides to Tunarr (such as similar titles for seed channels), and **Uninstall**.
   - **Configuration**: its settings, **Enable**, **Test** and **Save**.
   - **Actions**: every action it offers, quick ones included.
   - **Access**: Access at a glance (see below).

   A tab with nothing in it isn't shown. Uninstalling removes the extension, its settings, its saved credentials and the data it kept. Your channels and media are not changed.

**Manage sources** accepts public GitHub repositories with a compatible source list. GitHub caches published files, so a new listing or update can take up to about 10 minutes to appear. Enabling a source fetches its listings. Installing or updating code requires a separate choice. A new installation gets its initial source from `TUNARR_EXTENSION_SOURCE`. An empty value starts with no sources. Saved sources can be enabled or disabled in Settings.

Tunarr includes the extension runtime. Install the service an extension connects to separately. If an action reaches its 30-second limit, Settings shows **Extension timed out.** You can retry it. Channel playback runs independently.

## Before you install

Each listing shows **Access at a glance**: four sentences from the publisher about what the extension reads, changes, connects to and downloads, and a line from Tunarr saying what the extension is actually allowed to do, from its manifest: the services it can reach, the memory and disk it may use, and what it downloads. If the publisher wrote no guide, the listing says so. Use the eye button to hide a listing you don't want to see; **Show hidden** brings it back.

## Who can operate the store

Open **Settings → Extensions → Set up administrator access** and choose **Get setup code**. Read the code from `setup-code.txt` in the Tunarr data folder or the server console. In Docker, you can open the file in the mounted data folder or use `docker compose logs tunarr`. Each code expires after ten minutes. Requesting a new code replaces the previous one.

Enter the code, choose a username and password, and select **Create administrator**. The login takes effect immediately on the same pages and API routes that Tunarr Basic Auth protects. Your TV can still fetch its playlist, guide and streams. Other browsers can sign in at `/admin`. Use HTTPS or a private tunnel for remote access.

**Existing environment login.** When both `TUNARR_BASIC_AUTH_USER` and `TUNARR_BASIC_AUTH_PASSWORD` are set, Tunarr uses those credentials. Change them in your environment to recover that login.

**Lost your saved login?** Open `/admin`, select **Forgot password?**, and read the new code from the same file or console. Enter the code and your new username and password. This signs out other browsers. A normal browser sign-in lasts up to 12 hours across restarts. If Tunarr cannot read the saved account, playback stays available and protected routes stay locked. You can use the same recovery flow or delete `auth/admin.json` from the data folder and restart to return to first-time setup. Tunarr’s TAR and ZIP backups include the saved account.

**Trusted LAN access.** With no administrator configured, `TUNARR_EXTENSION_TRUSTED_LAN=true` allows anyone who can reach Tunarr to manage extensions and run actions. A configured server login still protects those routes.

## What an extension can do

When you select a program, Tunarr gives the extension its media type and identifiers. An extension can calculate a result and ask Tunarr to make a declared request to a service you configured, such as reading Bazarr's movie list or asking Bazarr to search for subtitles. Tunarr attaches the credentials to the outgoing request; the extension's code never sees them.

Services on the same machine as Tunarr work, including over `localhost` and on a shared Docker network, except on Tunarr's own ports. Link-local and cloud metadata addresses are refused, and so are redirects. Use the service's direct address. Tunarr can't recognize itself behind a port mapping or a reverse proxy, so don't point an extension at one that leads back to Tunarr.

Store configuration and credentials live in the private `extension-store` subdirectory of your Tunarr data directory. Protect that volume and its backups. Extensions can't change channels, schedules or media. An extension keeps its own data only in its storage, within the allowance its listing shows; uninstalling removes it. [Package interface](../../server/resources/extensions/README.md)

## Roadmap

Extensions are new. This beta puts the idea in front of people early, so what comes next depends on what you would use them for.

**In 0.5**

- Install extensions from public GitHub sources, update them and uninstall them from Settings.
- Set an extension up with a connection test before saving.
- Run an extension's actions from its details, or its quick actions from its card, including actions that ask for a program from your library.
- Requests to services you configure, such as Bazarr. A subtitle request extension can also search for a missing track during [subtitle preparation](subtitles.md#turn-on-preparation).
- Storage for an extension's own data, and data files shipped with it, such as a model.
- Extensions that Tunarr calls on its own. Tunarr features ask for a capability rather than a particular extension: Semantic and Balanced matching use any installed extension that provides similar titles, such as Potion.
- "Access at a glance" on each listing: the publisher's summary, plus what Tunarr lets the extension do.
- Several extensions in one repository, and hiding listings you don't want to see.
- [Bazarr](https://github.com/TacoRocket/tunarr-bazarr-extension): check which subtitle languages Bazarr has for a movie, and ask Bazarr to search for the missing ones.
- [Potion](https://github.com/TacoRocket/tunarr-extensions/tree/main/packages/potion): semantic recommendations from a small model that runs inside Tunarr, with nothing extra to run.

**Being considered**

- Reading Tunarr data such as programs and channels.
- Scheduled runs.
- A log for each extension in its details.

**Versions.** Each Tunarr update may add to the extension API as a new minor version (0.6, 0.7), and extensions built for an earlier minor keep working. **1.0** will be the first stable API and the first place a change may break extensions; it may come as soon as the next release.

To suggest something or report a problem with the extension store, [open an issue](https://github.com/TacoRocket/tunarr-retuned/issues/new). Problems with a particular extension go to that extension's publisher.

# Extension store

Open **Settings → Extensions**. Installed extensions appear as cards. Choose **Add extension** to browse the extensions your sources offer, starting with the [default source](https://github.com/TacoRocket/tunarr-extensions). Each extension’s publisher supplies its settings, actions and updates.

## Install and use

1. In **Add extension**, check the publisher and description, then choose **Install**. The extension’s setup opens.
2. Enter the address of your existing service and any credentials it needs. The address must be reachable from the machine or container running Tunarr. **Test** checks the settings without saving. **Save** turns the extension on; switch off **Enable** first to save it turned off. **Cancel** discards edits.
3. A saved credential stays hidden. Leave its field blank to keep it. If you change the service address, enter the credential again: Tunarr does not send a saved credential to a new address.
4. An enabled extension shows its actions as buttons on its card. An action that needs a program lets you search your library by title.
5. Choose a card to change its settings, check for an update, update or uninstall it. Uninstalling removes the extension, its settings and its saved credentials. Your channels and media are not changed.

**Manage sources** accepts public GitHub repositories with a compatible source list. Enabling a source fetches its listings. Installing or updating code requires a separate choice. A new installation gets its initial source from `TUNARR_EXTENSION_SOURCE`. An empty value starts with no sources. Saved sources can be enabled or disabled in Settings.

Tunarr includes the extension runtime. Install the service an extension connects to separately. If an action reaches its 30-second limit, Settings shows **Extension timed out.** You can retry it. Channel playback runs independently.

## Who can operate the store

With Tunarr Basic Auth configured, the store uses the same login. Without a login the default is browse-only. To allow management on an instance you keep on a trusted LAN, start Tunarr with the environment variable `TUNARR_EXTENSION_TRUSTED_LAN=true`. For Docker Compose, set it on the service and recreate the container:

```yaml
environment:
  TUNARR_EXTENSION_TRUSTED_LAN: "true"
```

Everyone who can reach that instance can then install packages, test addresses, change settings and run service reads. The flag preserves any Tunarr login you already have. For remote access, use Tunarr’s `TUNARR_BASIC_AUTH_USER` and `TUNARR_BASIC_AUTH_PASSWORD` with HTTPS or a private tunnel.

## What an extension can read

When you select a program, Tunarr provides its media type and identifiers. A package can calculate a result and ask Tunarr to read a declared path on a service you configured. The host attaches credentials to the outgoing request. Local network services on another address are supported, including a separate container on the same Docker network. Loopback, Tunarr’s own network interfaces and link-local metadata targets are blocked. Redirects are refused. Configure the service’s direct address rather than a redirect or a proxy back to Tunarr.

Store configuration and credentials live in the private `extension-store` subdirectory of your Tunarr data directory. Protect that volume and its backups. Version 2 has no operation for changing channels, schedules or media and grants no persistent filesystem to package code. [Package interface](../../server/resources/extensions/README.md)

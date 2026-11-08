# Extension store

Open **Settings → Extensions** in the fork container to browse packages from the [default source](https://github.com/TacoRocket/tunarr-extensions). The store runs inside Tunarr’s container. Each extension’s publisher supplies its settings, actions and updates.

## Install and use

1. Choose **Install** on a listing. Check its publisher and description.
2. If a setup form opens, enter the address of your existing service and any credentials it requires. That address must be reachable from Tunarr’s container. If the package offers **Test connection**, you can check the settings before saving. **Cancel** discards edits. **Save and enable** makes the extension’s actions available.
3. Under **Installed**, run an action, change settings, check for an update or disable the extension. An action that asks for a Tunarr program ID takes the last part of the program’s library detail URL. Disabling a package stops its actions and keeps its settings.

**Manage sources** accepts public GitHub repositories with a compatible source list. Enabling a source fetches its listings. Installing or updating code requires a separate choice. A new installation gets its initial source from `TUNARR_EXTENSION_SOURCE`. An empty value starts with no sources. Saved sources can be enabled or disabled in Settings.

Extension actions require native Linux amd64 in this release. The store can open under amd64 emulation on Apple Silicon, but the action process exceeded its address-space limit in Docker Desktop with Rosetta.

## Who can operate the store

With Tunarr Basic Auth configured, the store uses the same login. Without a login the default is browse-only. To allow management on an instance you keep on a trusted LAN, set this in its container environment and recreate the container:

```yaml
environment:
  TUNARR_EXTENSION_TRUSTED_LAN: "true"
```

Everyone who can reach that instance can then install packages, test addresses, change settings and run service reads. The flag preserves any Tunarr login you already have. For remote access, use Tunarr’s `TUNARR_BASIC_AUTH_USER` and `TUNARR_BASIC_AUTH_PASSWORD` with HTTPS or a private tunnel.

## What an extension can read

When you select a program, Tunarr provides its media type and identifiers. A package can calculate a result and ask Tunarr to read a declared path on a service you configured. The host attaches credentials to the outgoing request. Local network services on another address are supported, including a separate container on the same Docker network. Loopback, Tunarr’s own network interfaces and link-local metadata targets are blocked. Redirects are refused. Configure the service’s direct address rather than a redirect or a proxy back to Tunarr.

Store configuration and credentials live in the private `extension-store` subdirectory of your Tunarr data volume. Protect that volume and its backups. Version 2 has no operation for changing channels, schedules or media and grants no persistent filesystem to package code. [Package interface](../../server/resources/extensions/README.md)

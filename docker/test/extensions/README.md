# Tunarr extension store trial

Open **Settings → Extensions** on a running trial instance to browse and install extensions. The first visit reads the [public default source](https://github.com/TacoRocket/tunarr-extensions). A listing shows what the extension does, who publishes it, and which version you can install.

## Install an extension

1. Choose **Install** on a listing. The extension host fetches the selected release and reads its setup form.
2. Enter the settings the extension asks for. If it offers **Test connection**, use it before saving. **Cancel** discards edits. **Save and enable** makes the configured extension available under **Installed**.
3. From **Installed**, use the extension’s actions, change settings, check for updates, or disable it. Disabling an extension keeps its saved settings. Updating a package leaves Tunarr running.

The first listing, **Bazarr**, connects to a Bazarr service you already run. Its setup asks for the address and an optional API key. Enter an address reachable from the extension host, including the port and any URL base. [Bazarr setup and subtitle lookup](https://github.com/TacoRocket/tunarr-bazarr-extension#install-in-the-trial)

## Manage sources

Open **Manage sources** to refresh a listing, enable or disable a source, or add another public GitHub repository containing a compatible `source.json`. Enabling a source fetches its list. Installing a listing runs code from the publisher shown. Choose sources and publishers you trust. Disabling a source hides its listings and preserves installed packages.

## Start a separate trial instance

If your Tunarr install has no Extensions page, this branch includes a separate test stack. You need Git and Docker Compose. The published server runs on Linux/amd64. Docker Desktop on Apple Silicon needs amd64 emulation for the server.

```sh
git clone --branch trial/extension-store --single-branch https://github.com/TacoRocket/tunarr.git tunarr-extension-trial
cd tunarr-extension-trial/docker/test/extensions
docker compose up -d --build
```

Open [Settings → Extensions](http://localhost:8432/web/settings/extensions). The gateway binds to loopback for a local administrator. Use an SSH tunnel on a remote server. Set `EXT_DEFAULT_SOURCE` before the first start to choose a different default.

The stack uses the released `2026.11.0-trfork.1` Bun server and this branch’s web UI. Tunarr can show a version mismatch message. Connect a media source to the trial Tunarr to use actions that need an actual program. The trial Tunarr and store each have their own volume. This version uses fresh extension state. Earlier proof-of-concept installations keep their original volume. [Extension host operation](host/README.md)

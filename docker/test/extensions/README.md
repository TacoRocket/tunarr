# Try the Bazarr extension in Tunarr

This trial adds **Settings → Extensions** to a separate Tunarr instance. From that page you can install the Bazarr adapter from its GitHub repo, configure it, check movie subtitle languages, update it, and disable it. The adapter runs in its own container and stores settings in its own volume.

## Start the test instance

You need Git, Docker with Compose v2 or later, and a running Bazarr service connected to Radarr. The first build downloads the fork’s published Linux/amd64 Tunarr image, Node build dependencies, Python and nginx. The test container runs natively on amd64 Linux. On Apple Silicon, Docker Desktop needs Linux/amd64 emulation; only the static web assets are built natively. This setup targets containers, with the web interface on loopback.

```sh
git clone --branch trial/bazarr-extension-install --single-branch https://github.com/TacoRocket/tunarr.git tunarr-extension-trial
cd tunarr-extension-trial/docker/test/extensions
docker compose up -d --build
```

Open [Tunarr Extensions](http://localhost:8432/web/settings/extensions). This Compose project starts with an empty Tunarr data volume. Leave it separate from your usual Tunarr database. To do a real movie lookup, connect a media source in this test Tunarr and pick a movie that Bazarr also knows through Radarr. For a playback trial, add media to a test channel and open its stream in your player before changing the extension.

## Install and configure

1. Under **GitHub repository URL**, paste `https://github.com/TacoRocket/tunarr-bazarr-extension`. Select **Find extension**, then **Install**. The trial installs adapter 0.3.0 at a pinned commit.
2. Select **Configure**. Enter your existing Bazarr URL, including the port and any URL base. The extension container must be able to reach that address. For a service published on Docker Desktop, an example is `http://host.docker.internal:6767`. A Bazarr service on a separate machine can use its LAN address. Inside the extension container, `localhost` points back to the extension itself.
3. Choose **Test connection**. It tries the settings you entered without saving them. You can leave the key blank on first setup. If Bazarr returns HTTP 401 or 403, enter its API key from **Bazarr → Settings → General → Security** and test again. **Cancel** discards edits. **Save and enable** tests again, then stores the settings only if Bazarr responds successfully.
4. Open the movie’s detail page in the Tunarr library and copy the last part of its address, after `/web/media/movie/`. Back in Extensions, paste that value into **Tunarr movie program ID** and choose **Check subtitles**. The adapter uses the movie’s IMDb identifier to find one matching record in Bazarr and reports installed language codes. Multiple matching records return an ambiguous result. Bazarr’s index reports subtitle availability; playback and track selection remain with Tunarr and the player.

## Update and disable

**Check for update** reads `feed.json` on the publisher’s GitHub repository. **Update to 0.4.0** downloads that release by full commit and verifies the adapter digest. Repeat the same lookup to see missing languages under the assigned Bazarr profile. There is no Tunarr rebuild, image pull, or service restart during this step.

While your channel is playing, choose **Disable**. Further lookups stop and the player can continue its existing stream. **Enable** uses the saved setup. Removing the test containers with `docker compose down` preserves their named volumes. To start them again, run `docker compose up -d`.

## Scope and storage

The trial accepts one repository. Its host API, setup form, update procedure and credential handling are described in the [extension host README](host/README.md). Trust the repository owner before applying an update. The extension host can read its saved Bazarr credential. Its container has no Tunarr database, media-library mount or Docker socket. The browser needs no GitHub login and there is no catalog or automatic updater.

The gateway is bound to `127.0.0.1:8432` for a local administrator. Use a tunnel when testing on a remote server. The `tunarr-data` volume belongs to the test Tunarr. The separate `extension-data` volume contains the downloaded adapter, its saved settings and its enabled status. Keep backups of either volume private.

The public Compose proof pairs the fork’s released `2026.11.0-trfork.1` Bun server with web assets built from this trial branch. The UI can report that its version differs from the server. This package exercises the extension workflow; newer branch-specific settings elsewhere in Tunarr may require a newer server.

# Tunarr extension host trial

This stand-alone HTTP host installs one approved Bazarr adapter from GitHub. The package manifest describes its setup fields. The adapter owns connectivity checks and subtitle queries. A user can add the repository, configure an existing Bazarr service, run a lookup, update the adapter, and disable it without restarting Tunarr. The result view renders returned fields, so an adapter update can display new information without a host release.

## Run the trial

Use a trial Tunarr container and an existing Bazarr service reachable from this host. Build in this directory. Replace `trial_network` and `http://trial-tunarr:8000` with your Docker network and Tunarr URL. Use a private port on the same machine or reach it over an SSH tunnel.

```sh
docker build -t tunarr-extension-host:trial .
docker volume create tunarr-extension-state
docker run -d --name tunarr-extension-host --network trial_network \
  -p 127.0.0.1:8090:8090 --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 64 --memory 192m \
  --tmpfs /tmp:size=8m --mount source=tunarr-extension-state,target=/state \
  -e TUNARR_URL=http://trial-tunarr:8000 tunarr-extension-host:trial
```

Open `http://localhost:8090/extensions/`. An existing reverse proxy may serve this page on the trial Tunarr origin under `/extensions/`. Forward the original Host header. Pass permitted hostnames (without ports) in `EXT_ALLOWED_HOSTS` if the UI is accessed through a different name. This interface assumes a trusted administrator; keep it loopback-only or behind an authenticated proxy.

1. Paste `https://github.com/TacoRocket/tunarr-bazarr-extension` and choose **Find extension**. Check the manifest name and version, then **Install**.
2. Enter the reachable HTTP(S) URL of your running Bazarr, e.g. `http://192.168.1.20:6767`. Include your configured URL base if applicable. Enter the Bazarr API key from **Settings → General → Security** if the service requires it.
3. **Test connection** runs the installed adapter against the actual service. **Save and enable** repeats that check and saves the settings only after success. A blank key on initial setup tests unauthenticated access. When editing, a blank field reuses a stored key only for the same service URL. **Clear the saved key** explicitly tries without it.
4. Enter a trial Tunarr movie program UUID under **Check subtitles**. The manager reads that program through Tunarr’s API. The adapter must match a single Bazarr movie by its IMDb identifier. The first version returns installed subtitle languages. **Check for update** reads the publisher’s GitHub release feed. **Update to …** installs the version you reviewed. The second trial release adds missing subtitle languages when a profile is assigned.
5. **Disable** stops further lookups and persists through a host restart. **Enable** resumes with the saved configuration. The dedicated state volume holds immutable release payloads, configuration and enablement; removing the manager does not remove that volume or touch Tunarr.

## Package and isolation

The trial approves one repository and one initial commit in `manager.py`. Discover reads its manifest. **Check for update** reads the publisher’s `feed.json` from its GitHub default branch. The feed identifies the latest release by version and full commit. The manager validates that commit’s manifest and caches the offered version. **Update** fetches the exact commit shown to the administrator, even if the feed changes. Install and update fetch the adapter at the same immutable commit, validate the manifest and the adapter checksum, then atomically switch the active revision. An unsuccessful update retains the previous revision. Assets download from GitHub on user actions only; ordinary lookup and disable use local state. Publishing a compatible feed entry makes it available for review without changing the manager. A publisher with write access to this repository can offer executable code: the trust decision is the repository and the administrator’s manual update.

The installed adapter runs in a separate Python process in the host's container. It has access to that container's state and network, and receives its configured service credential. Python isolated mode is not a security sandbox. Mount only the extension host's own volume, never Tunarr's database, media library, or the Docker socket. The trial does not provide a sandbox between multiple extensions or a catalog.

The manager exposes public, non-secret state under `/extensions/state`. Browser writes use same-origin POSTs with a CSRF token and the allowed Host check. Saved keys stay in a mode-0600 file in the host's state volume. Use TLS or an SSH tunnel on an untrusted network. A host administrator with filesystem access can read that volume.

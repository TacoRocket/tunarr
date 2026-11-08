"""Public source listings, per-publisher installations and manifest-declared actions."""

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import tempfile
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID

from broker import BrokerError, service_read, validate_reads
from runner import GuestError, run_guest


class Problem(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_url(service, url, limit, headers=None):
    try:
        with build_opener(ProxyHandler({}), NoRedirect).open(Request(url, headers=headers or {}), timeout=8) as res:
            body = res.read(limit + 1)
    except HTTPError as exc:
        raise Problem(502, f"{service} returned HTTP {exc.code}.") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise Problem(502, f"Could not reach {service}.") from exc
    if len(body) > limit:
        raise Problem(502, f"{service} returned more data than the host supports.")
    return body


def json_document(data, service):
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError) as exc:
        raise Problem(502, f"Invalid JSON returned by {service}.") from exc
    if not isinstance(value, dict):
        raise Problem(502, f"Invalid response from {service}.")
    return value


def write_atomic(path, content):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary.write(content)
        temporary.flush()
        os.fsync(temporary.fileno())
    os.replace(temporary.name, path)


def service_url(name):
    raw = os.environ[name].rstrip("/")
    parsed = urlsplit(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f"Invalid service URL in {name}")
    return raw


GITHUB_SLUG = r"[a-zA-Z0-9][a-zA-Z0-9-]{0,38}/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}"


def source_repository(url):
    match = re.fullmatch(r"https://github\.com/(" + GITHUB_SLUG + r")/?", url.strip(), re.IGNORECASE)
    if not match:
        raise Problem(400, "Enter a public GitHub repository URL.")
    return match.group(1)


def validate_release(release):
    if (not isinstance(release, dict)
        or not isinstance(release.get("commit"), str)
        or not re.fullmatch(r"[0-9a-f]{40}", release["commit"])
        or not isinstance(release.get("version"), str)
        or not re.fullmatch(r"[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}", release["version"])):
        raise Problem(422, "Invalid extension release version or commit.")


def download(repository, commit, name, limit):
    # Source URLs and package publishers are public. Never attach service credentials.
    url = f"https://raw.githubusercontent.com/{repository}/{commit or 'HEAD'}/{name}"
    return read_url("GitHub", url, limit, {"User-Agent": "Tunarr-extension-host"})


def read_source(source):
    try:
        repo = source_repository(source["url"])
        data = json_document(download(repo, None, "source-v2.json", 128 * 1024), "extension source")
        entries = data.get("extensions")
        if data.get("schemaVersion") != 1 or not isinstance(entries, list):
            raise Problem(422, "Unsupported extension source format.")
        listing = []
        ids = set()
        for entry in entries:
            validate_release(entry)
            extension_id = entry.get("id")
            if (not isinstance(extension_id, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,79}", extension_id)
                or extension_id in ids or not isinstance(entry.get("repository"), str)
                or not re.fullmatch(GITHUB_SLUG, entry["repository"])
                or not isinstance(entry.get("name"), str) or not entry["name"]
                or not isinstance(entry.get("description"), str)):
                raise Problem(422, "Invalid or duplicate extension listing.")
            ids.add(extension_id)
            listing.append({key: entry[key] for key in ("id", "name", "description", "repository", "version", "commit")})
        source.update(entries=listing)
        source.pop("error", None)
    except Problem as exc:
        source.update(entries=[], error=str(exc))


FORM_KEYS = {"key", "_csrf", "action", "commit", "clearSecret", "connectionTest", "testConnection"}


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,63}", value)


def validate_fields(fields, types, reserved):
    if not isinstance(fields, list):
        raise Problem(422, "Invalid extension fields.")
    keys = set()
    for field in fields:
        if (not isinstance(field, dict) or not valid_id(field.get("key")) or field["key"] in reserved
            or field["key"] in keys or not isinstance(field.get("type"), str) or field["type"] not in types
            or not isinstance(field.get("label"), str) or not isinstance(field.get("required", False), bool)):
            raise Problem(422, "The extension has unsupported or conflicting fields.")
        keys.add(field["key"])
    return keys


class Manager:
    def __init__(self):
        default = os.environ.get("EXT_DEFAULT_SOURCE", "").strip()
        self.default_source = "https://github.com/" + source_repository(default) if default else None
        self.tunarr_url = service_url("TUNARR_URL")
        self.root = Path(os.environ["STATE_DIR"])
        self.root.mkdir(mode=0o700, exist_ok=True, parents=True)
        if self.root.is_symlink() or self.root.stat().st_uid != os.geteuid():
            raise RuntimeError("The extension state directory must be owned by the host process user.")
        self.root.chmod(0o700)
        self.store = self.root / "installations"
        self.store.mkdir(mode=0o700, exist_ok=True)
        self.sourcefile = self.root / "sources.json"
        self.source_lock = Lock()

    def sources(self):
        with self.source_lock:
            return self._sources()

    def _sources(self):
        if self.sourcefile.exists():
            return json_document(self.sourcefile.read_bytes(), "saved sources")["sources"]
        if not self.default_source:
            return []
        initial = {"url": self.default_source, "enabled": True}
        read_source(initial)
        self._save_sources([initial])
        return [initial]

    def _save_sources(self, sources):
        write_atomic(self.sourcefile, json.dumps({"sources": sources}).encode())

    def set_source(self, url, enabled):
        return self._change_source(url, enabled)

    def refresh_source(self, url):
        return self._change_source(url, None)

    def _change_source(self, url, enabled):
        canonical = "https://github.com/" + source_repository(url)
        with self.source_lock:
            sources = self._sources()
            source = next((s for s in sources if s["url"].lower() == canonical.lower()), None)
            if source is None:
                if enabled is not True:
                    raise Problem(404, "Unknown extension source.")
                source = {"url": canonical, "enabled": False, "entries": []}
                sources.append(source)
            if enabled is None and not source["enabled"]:
                raise Problem(409, "Enable this source before refreshing it.")
            if enabled is None or (enabled and not source["enabled"]):
                read_source(source)
            if enabled is not None:
                source["enabled"] = enabled
            if not source["enabled"]:
                source["entries"] = []
                source.pop("error", None)
            self._save_sources(sources)
            return source

    def directory(self, key):
        # User-facing keys contain a slash. On disk use one opaque directory per publisher and id.
        return self.store / hashlib.sha256(key.encode()).hexdigest()

    def installed(self):
        records = {}
        for path in self.store.glob("*/state.json"):
            state = json_document(path.read_bytes(), "installed extension state")
            records[state["key"]] = state
        return records

    def state(self, key):
        path = self.directory(key) / "state.json"
        if not path.exists():
            raise Problem(404, "Extension is not installed.")
        state = json_document(path.read_bytes(), "installed extension state")
        if state.get("key") != key:
            raise Problem(409, "Installed extension identity does not match.")
        return state

    def set_state(self, state):
        write_atomic(self.directory(state["key"]) / "state.json", json.dumps(state).encode())
        return state

    def manifest(self, repository, extension_id, release):
        validate_release(release)
        manifest = json_document(download(repository, release["commit"], "tunarr-extension.json", 16384), "GitHub manifest")
        expected = {"id": extension_id, "version": release["version"], "apiVersion": 2, "entrypoint": "adapter.js"}
        if any(manifest.get(k) != v for k, v in expected.items()):
            raise Problem(422, "The extension manifest is incompatible with this host.")
        if (not isinstance(manifest.get("name"), str)
            or not isinstance(manifest.get("description", ""), str)
            or not isinstance(manifest.get("connectionTest", False), bool)):
            raise Problem(422, "Invalid extension metadata.")
        settings = manifest.setdefault("settings", [])
        setting_keys = validate_fields(settings, {"url", "text", "secret"}, FORM_KEYS)
        actions = manifest.get("actions")
        if not isinstance(actions, list) or not actions:
            raise Problem(422, "This extension must declare its supported actions.")
        ids = {"test"}
        for action in actions:
            if (not isinstance(action, dict) or not valid_id(action.get("id"))
                or action["id"] in ids or not isinstance(action.get("label"), str)):
                raise Problem(422, "Invalid or duplicate extension action.")
            ids.add(action["id"])
            validate_fields(action.setdefault("inputs", []), {"text", "tunarrProgram"}, FORM_KEYS | setting_keys)
        try:
            validate_reads(manifest)
        except BrokerError as exc:
            raise Problem(exc.status, str(exc)) from exc
        return manifest

    def installed_manifest(self, state):
        path = self.directory(state["key"]) / (state["commit"] + ".json")
        return json_document(path.read_bytes(), "installed manifest")

    def install(self, source_url, extension_id, expected_commit, expected_repository):
        canonical = "https://github.com/" + source_repository(source_url)
        source = next((s for s in self.sources() if s["url"].lower() == canonical.lower()), None)
        if not source or not source["enabled"]:
            raise Problem(409, "Enable this source before installing its extension.")
        entry = next((e for e in source["entries"] if e["id"] == extension_id), None)
        if not entry or entry["commit"] != expected_commit or entry["repository"] != expected_repository:
            raise Problem(409, "The displayed listing changed. Review the publisher and version before installing.")
        key = entry["repository"].lower() + ":" + extension_id
        installed = self.installed()
        if key in installed:
            raise Problem(409, "This publisher's extension is already installed.")
        self.directory(key).mkdir(mode=0o700, exist_ok=True)
        return self.fetch_release({
            "key": key, "id": entry["id"], "source": source["url"], "repository": entry["repository"],
            "version": entry["version"], "commit": entry["commit"], "installed": True,
        })

    def check_update(self, key):
        state = self.state(key)
        feed = json_document(download(state["repository"], None, "feed-v2.json", 4096), "GitHub release feed")
        if feed.get("id") != state["id"]:
            raise Problem(422, "The release feed does not belong to this extension.")
        release = feed.get("latest")
        validate_release(release)
        current_version = tuple(map(int, state["version"].split(".")))
        latest_version = tuple(map(int, release["version"].split(".")))
        if latest_version > current_version:
            self.manifest(state["repository"], state["id"], release)
            candidate = {"version": release["version"], "commit": release["commit"]}
        else:
            candidate = None
        return self.set_state({**state, "update": candidate})

    def update(self, key, expected_commit):
        state = self.state(key)
        candidate = state.get("update")
        if not candidate or candidate["commit"] != expected_commit:
            raise Problem(409, "Check for an update and review the available version first.")
        return self.fetch_release({**state, **candidate, "update": None})

    def fetch_release(self, state):
        manifest = self.manifest(state["repository"], state["id"], state)
        commit = state["commit"]
        code = download(state["repository"], commit, manifest["entrypoint"], 128 * 1024)
        digest = manifest.get("sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest) or not hmac.compare_digest(hashlib.sha256(code).hexdigest(), digest):
            raise Problem(422, "Extension package checksum mismatch.")
        directory = self.directory(state["key"])
        if "enabled" not in state:
            ready = not manifest["settings"] and not manifest.get("connectionTest", False)
            state.update(configured=ready, enabled=ready)
        else:
            # A release that changes its settings must be configured again before it receives credentials.
            old = self.installed_manifest(self.state(state["key"]))
            if old["settings"] != manifest["settings"] or old.get("connectionTest", False) != manifest.get("connectionTest", False) or old.get("reads", []) != manifest.get("reads", []):
                state.update(configured=False, enabled=False)
            old_types = {field["key"]: field["type"] for field in old["settings"]}
            new_types = {field["key"]: field["type"] for field in manifest["settings"]}
            if old_types != new_types:
                saved = self.settings(state["key"])
                retained = {key: value for key, value in saved.items()
                            if key in old_types and old_types[key] == new_types.get(key)}
                # Publish the new settings with the package pointer so an interrupted update leaves
                # the previous version's credentials intact.
                state["settingsFile"] = f"settings-{commit}.json"
                write_atomic(directory / state["settingsFile"], json.dumps(retained).encode())
        write_atomic(directory / f"{commit}.js", code)
        write_atomic(directory / f"{commit}.json", json.dumps(manifest).encode())
        return self.set_state(state)

    def toggle(self, key, enabled):
        state = self.state(key)
        if enabled and not state["configured"]:
            raise Problem(409, "Configure the extension first.")
        return self.set_state({**state, "enabled": enabled})

    def settings(self, key):
        state = self.state(key)
        path = self.directory(key) / state.get("settingsFile", "settings.json")
        if not path.exists():
            return {}
        return json_document(path.read_bytes(), "extension settings")

    def configure(self, key, values, persist):
        state = self.state(key)
        manifest = self.installed_manifest(state)
        fields = manifest["settings"]
        saved = self.settings(key)
        config = {field["key"]: values.get(field["key"], "").strip() for field in fields}
        urls_unchanged = True
        for field in fields:
            name = field["key"]
            if field["type"] == "url":
                value = config[name] = config[name].rstrip("/")
                if value:
                    parsed = urlsplit(value)
                    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                        raise Problem(400, f'Enter a valid HTTP or HTTPS URL for {field["label"]}.')
                if value != saved.get(name):
                    urls_unchanged = False
        for field in fields:
            name = field["key"]
            if field["type"] == "secret" and not config[name] and urls_unchanged and values.get("clear:" + name) != "on":
                config[name] = saved.get(name, "")
            if field.get("required") and not config[name]:
                raise Problem(400, f'Enter {field["label"]}.')
        if manifest.get("connectionTest"):
            response = self.run_adapter(state, manifest, config, {"action": "test"})
            if response.get("status") != "connected":
                raise Problem(502, "Connection test failed.")
        else:
            if not persist:
                raise Problem(409, "This extension does not declare a connection test.")
            response = {"status": "configured"}
        if persist:
            path = self.directory(key) / state.get("settingsFile", "settings.json")
            write_atomic(path, json.dumps(config).encode())
            self.set_state({**state, "enabled": True, "configured": True})
        return response

    def run_action(self, key, action_id, values):
        state = self.state(key)
        if not state["enabled"]:
            raise Problem(409, "This extension is disabled.")
        manifest = self.installed_manifest(state)
        action = next((a for a in manifest["actions"] if a["id"] == action_id), None)
        if not action:
            raise Problem(404, "Unknown extension action.")
        payload = {"action": action_id}
        for field in action["inputs"]:
            name = field["key"]
            value = values.get(name, "").strip()
            if not value:
                if field.get("required"):
                    raise Problem(400, f'Enter {field["label"]}.')
                continue
            if field["type"] == "tunarrProgram":
                try:
                    program_id = str(UUID(value))
                except ValueError as exc:
                    raise Problem(400, "Enter a valid Tunarr program UUID.") from exc
                value = self.program(program_id)
            payload[name] = value
        return {"version": state["version"], "result": self.run_adapter(state, manifest, self.settings(key), payload)}

    def program(self, program_id):
        headers = {}
        username = os.environ.get("TUNARR_BASIC_AUTH_USER")
        password = os.environ.get("TUNARR_BASIC_AUTH_PASSWORD")
        if username and password:
            token = base64.b64encode(f"{username}:{password}".encode()).decode("ascii")
            headers["Authorization"] = f"Basic {token}"
        path = f"{self.tunarr_url}/api/programs/{quote(program_id)}"
        program = json_document(read_url("Tunarr", path, 256 * 1024, headers), "Tunarr")
        identifiers = [
            {"type": identifier["type"], "id": identifier["id"]}
            for identifier in program.get("identifiers") or []
            if isinstance(identifier, dict) and isinstance(identifier.get("type"), str)
            and isinstance(identifier.get("id"), str)
        ]
        return {"type": program.get("type"), "identifiers": identifiers}

    def run_adapter(self, state, manifest, settings, payload):
        if manifest.get("apiVersion") != 2:
            raise Problem(422, "This extension requires a compatible API v2 release.")
        guest_input = {
            field["key"]: settings[field["key"]] for field in manifest["settings"]
            if field["type"] == "text" and field["key"] in settings
        }
        code_path = self.directory(state["key"]) / (state["commit"] + ".js")
        try:
            code = code_path.read_text(encoding="utf-8")
            def read(operation, params, remaining):
                return service_read(manifest, settings, operation, params, timeout=remaining)

            return run_guest(code, {**guest_input, **payload}, read)
        except UnicodeError as exc:
            raise Problem(422, "The extension entry point is not UTF-8 JavaScript.") from exc
        except (BrokerError, GuestError) as exc:
            raise Problem(exc.status, str(exc)) from exc

"""Trial host for one approved extension with publisher-managed releases."""

import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID


class Problem(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def read_url(service, url, limit, headers=None):
    try:
        with build_opener(NoRedirect).open(Request(url, headers=headers or {}), timeout=8) as res:
            body = res.read(limit + 1)
    except HTTPError as exc:
        raise Problem(502, f"{service} returned HTTP {exc.code}.") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise Problem(502, f"Could not reach {service}.") from exc
    if len(body) > limit:
        raise Problem(502, f"{service} returned more data than the trial supports.")
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


DEFAULT_REPO = "TacoRocket/tunarr-bazarr-extension"
BOOTSTRAP = {"version": "0.3.0", "commit": "16cf028d6c2b4163ad933d7538c3cd165c023828"}


def validate_release(release):
    if (not isinstance(release, dict)
        or not re.fullmatch(r"[0-9a-f]{40}", str(release.get("commit", "")))
        or not re.fullmatch(r"[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}", str(release.get("version", "")))):
        raise Problem(422, "Invalid extension release version or commit.")


class Manager:
    def __init__(self):
        self.repo = DEFAULT_REPO
        self.url = f"https://github.com/{self.repo}"
        self.tunarr_url = service_url("TUNARR_URL")
        self.root = Path(os.environ.get("STATE_DIR", "/state"))
        self.root.mkdir(mode=0o700, exist_ok=True, parents=True)
        self.statefile = self.root / "state.json"

    def state(self):
        if not self.statefile.exists():
            return {"installed": False, "enabled": False, "version": None, "commit": None}
        state = json_document(self.statefile.read_bytes(), "the extension state file")
        validate_release(state)
        if state.get("update"):
            validate_release(state["update"])
        return state

    def set_state(self, state):
        write_atomic(self.statefile, json.dumps(state).encode())
        return state

    def download(self, commit, name, limit):
        url = f"https://api.github.com/repos/{self.repo}/contents/{name}"
        if commit:
            url += f"?ref={commit}"
        headers = {"Accept": "application/vnd.github.raw+json", "User-Agent": "Tunarr-extension-trial"}
        token_file = os.environ.get("EXT_GITHUB_TOKEN_FILE")
        if token_file:
            headers["Authorization"] = "Bearer " + Path(token_file).read_text().strip()
        return read_url("GitHub", url, limit, headers)

    def discover(self, repo, release=BOOTSTRAP):
        if repo.strip().rstrip("/").lower() != self.url.lower():
            raise Problem(400, "Enter the GitHub URL of the approved Bazarr repository.")
        validate_release(release)
        manifest = json_document(self.download(release["commit"], "tunarr-extension.json", 8192), "GitHub manifest")
        expected = {"id": "bazarr", "version": release["version"], "apiVersion": 1, "entrypoint": "adapter.py"}
        if any(manifest.get(k) != v for k, v in expected.items()):
            raise Problem(422, "The extension manifest is incompatible with this host.")
        fields = manifest.get("settings")
        if (
            not isinstance(fields, list) or len(fields) != 2
            or any(not isinstance(field, dict) or not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9]{0,40}", str(field.get("key", "")))
                   or not isinstance(field.get("label"), str) for field in fields)
            or sorted(str(f.get("type")) for f in fields) != ["secret", "url"]
            or len({f["key"] for f in fields}) != len(fields) or not isinstance(manifest.get("name"), str)
        ):
            raise Problem(422, "The extension has unsupported setup fields.")
        return manifest

    def installed_manifest(self, state):
        if not state["installed"]:
            raise Problem(409, "Install the extension first.")
        return json_document((self.root / f"{state['commit']}.json").read_bytes(), "installed manifest")

    def install(self, repo):
        if self.state()["installed"]:
            raise Problem(409, "This extension is already installed.")
        return self.fetch_release(repo, BOOTSTRAP, False)

    def check_update(self):
        state = self.state()
        if not state["installed"]:
            raise Problem(409, "Install the extension first.")
        feed = json_document(self.download(None, "feed.json", 4096), "GitHub release feed")
        if feed.get("id") != "bazarr":
            raise Problem(422, "The release feed does not belong to this extension.")
        release = feed.get("latest")
        validate_release(release)
        current_version = tuple(map(int, state["version"].split(".")))
        latest_version = tuple(map(int, release["version"].split(".")))
        if latest_version > current_version:
            self.discover(self.url, release)
            candidate = {"version": release["version"], "commit": release["commit"]}
        else:
            candidate = None
        return self.set_state({**state, "update": candidate})

    def update(self, expected_commit):
        state = self.state()
        candidate = state.get("update")
        if not candidate or candidate["commit"] != expected_commit:
            raise Problem(409, "Check for an update and review the available version first.")
        return self.fetch_release(self.url, candidate, state["enabled"])

    def fetch_release(self, repo, release, enabled):
        manifest = self.discover(repo, release)
        commit = release["commit"]
        code = self.download(commit, manifest["entrypoint"], 128 * 1024)
        digest = manifest.get("sha256")
        if not isinstance(digest, str) or not hmac.compare_digest(hashlib.sha256(code).hexdigest(), digest):
            raise Problem(422, "Extension package checksum mismatch.")
        write_atomic(self.root / f"{commit}.py", code)
        write_atomic(self.root / f"{commit}.json", json.dumps(manifest).encode())
        return self.set_state({"installed": True, "enabled": enabled, **release})

    def toggle(self, enabled):
        state = self.state()
        if not state["installed"]:
            raise Problem(409, "Install the extension first.")
        if enabled and not self.settings():
            raise Problem(409, "Configure the extension first.")
        return self.set_state({**state, "enabled": enabled})

    def settings(self):
        path = self.root / "settings.json"
        if not path.exists():
            return {}
        return json_document(path.read_bytes(), "extension settings")

    def configure(self, values, persist):
        state = self.state()
        fields = self.installed_manifest(state)["settings"]
        saved = self.settings()
        url_key = next(f["key"] for f in fields if f["type"] == "url")
        secret_key = next(f["key"] for f in fields if f["type"] == "secret")
        url = values.get(url_key, "").strip().rstrip("/")
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise Problem(400, "Enter the service HTTP or HTTPS base URL, including its port and optional base path.")
        secret = values.get(secret_key, "").strip()
        if not secret and url == saved.get(url_key) and values.get("clearSecret") != "on":
            secret = saved.get(secret_key, "")
        if len(secret) > 512:
            raise Problem(400, "The API key is too long.")
        config = {url_key: url, secret_key: secret}
        response = self.run_adapter(state, {"action": "test", **config})
        if response.get("status") != "connected":
            raise Problem(502, "Connection test failed.")
        if persist:
            write_atomic(self.root / "settings.json", json.dumps(config).encode())
            self.set_state({**state, "enabled": True})
        return response

    def lookup(self, program_id):
        state = self.state()
        if not state["enabled"]:
            raise Problem(409, "The Bazarr extension is disabled.")
        try:
            program_id = str(UUID(program_id))
        except ValueError as exc:
            raise Problem(400, "Enter a Tunarr movie program UUID.") from exc
        program = json_document(read_url("Tunarr", f"{self.tunarr_url}/api/programs/{quote(program_id)}", 256 * 1024), "Tunarr")
        if program.get("type") != "movie":
            raise Problem(422, "The selected program is not a movie.")
        ids = {
            item["id"] for item in (program.get("identifiers") or []) if isinstance(item, dict)
            and item.get("type") == "imdb" and isinstance(item.get("id"), str) and re.fullmatch(r"tt[0-9]+", item["id"])
        }
        if len(ids) != 1:
            raise Problem(422, "The movie needs one exact IMDb identifier for a lookup.")
        result = self.run_adapter(state, {"action": "lookup", **self.settings(), "imdbId": ids.pop()})
        if result.get("status") not in ("matched", "unmatched", "ambiguous"):
            raise Problem(502, "Unexpected Bazarr extension response.")
        return {"version": state["version"], "programId": program_id, "result": result}

    def run_adapter(self, state, payload):
        try:
            proc = subprocess.run(
                [sys.executable, "-I", str(self.root / f"{state['commit']}.py")],
                cwd="/tmp", env={}, input=json.dumps(payload).encode(), stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=32, check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise Problem(504, "Extension request timed out.") from exc
        if len(proc.stdout) > 65536:
            raise Problem(502, "Extension output was too large.")
        if proc.returncode:
            message = proc.stderr.decode(errors="replace").strip()
            if denied := re.search(r"\bHTTP (40[13])\b", message):
                raise Problem(422, f"Bazarr returned HTTP {denied[1]}. Enter a valid API key from Bazarr Settings → General → Security.")
            if re.search(r"\bHTTP 404\b", message):
                raise Problem(422, "Bazarr did not recognize the endpoint. Check the URL and base path.")
            raise Problem(502, "Could not complete the Bazarr request. Check the service address and availability.")
        return json_document(proc.stdout, "the extension")

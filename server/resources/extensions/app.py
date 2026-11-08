import json
import os
import re
import secrets
import threading
from html import escape
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingUnixStreamServer
import sys
from urllib.parse import parse_qs, urlencode, urlsplit

from manager import Manager, Problem


manager = Manager()
lock = threading.Lock()
csrf = secrets.token_urlsafe(32)
manage = os.environ.get("EXT_MANAGE") == "1"
style = """
:root{font:16px/1.5 system-ui,sans-serif;color-scheme:light dark}
body{margin:0 auto;padding:1.5rem;max-width:44rem}h1{font-size:1.65rem}h2{font-size:1.25rem;margin-bottom:.3em}
form,section{margin:1.2rem 0}label{display:block;margin-top:.7rem;font-weight:600}
input:not([type=checkbox]){width:100%;box-sizing:border-box;padding:.55rem;font:inherit}
button{cursor:pointer;padding:.4rem .85rem;font:inherit}small{display:block}
details{margin-top:2rem}summary{cursor:pointer}fieldset{border:1px solid #8888;border-radius:5px;padding:1rem}fieldset p{margin:.6em 0}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin:.8rem 0}.actions form{margin:0}
output{display:block;margin:.7rem 0}.error{color:light-dark(#9c2525,#ffa59d)}
output[data-state="success"]{color:light-dark(#196233,#9de8aa)}output[data-state="error"]{color:light-dark(#9c2525,#ffa59d)}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
"""

test_script = """
document.addEventListener('input', event => {
  const out = event.target.form?.querySelector('output');
  if (!out) return;
  out.textContent = ''; out.dataset.state = ''; out.dataset.request = '';
});
document.addEventListener('submit', async event => {
  if (!event.submitter || event.submitter.name !== 'testConnection') return;
  event.preventDefault();
  const button = event.submitter, out = event.target.querySelector('output');
  const request = String(performance.now());
  out.dataset.request = request;
  button.disabled = true; out.dataset.state = 'pending'; out.textContent = 'Testing connection…';
  try {
    const res = await fetch(button.formAction, {method:'POST', headers:{Accept:'application/json'},
      body:new URLSearchParams(new FormData(event.target))});
    const value = await res.json();
    if (out.dataset.request !== request) return;
    out.dataset.state = res.ok ? 'success' : 'error';
    out.textContent = res.ok ? '✓ Connection successful.' : '✕ ' + value.error;
  } catch {
    if (out.dataset.request === request) {
      out.dataset.state = 'error'; out.textContent = '✕ Could not reach the extension host.';
    }
  } finally { button.disabled = false; }
});
"""


def field(name, value):
    return f'<input type="hidden" name="{escape(name, quote=True)}" value="{escape(value, quote=True)}">'


def form(action, body):
    return f'<form action="/extensions/{action}" method="post">{field("_csrf", csrf)}{body}</form>'


def button_form(action, label):
    return form(action, f'<button>{escape(label)}</button>')


def input_html(item, value="", prefix=""):
    key = item["key"]
    html_id = escape(prefix + key, quote=True)
    kind = {"url": "url", "secret": "password"}.get(item["type"], "text")
    required = "required" if item.get("required") and not (kind == "password" and value is None) else ""
    help_text = item.get("help", "")
    help_id = f'aria-describedby="{html_id}-help"' if help_text else ""
    return (
        f'<label for="{html_id}">{escape(item["label"])}</label>'
        f'<input type="{kind}" id="{html_id}" name="{escape(key, quote=True)}" value="{escape(value or "", quote=True)}" '
        f'placeholder="{escape(item.get("placeholder", ""), quote=True)}" autocomplete="off" {help_id} {required}>'
        + (f'<small id="{html_id}-help">{escape(help_text)}</small>' if help_text else "")
    )


def setup(state, manifest):
    saved = manager.settings(state["key"])
    inputs = [field("key", state["key"])]
    for item in manifest["settings"]:
        key = item["key"]
        secret = item["type"] == "secret"
        inputs.append(input_html(item, None if secret and saved.get(key) else saved.get(key, "")))
        if secret and saved.get(key):
            inputs.append('<small>Leave blank to reuse the saved value for the same address.</small>'
                          f'<label><input type="checkbox" name="clear:{escape(key, quote=True)}"> Clear saved {escape(item["label"])}</label>')
    test = '<button name="testConnection" formaction="/extensions/test">Test connection</button>' if manifest.get("connectionTest") else ''
    help_text = manifest.get("setupHelp", "")
    credential_help = manifest.get("credentialHelp", "")
    return form("configure", f'<fieldset><legend>Configure {escape(manifest["name"])}</legend>' +
                (f'<p>{escape(help_text)}</p>' if isinstance(help_text, str) and help_text else '') + ''.join(inputs) +
                (f'<small>{escape(credential_help)}</small>' if isinstance(credential_help, str) and credential_help else '') +
                '<div class="actions">' + test + '<button>Save and enable</button>'
                '<a href="/extensions/">Cancel</a></div><output aria-live="polite"></output></fieldset>')


def result_html(result, action):
    entries = []
    labels = action.get("resultLabels", {})
    for key, value in result.items():
        fallback = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", key).capitalize()
        label = labels.get(key, fallback) if isinstance(labels, dict) else fallback
        if isinstance(value, list):
            text = ", ".join(str(v) for v in value) or "None"
        elif value is None:
            text = "Not specified"
        else:
            text = str(value)
        entries.append(f"<dt>{escape(str(label))}</dt><dd>{escape(text)}</dd>")
    return '<h3>Result</h3><dl>' + ''.join(entries) + '</dl>'


def page(content):
    return (f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>Extensions · Tunarr</title><style>{style}</style><main><h1>Extensions</h1>{content}</main>'
            f'<script>{test_script}</script></html>').encode()


def browse_sources(installed, expanded):
    listings = []
    controls = []
    notices = []
    for source in manager.sources():
        url = source["url"]
        source_name = escape(url.removeprefix("https://github.com/"))
        source_field = field("source", url)
        enabled = source["enabled"]
        buttons = form("source-disable" if enabled else "source-enable", source_field +
                       ("<button>Disable source</button>" if enabled else "<button>Enable source</button>"))
        if enabled:
            buttons += form("source-refresh", source_field + "<button>Refresh</button>")
        controls.append(f'<p>{source_name} · {"Enabled" if enabled else "Disabled"}</p><div class="actions">{buttons}</div>')
        if enabled and source.get("error"):
            notices.append(f'<p role="alert">Could not refresh {source_name}. {escape(source["error"])} Use Manage sources to retry.</p>')
        if not enabled:
            continue
        for entry in source["entries"]:
            if any(s["repository"].lower() == entry["repository"].lower() and s["id"] == entry["id"] for s in installed.values()):
                continue
            action = "" if not manage else form("install", source_field + field("id", entry["id"]) +
                          field("commit", entry["commit"]) + field("repository", entry["repository"]) + "<button>Install</button>")
            listings.append(f'<section><h3>{escape(entry["name"])}</h3><p>{escape(entry["description"])}</p>'
                            f'<small>Version {escape(entry["version"])} · {escape(entry["repository"])}</small>'
                            f'<small>Source: {source_name}</small>{action}</section>')
    add = form("source-add", '<label for="source">Source repository URL</label>'
               '<input type="url" id="source" name="source" required aria-describedby="source-help">'
               '<small id="source-help">Adding a source lists extensions from its public source-v2.json. Review the publisher before installing.</small>'
               '<p><button>Add and enable source</button></p>')
    available = "<h2>Available extensions</h2>" + "".join(listings) if listings else ""
    if not listings and not installed:
        available = "<p>No extensions available from enabled sources.</p>"
    if not manage:
        return "".join(notices) + available
    details = '<details open>' if expanded else '<details>'
    return ("".join(notices) + available + details + '<summary>Manage sources</summary>' +
            ''.join(controls) + add + '</details>')


def installed_card(state, result):
    key = state["key"]
    manifest = manager.installed_manifest(state)
    status = "Enabled" if state["enabled"] else "Disabled"
    content = f'<section><h3>{escape(manifest["name"])}</h3><small>{escape(state["repository"])}</small><p>Version {escape(state["version"])} · {status}</p>'
    ident = field("key", key)
    controls = []
    if manifest["settings"] or manifest.get("connectionTest"):
        query = urlencode({"key": key})
        controls.append(f'<a href="/extensions/setup?{query}">Configure</a>')
    if state["enabled"]:
        controls.append(form("disable", ident + '<button>Disable</button>'))
    elif state["configured"]:
        controls.append(form("enable", ident + '<button>Enable</button>'))
    controls.append(form("check-update", ident + '<button>Check for update</button>'))
    if candidate := state.get("update"):
        controls.append(form("update", ident + field("commit", candidate["commit"]) + f'<button>Update to {escape(candidate["version"])}</button>'))
    content += '<div class="actions">' + ''.join(controls) + '</div>'
    if state["enabled"]:
        for action in manifest.get("actions", []):
            inputs = ''.join(input_html(item, prefix=f'{key}-{action["id"]}-') for item in action.get("inputs", []))
            content += form("action", ident + field("action", action["id"]) + inputs +
                            f'<p><button>{escape(action["label"])}</button></p>')
            if result and result[0:2] == (key, action["id"]):
                content += result_html(result[2], action)
    return content + '</section>'


def home(view="", key="", message="", result=None):
    if view == "setup":
        state = manager.state(key)
        return page(setup(state, manager.installed_manifest(state)))
    if not manage:
        return page('<p>To install or run extensions, enable Tunarr Basic Auth or set '
                    '<code>TUNARR_EXTENSION_TRUSTED_LAN=true</code> for a trusted network.</p>' +
                    browse_sources({}, False))
    installed = manager.installed()
    content = f'<p role="status">{escape(message)}</p>' if message else ""
    if installed:
        content += "<h2>Installed</h2>" + ''.join(installed_card(state, result) for state in installed.values())
    return page(content + browse_sources(installed, view == "sources"))


class Handler(BaseHTTPRequestHandler):
    def log_request(self, code="-", size="-"):
        pass  # Keep operator-supplied settings and program IDs out of request logs.

    def send_body(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, obj):
        self.send_body(status, json.dumps(obj).encode(), "application/json")

    def error_response(self, status, message):
        if self.headers.get("Accept") == "application/json":
            self.send_json(status, {"error": message})
        else:
            self.send_body(status, page(f'<p class="error" role="alert">{escape(message)}</p><a href="/extensions/">Return to Extensions</a>'), "text/html; charset=utf-8")

    def check_host(self):
        host = urlsplit("//" + self.headers.get("Host", ""))
        if host.hostname != "localhost" or host.username is not None or host.path:
            raise Problem(403, "Unrecognized administration host.")

    def do_GET(self):
        try:
            self.check_host()
            route = urlsplit(self.path).path
            if route == "/extensions/health":
                self.send_json(200, {"status": "ok"})
            elif route == "/extensions/state":
                self.send_json(200, {"installed": list(manager.installed().values())})
            elif route in ("/extensions", "/extensions/", "/extensions/setup"):
                key = parse_qs(urlsplit(self.path).query).get("key", [""])[0]
                with lock:
                    body = home("setup" if route.endswith("/setup") else "", key)
                self.send_body(200, body, "text/html; charset=utf-8")
            else:
                self.error_response(404, "Unknown extension endpoint.")
        except Problem as exc:
            self.error_response(exc.status, str(exc))
        except (ValueError, OSError):
            self.error_response(500, "Could not load extension state.")

    def do_POST(self):
        try:
            self.check_host()
            host = self.headers["Host"]
            if self.headers.get("Origin") not in (f"http://{host}", f"https://{host}"):
                raise Problem(403, "Open the extension manager on this host to continue.")
            if self.headers.get_content_type() != "application/x-www-form-urlencoded":
                raise Problem(415, "Use the extension setup form.")
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 8192:
                raise Problem(413, "Invalid form size.")
            values = {k: v[0] for k, v in parse_qs(self.rfile.read(size).decode(), keep_blank_values=True, max_num_fields=100).items()}
            if not secrets.compare_digest(values.get("_csrf", ""), csrf):
                raise Problem(403, "Reopen the extension manager and retry.")
            mode = ""
            result = None
            key = values.get("key", "")
            route = self.path
            with lock:
                if route in ("/extensions/source-add", "/extensions/source-enable", "/extensions/source-disable"):
                    response = manager.set_source(values.get("source", ""), route != "/extensions/source-disable")
                    mode = "sources"
                elif route == "/extensions/source-refresh":
                    response = manager.refresh_source(values.get("source", ""))
                    mode = "sources"
                elif route == "/extensions/install":
                    response = manager.install(values.get("source", ""), values.get("id", ""),
                                               values.get("commit", ""), values.get("repository", ""))
                    key = response["key"]
                    if not response["enabled"]:
                        mode = "setup"
                elif route == "/extensions/check-update":
                    response = manager.check_update(key)
                elif route == "/extensions/update":
                    response = manager.update(key, values.get("commit", ""))
                elif route in ("/extensions/enable", "/extensions/disable"):
                    response = manager.toggle(key, route.endswith("/enable"))
                elif route in ("/extensions/configure", "/extensions/test"):
                    response = manager.configure(key, values, route.endswith("/configure"))
                    if route.endswith("/test"):
                        mode = "setup"
                elif route == "/extensions/action":
                    action_id = values.get("action", "")
                    response = manager.run_action(key, action_id, values)
                    result = (key, action_id, response["result"])
                else:
                    raise Problem(404, "Unknown extension endpoint.")
                if self.headers.get("Accept") == "application/json":
                    self.send_json(200, response)
                else:
                    message = "Connection successful." if route.endswith("/test") else ""
                    if route.endswith("/check-update") and not response.get("update"):
                        message = "Your installed version is current."
                    self.send_body(200, home(mode, key, message, result), "text/html; charset=utf-8")
        except Problem as exc:
            self.error_response(exc.status, str(exc))
        except (ValueError, OSError):
            self.error_response(400, "Could not process the extension request.")


if __name__ == "__main__":
    os.umask(0o077)
    with ThreadingUnixStreamServer(os.environ["EXT_SOCKET"], Handler) as server:
        # The parent's pipe also closes if Tunarr is killed without a graceful shutdown.
        def stop_with_parent():
            sys.stdin.buffer.read()
            server.shutdown()
        threading.Thread(target=stop_with_parent, daemon=True).start()
        print("ready", flush=True)
        server.serve_forever()

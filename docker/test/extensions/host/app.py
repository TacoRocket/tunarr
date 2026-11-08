import json
import os
import re
import secrets
import threading
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from manager import Manager, Problem


manager = Manager()
lock = threading.Lock()
csrf = secrets.token_urlsafe(32)
allowed_hosts = {item.strip().lower() for item in os.environ.get("EXT_ALLOWED_HOSTS", "localhost,127.0.0.1,::1").split(",")}
style = """
:root{font:16px/1.5 system-ui,sans-serif;color-scheme:light dark}
body{margin:0 auto;padding:1.5rem;max-width:44rem}h1{font-size:1.65rem}h2{font-size:1.25rem;margin-bottom:.3em}
form,section{margin:1.2rem 0}label{display:block;margin-top:.7rem;font-weight:600}
input:not([type=checkbox]){width:100%;box-sizing:border-box;padding:.55rem;font:inherit}
button{cursor:pointer;padding:.4rem .85rem;font:inherit}small{display:block}
fieldset{border:1px solid #8888;border-radius:5px;padding:1rem}fieldset p{margin:.6em 0}
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


def setup(manifest):
    saved = manager.settings()
    inputs = []
    for item in manifest["settings"]:
        key = item["key"]
        secret = item["type"] == "secret"
        value = "" if secret else saved.get(key, "")
        kind = "password" if secret else "url"
        hint = item.get("help", "")
        inp = (
            f'<label for="{key}">{escape(item["label"])}</label>'
            f'<input type="{kind}" id="{key}" name="{key}" value="{escape(value, quote=True)}" '
            f'placeholder="{escape(item.get("placeholder", ""), quote=True)}" '
            f'aria-describedby="{key}-help" autocomplete="off" {"required" if item.get("required") else ""}>'
            f'<small id="{key}-help">{escape(hint)}</small>'
        )
        if secret and saved.get(key):
            inp += ('<small>A key is saved. Leave the field blank to reuse it for the same URL.</small>'
                    '<label><input type="checkbox" name="clearSecret"> Clear the saved key</label>')
        inputs.append(inp)
    return form("configure", '<fieldset><legend>Configure '+escape(manifest["name"])+'</legend><p>Bazarr must already be running. Enter its reachable address, for example http://192.168.1.20:6767, including any configured base path.</p>'+''.join(inputs)+
                '<div class="actions"><button name="testConnection" formaction="/extensions/test">Test connection</button>'
                '<button>Save and enable</button><a href="/extensions/">Cancel</a></div><output aria-live="polite"></output></fieldset>')


def result_html(data):
    entries = []
    for key, value in data["result"].items():
        label = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", key).capitalize()
        if isinstance(value, list):
            text = ", ".join(str(v) for v in value) or "None"
        elif value is None:
            text = "Not specified"
        else:
            text = str(value)
        entries.append(f"<dt>{escape(label)}</dt><dd>{escape(text)}</dd>")
    return "<h2>Subtitle check</h2><dl>" + "".join(entries) + "</dl>"


def page(content):
    return (f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>Extensions · Tunarr trial</title><style>{style}</style><main><h1>Extensions</h1>{content}</main>'
            f'<script>{test_script}</script></html>').encode()


def home(view="", manifest=None, message="", result=None):
    state = manager.state()
    content = f'<p role="status">{escape(message)}</p>' if message else ""
    if not state["installed"]:
        content += form("discover", '<label for="repo">GitHub repository URL</label><input type="url" id="repo" name="repo" required '
                        f'placeholder="{escape(manager.url, quote=True)}"><p><button>Find extension</button></p>')
        if manifest:
            content += '<section><h2>'+escape(manifest["name"])+'</h2><p>'+escape(str(manifest.get("description", "")))+'</p>'
            content += '<p>Version '+escape(manifest["version"])+'</p>'+form("install", field("repo", manager.url)+'<button>Install</button>')+'</section>'
        return page(content)
    manifest = manager.installed_manifest(state)
    configured = bool(manager.settings())
    status = "Enabled" if state["enabled"] else ("Disabled" if configured else "Setup required")
    content += f'<h2>{escape(manifest["name"])}</h2><p>Version {escape(state["version"])} · {status}</p>'
    if view == "setup":
        return page(content + setup(manifest))
    content += '<div class="actions"><a href="/extensions/setup">Configure</a>'
    if state["enabled"]:
        content += button_form("disable", "Disable")
    elif configured:
        content += button_form("enable", "Enable")
    content += button_form("check-update", "Check for update")
    if candidate := state.get("update"):
        content += form("update", field("commit", candidate["commit"]) + f'<button>Update to {escape(candidate["version"])}</button>')
    content += '</div>'
    if state["enabled"]:
        content += form("lookup", '<label for="program">Tunarr movie program ID</label><input required id="program" name="programId">'
                        '<p><button>Check subtitles</button></p>')
    if result:
        content += result_html(result)
    return page(content)


class Handler(BaseHTTPRequestHandler):
    def log_request(self, code="-", size="-"):
        pass  # The trial has no request log containing user-supplied settings or IDs.

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
        if host.hostname not in allowed_hosts or host.username is not None or host.path:
            raise Problem(403, "Unrecognized administration host.")

    def do_GET(self):
        try:
            self.check_host()
            route = urlsplit(self.path).path
            if route == "/extensions/health":
                self.send_json(200, {"status": "ok"})
            elif route == "/extensions/state":
                self.send_json(200, {**manager.state(), "configured": bool(manager.settings()), "repository": manager.url})
            elif route in ("/extensions", "/extensions/", "/extensions/setup"):
                self.send_body(200, home("setup" if route.endswith("/setup") else ""), "text/html; charset=utf-8")
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
            values = {k: v[0] for k, v in parse_qs(self.rfile.read(size).decode(), keep_blank_values=True, max_num_fields=12).items()}
            if not secrets.compare_digest(values.get("_csrf", ""), csrf):
                raise Problem(403, "Reopen the extension manager and retry.")
            mode = ""
            manifest = None
            lookup = None
            route = self.path
            with lock:
                if route == "/extensions/discover":
                    manifest = manager.discover(values.get("repo", ""))
                    response = manifest
                elif route == "/extensions/install":
                    response = manager.install(values.get("repo", ""))
                    mode = "setup"
                elif route == "/extensions/check-update":
                    response = manager.check_update()
                elif route == "/extensions/update":
                    response = manager.update(values.get("commit", ""))
                elif route in ("/extensions/enable", "/extensions/disable"):
                    response = manager.toggle(route.endswith("/enable"))
                elif route in ("/extensions/configure", "/extensions/test"):
                    response = manager.configure(values, route.endswith("/configure"))
                    if route.endswith("/test"):
                        mode = "setup"
                elif route == "/extensions/lookup":
                    lookup = response = manager.lookup(values.get("programId", ""))
                else:
                    raise Problem(404, "Unknown extension endpoint.")
                if self.headers.get("Accept") == "application/json":
                    self.send_json(200, response)
                else:
                    message = "Connection successful." if route.endswith("/test") else ""
                    if route.endswith("/check-update") and not response.get("update"):
                        message = "Your installed version is current."
                    self.send_body(200, home(mode, manifest, message, lookup), "text/html; charset=utf-8")
        except Problem as exc:
            self.error_response(exc.status, str(exc))
        except (ValueError, OSError):
            self.error_response(400, "Could not process the extension request.")


if __name__ == "__main__":
    server = ThreadingHTTPServer((os.environ.get("BIND_ADDR", "0.0.0.0"), int(os.environ.get("PORT", "8090"))), Handler)
    server.serve_forever()

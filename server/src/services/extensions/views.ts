import { escape } from 'lodash-es';
import type {
  Action,
  Field,
  Installation,
  Manifest,
  Settings,
  Source,
} from './schema.ts';
import type { ExtensionStore } from './store.ts';

const style = `
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
`;
const connectionScript = `
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
`;

export function page(content: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Extensions · Tunarr</title><style>${style}</style><main><h1>Extensions</h1>${content}</main><script>${connectionScript}</script></html>`;
}

function field(name: string, value: string) {
  return `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
}

function input(item: Field, value: string | null = '', prefix = '') {
  const id = escape(prefix + item.key);
  const kind =
    item.type === 'url' ? 'url' : item.type === 'secret' ? 'password' : 'text';
  const required = item.required && value !== null ? 'required' : '';
  return (
    `<label for="${id}">${escape(item.label)}</label><input type="${kind}" id="${id}" name="${escape(item.key)}" value="${escape(value ?? '')}" placeholder="${escape(item.placeholder ?? '')}" autocomplete="off" ${required} ${item.help ? `aria-describedby="${id}-help"` : ''}>` +
    (item.help ? `<small id="${id}-help">${escape(item.help)}</small>` : '')
  );
}

export interface ActionResult {
  key: string;
  action: string;
  data: Record<string, unknown>;
}
export interface View {
  mode?: 'setup' | 'sources';
  key?: string;
  message?: string;
  result?: ActionResult;
}

export class StorePage {
  constructor(
    private store: ExtensionStore,
    private manage: boolean,
    private token: string,
  ) {}
  private form(action: string, body: string) {
    return `<form action="/extensions/${action}" method="post">${field('_csrf', this.token)}${body}</form>`;
  }
  private button(action: string, label: string, fields: Settings) {
    return this.form(
      action,
      Object.entries(fields)
        .map(([k, v]) => field(k, v))
        .join('') + `<button>${escape(label)}</button>`,
    );
  }
  private setup(state: Installation, manifest: Manifest, saved: Settings) {
    const fields = manifest.settings
      .map((f) => {
        const hasSecret = f.type === 'secret' && Boolean(saved[f.key]);
        return (
          input(f, hasSecret ? null : (saved[f.key] ?? '')) +
          (hasSecret
            ? `<small>Leave blank to reuse the saved value for the same address.</small><label><input type="checkbox" name="clear:${escape(f.key)}"> Clear saved ${escape(f.label)}</label>`
            : '')
        );
      })
      .join('');
    return this.form(
      'configure',
      field('key', state.key) +
        `<fieldset><legend>Configure ${escape(manifest.name)}</legend>` +
        (manifest.setupHelp ? `<p>${escape(manifest.setupHelp)}</p>` : '') +
        fields +
        (manifest.credentialHelp
          ? `<small>${escape(manifest.credentialHelp)}</small>`
          : '') +
        '<div class="actions">' +
        (manifest.connectionTest
          ? '<button name="testConnection" formaction="/extensions/test">Test connection</button>'
          : '') +
        '<button>Save and enable</button><a href="/extensions/">Cancel</a></div><output aria-live="polite"></output></fieldset>',
    );
  }
  private browse(
    sources: Source[],
    installed: Installation[],
    expanded: boolean,
  ) {
    const listings: string[] = [],
      controls: string[] = [],
      notices: string[] = [];
    for (const s of sources) {
      const name = escape(s.url.slice('https://github.com/'.length));
      if (this.manage) {
        const fields = { source: s.url };
        controls.push(
          `<p>${name} · ${s.enabled ? 'Enabled' : 'Disabled'}</p><div class="actions">` +
            this.button(
              s.enabled ? 'source-disable' : 'source-enable',
              s.enabled ? 'Disable source' : 'Enable source',
              fields,
            ) +
            (s.enabled
              ? this.button('source-refresh', 'Refresh', fields)
              : '') +
            '</div>',
        );
      }
      if (!s.enabled) continue;
      if (s.error)
        notices.push(
          `<p role="alert">Could not refresh ${name}. ${escape(s.error)} Use Manage sources to retry.</p>`,
        );
      for (const e of s.entries) {
        if (
          installed.some(
            (i) =>
              i.repository.toLowerCase() === e.repository.toLowerCase() &&
              i.id === e.id,
          )
        )
          continue;
        listings.push(
          `<section><h3>${escape(e.name)}</h3><p>${escape(e.description)}</p><small>Version ${escape(e.version)} · ${escape(e.repository)}</small><small>Source: ${name}</small>` +
            (this.manage
              ? this.button('install', 'Install', {
                  source: s.url,
                  id: e.id,
                  commit: e.commit,
                  repository: e.repository,
                })
              : '') +
            '</section>',
        );
      }
    }
    const available = listings.length
      ? '<h2>Available extensions</h2>' + listings.join('')
      : installed.length
        ? ''
        : '<p>No extensions available from enabled sources.</p>';
    const add = this.form(
      'source-add',
      '<label for="source">Source repository URL</label><input type="url" id="source" name="source" required aria-describedby="source-help"><small id="source-help">Adding a source lists extensions from its public source-v2.json. Review the publisher before installing.</small><p><button>Add and enable source</button></p>',
    );
    return (
      notices.join('') +
      available +
      (this.manage
        ? `<details${expanded ? ' open' : ''}><summary>Manage sources</summary>${controls.join('')}${add}</details>`
        : '')
    );
  }
  private async card(state: Installation, result?: ActionResult) {
    const m = await this.store.manifest(state);
    const ident = { key: state.key },
      controls: string[] = [];
    if (m.settings.length || m.connectionTest)
      controls.push(
        `<a href="/extensions/setup?${new URLSearchParams(ident).toString()}">Configure</a>`,
      );
    if (state.enabled) controls.push(this.button('disable', 'Disable', ident));
    else if (state.configured)
      controls.push(this.button('enable', 'Enable', ident));
    controls.push(this.button('check-update', 'Check for update', ident));
    if (state.update)
      controls.push(
        this.button('update', 'Update to ' + state.update.version, {
          ...ident,
          commit: state.update.commit,
        }),
      );
    const actions = state.enabled
      ? m.actions
          .map((action) => {
            const inputs = action.inputs
              .map((i) => input(i, '', state.key + '-' + action.id + '-'))
              .join('');
            return (
              this.form(
                'action',
                field('key', state.key) +
                  field('action', action.id) +
                  inputs +
                  `<p><button>${escape(action.label)}</button></p>`,
              ) +
              (result?.key === state.key && result.action === action.id
                ? renderResult(action, result.data)
                : '')
            );
          })
          .join('')
      : '';
    return `<section><h3>${escape(m.name)}</h3><small>${escape(state.repository)}</small><p>Version ${escape(state.version)} · ${state.enabled ? 'Enabled' : 'Disabled'}</p><div class="actions">${controls.join('')}</div>${actions}</section>`;
  }
  async render(view: View = {}) {
    if (view.mode === 'setup') {
      const state = await this.store.state(view.key ?? '');
      return page(
        this.setup(
          state,
          await this.store.manifest(state),
          await this.store.settings(state),
        ),
      );
    }
    const sources = await this.store.sources();
    if (!this.manage)
      return page(
        '<p>To install or run extensions, enable Tunarr Basic Auth or set <code>TUNARR_EXTENSION_TRUSTED_LAN=true</code> for a trusted network.</p>' +
          this.browse(sources, [], false),
      );
    const installed = await this.store.installed(),
      cards = await Promise.all(
        installed.map((s) => this.card(s, view.result)),
      );
    return page(
      (view.message ? `<p role="status">${escape(view.message)}</p>` : '') +
        (cards.length ? '<h2>Installed</h2>' + cards.join('') : '') +
        this.browse(sources, installed, view.mode === 'sources'),
    );
  }
}

function renderResult(action: Action, result: Record<string, unknown>) {
  const entries = Object.entries(result)
    .map(([key, value]) => {
      const fallback = key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, (s) => s.toUpperCase());
      const label = action.resultLabels?.[key] ?? fallback;
      const display = (v: unknown) =>
        typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
      const text = Array.isArray(value)
        ? value.map(display).join(', ') || 'None'
        : value === null
          ? 'Not specified'
          : display(value);
      return `<dt>${escape(label)}</dt><dd>${escape(text)}</dd>`;
    })
    .join('');
  return '<h3>Result</h3><dl>' + entries + '</dl>';
}

export function errorPage(message: string) {
  return page(
    `<p class="error" role="alert">${escape(message)}</p><a href="/extensions/">Return to Extensions</a>`,
  );
}

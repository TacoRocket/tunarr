import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import type { Manifest, Settings } from './schema.ts';

// What a saved manifest says about its settings, read without requiring this
// Tunarr to be able to run it: each field's type, and which address settings
// each secret is sent to (`requests`, or `reads` in packages built for API v2).
const route = z.object({
  baseUrlSetting: z.string(),
  credential: z.object({ setting: z.string() }).optional(),
});
const savedShape = z.object({
  settings: z.array(z.object({ key: z.string(), type: z.string() })).catch([]),
  requests: z.array(route).catch([]),
  reads: z.array(route).catch([]),
});

function destinations(
  routes: { baseUrlSetting: string; credential?: { setting: string } }[],
) {
  const sent = new Map<string, string[]>();
  for (const r of routes) {
    if (!r.credential) continue;
    const list = sent.get(r.credential.setting) ?? [];
    if (!list.includes(r.baseUrlSetting)) list.push(r.baseUrlSetting);
    sent.set(r.credential.setting, list.sort());
  }
  return sent;
}

/**
 * Settings an update keeps. A value carries over when the previous and new
 * manifests give its key the same type. A secret also needs the same
 * destination address settings, and each of those must carry over too, so a
 * saved key is only ever sent to the address it was saved for. When the
 * previous manifest can't be read at all, nothing carries over.
 */
export function carriedSettings(
  previousManifest: unknown,
  manifest: Manifest,
  saved: Settings,
): Settings {
  const shape = savedShape.safeParse(previousManifest);
  if (!shape.success) return {};
  const oldTypes = new Map(shape.data.settings.map((f) => [f.key, f.type]));
  const oldSent = destinations([...shape.data.requests, ...shape.data.reads]);
  const newSent = destinations(manifest.requests);
  const sameType = (key: string, type: string) =>
    oldTypes.get(key) === type && Object.hasOwn(saved, key);
  const newTypes = new Map(manifest.settings.map((f) => [f.key, f.type]));

  const retained: Settings = {};
  for (const field of manifest.settings) {
    if (!sameType(field.key, field.type)) continue;
    if (field.type === 'secret') {
      const to = newSent.get(field.key) ?? [];
      if (
        !isDeepStrictEqual(to, oldSent.get(field.key) ?? []) ||
        !to.every((url) => newTypes.get(url) === 'url' && sameType(url, 'url'))
      )
        continue;
    }
    retained[field.key] = saved[field.key]!;
  }
  return retained;
}

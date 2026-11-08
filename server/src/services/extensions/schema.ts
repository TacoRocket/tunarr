import { z } from 'zod/v4';
import {
  currentExtensionApi,
  extensionApiCompatibility,
  isExtensionApiVersion,
} from './version.ts';

export class ExtensionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const repoPattern = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9_.-]{0,99}$/i;
export function sourceUrl(value: string) {
  const match = /^https:\/\/github\.com\/(.+?)\/?$/i.exec(value.trim());
  if (!match?.[1] || !repoPattern.test(match[1])) {
    throw new ExtensionError(400, 'Enter a public GitHub repository URL.');
  }
  return 'https://github.com/' + match[1];
}

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
// Query keys may use the array form some services expect, e.g. `radarrid[]`.
const queryKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}(\[\])?$/);
const extensionId = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const version = z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/);
export const releaseSchema = z.object({ version, commit });
export type Release = z.infer<typeof releaseSchema>;
const listing = releaseSchema.extend({
  id: extensionId,
  name: z.string().min(1),
  description: z.string(),
  repository: z.string().regex(repoPattern),
});
export const sourceDocument = z.object({
  schemaVersion: z.literal(1),
  extensions: listing
    .array()
    .refine((entries) => unique(entries.map((e) => e.id))),
});
const savedSource = z.object({
  url: z.string(),
  enabled: z.boolean(),
  entries: listing.array(),
  error: z.string().optional(),
});
export const savedSources = z.object({
  // Which listing file the entries came from (e.g. "v0"). Listings saved for
  // another API major are refreshed before use.
  listing: z.string().optional(),
  sources: savedSource.array(),
});
export type Source = z.infer<typeof savedSource>;

export const stateSchema = releaseSchema.extend({
  id: extensionId,
  key: z.string(),
  source: z.string(),
  repository: z.string().regex(repoPattern),
  installed: z.literal(true),
  enabled: z.boolean(),
  configured: z.boolean(),
  update: releaseSchema.nullish(),
  settingsFile: z
    .string()
    .regex(/^settings-[a-f0-9]{40}\.json$/)
    .optional(),
});
export type Installation = z.infer<typeof stateSchema>;
export const settingsSchema = z.record(z.string(), z.string());
export type Settings = z.infer<typeof settingsSchema>;

const commonField = z.object({
  key: id,
  label: z.string(),
  help: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
});
const settingField = commonField.extend({
  type: z.enum(['url', 'secret', 'text']),
});
const inputField = commonField.extend({
  type: z.enum(['text', 'tunarrProgram']),
});
export type Field = z.infer<typeof settingField> | z.infer<typeof inputField>;
const action = z.object({
  id,
  label: z.string(),
  inputs: inputField.array().default([]),
  resultLabels: settingsSchema.optional(),
});
export type Action = z.infer<typeof action>;

const serviceRequest = z
  .strictObject({
    id,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH']).default('GET'),
    baseUrlSetting: id,
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine((p) =>
        p
          .split('/')
          .every(
            (s) => /^[A-Za-z0-9._~-]+$/.test(s) && s !== '.' && s !== '..',
          ),
      ),
    credential: z
      .strictObject({
        setting: id,
        header: z
          .string()
          .refine((h) =>
            ['authorization', 'x-api-key', 'api-key'].includes(h.toLowerCase()),
          ),
      })
      .optional(),
    query: queryKey.array().max(16).refine(unique).default([]),
    // Top-level keys of a JSON request body. GET requests have no body.
    body: id.array().max(16).refine(unique).default([]),
  })
  .refine((r) => r.method !== 'GET' || r.body.length === 0);
export type RequestDeclaration = z.infer<typeof serviceRequest>;

function unique(values: string[]) {
  return new Set(values).size === values.length;
}
const reserved = [
  'key',
  '_csrf',
  'action',
  'commit',
  'clearSecret',
  'connectionTest',
  'testConnection',
];
export const manifestSchema = z
  .object({
    id: extensionId,
    version,
    // major.minor of the extension API the package was built for.
    apiVersion: z
      .string()
      .refine(
        (v) =>
          isExtensionApiVersion(v) &&
          extensionApiCompatibility(v) === 'supported',
      ),
    entrypoint: z.literal('adapter.js'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    name: z.string(),
    description: z.string().default(''),
    // Who maintains the extension and where its problems are reported.
    maintainer: z.string().trim().min(1).max(100),
    issueTracker: z
      .string()
      .max(500)
      .refine((value) => URL.parse(value)?.protocol === 'https:'),
    connectionTest: z.boolean().default(false),
    setupHelp: z.string().optional(),
    credentialHelp: z.string().optional(),
    settings: settingField.array().default([]),
    actions: action.array().min(1),
    requests: serviceRequest.array().max(32).default([]),
  })
  .refine((m) => {
    const fieldTypes = new Map(m.settings.map((f) => [f.key, f.type]));
    const used = [...reserved, ...m.settings.map((f) => f.key)];
    return (
      unique(used) &&
      unique(['test', ...m.actions.map((a) => a.id)]) &&
      m.actions.every((a) =>
        unique([...used, ...a.inputs.map((f) => f.key)]),
      ) &&
      unique(m.requests.map((r) => r.id)) &&
      m.requests.every(
        (r) =>
          fieldTypes.get(r.baseUrlSetting) === 'url' &&
          (!r.credential || fieldTypes.get(r.credential.setting) === 'secret'),
      )
    );
  });
export type Manifest = z.infer<typeof manifestSchema>;
export const feedSchema = z.object({ id: extensionId, latest: releaseSchema });

/**
 * Refuses a manifest written for an extension API this Tunarr doesn't run,
 * before the full parse, so the operator sees which version it needs.
 */
export function checkApiVersion(raw: unknown) {
  const declared = z
    .object({ apiVersion: z.union([z.string(), z.number()]) })
    .safeParse(raw);
  const wanted = declared.success
    ? String(declared.data.apiVersion)
    : undefined;
  if (!wanted) {
    throw new ExtensionError(
      422,
      "This extension doesn't say which extension API it needs.",
    );
  }
  switch (extensionApiCompatibility(wanted)) {
    case 'supported':
      return;
    case 'needs-newer-tunarr':
      throw new ExtensionError(
        422,
        `This extension needs extension API ${wanted}, and this Tunarr runs ${currentExtensionApi}. Update Tunarr to use it.`,
      );
    case 'other-major':
      throw new ExtensionError(
        422,
        `This extension was built for extension API ${wanted}, and this Tunarr runs ${currentExtensionApi}. Update the extension.`,
      );
  }
}

// What an action answers with: one plain sentence, an optional tone and
// optional labelled details.
const detailValue = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(500)).max(100),
]);
export const actionResultSchema = z.strictObject({
  message: z.string().trim().min(1).max(500),
  tone: z.enum(['success', 'info', 'warning', 'error']).optional(),
  details: z.record(z.string().max(64), detailValue).optional(),
});
export type ActionResult = z.infer<typeof actionResultSchema>;

export function checked<T>(
  schema: z.ZodType<T>,
  data: unknown,
  message: string,
) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ExtensionError(422, message);
  return parsed.data;
}

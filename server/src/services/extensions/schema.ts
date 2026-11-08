import { z } from 'zod/v4';

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
export const savedSources = z.object({ sources: savedSource.array() });
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
const read = z.strictObject({
  id,
  baseUrlSetting: id,
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine((p) =>
      p
        .split('/')
        .every((s) => /^[A-Za-z0-9._~-]+$/.test(s) && s !== '.' && s !== '..'),
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
  query: id.array().max(16).refine(unique).default([]),
});
export type ReadDeclaration = z.infer<typeof read>;
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
    apiVersion: z.literal(2),
    entrypoint: z.literal('adapter.js'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    name: z.string(),
    description: z.string().default(''),
    connectionTest: z.boolean().default(false),
    setupHelp: z.string().optional(),
    credentialHelp: z.string().optional(),
    settings: settingField.array().default([]),
    actions: action.array().min(1),
    reads: read.array().max(32).default([]),
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
      unique(m.reads.map((r) => r.id)) &&
      m.reads.every(
        (r) =>
          fieldTypes.get(r.baseUrlSetting) === 'url' &&
          (!r.credential || fieldTypes.get(r.credential.setting) === 'secret'),
      )
    );
  });
export type Manifest = z.infer<typeof manifestSchema>;
export const feedSchema = z.object({ id: extensionId, latest: releaseSchema });

export function checked<T>(
  schema: z.ZodType<T>,
  data: unknown,
  message: string,
) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ExtensionError(422, message);
  return parsed.data;
}

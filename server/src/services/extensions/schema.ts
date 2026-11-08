import { z } from 'zod/v4';
import { capabilityNames } from '../capabilities/contracts.ts';
import {
  currentExtensionApi,
  extensionApiCompatibility,
  isExtensionApiVersion,
} from './version.ts';

const maxComputeModuleBytes = 1024 * 1024;

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
// A folder inside a repository that holds one package, e.g. "packages/potion".
// Lets one repository publish several extensions.
const packagePath = z
  .string()
  .max(200)
  .refine((p) =>
    p
      .split('/')
      .every((s) => /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..'),
  );
const listing = releaseSchema.extend({
  id: extensionId,
  name: z.string().min(1),
  description: z.string(),
  repository: z.string().regex(repoPattern),
  path: packagePath.optional(),
});
export type Listing = z.infer<typeof listing>;

/** Where a package's files live in its repository. */
export function packageFile(path: string | undefined, name: string) {
  return path ? `${path}/${name}` : name;
}
export const sourceDocument = z.object({
  schemaVersion: z.literal(1),
  extensions: listing
    .array()
    .refine((entries) => unique(entries.map((e) => e.id))),
});
// What Settings shows about a listing before install, read from its manifest
// at the listed commit when the source is refreshed.
const listingPreview = z.object({
  maintainer: z.string().optional(),
  issueTracker: z.string().optional(),
  accessGuide: z
    .object({
      reads: z.string(),
      changes: z.string(),
      connectsTo: z.string(),
      downloads: z.string(),
    })
    .optional(),
  memoryMiB: z.number().optional(),
  storageMiB: z.number().optional(),
  downloadBytes: z.number().optional(),
  requests: z
    .array(z.object({ method: z.string(), setting: z.string() }))
    .default([]),
  provides: z.array(z.string()).default([]),
  // Why it can't be installed here, e.g. it needs a newer Tunarr.
  problem: z.string().optional(),
});
export type ListingPreview = z.infer<typeof listingPreview>;
const savedSource = z.object({
  url: z.string(),
  enabled: z.boolean(),
  entries: listing.array(),
  error: z.string().optional(),
  // Keyed by "repository:id" in lower case.
  previews: z.record(z.string(), listingPreview).default({}),
});
export const savedSources = z.object({
  // Which listing file the entries came from (e.g. "v0"). Listings saved for
  // another API major are refreshed before use.
  listing: z.string().optional(),
  sources: savedSource.array(),
  // Listings the operator chose not to see, as "repository:id".
  hidden: z.array(z.string()).default([]),
});
export type Source = z.infer<typeof savedSource>;

export const stateSchema = releaseSchema.extend({
  id: extensionId,
  key: z.string(),
  source: z.string(),
  repository: z.string().regex(repoPattern),
  path: packagePath.optional(),
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
  // Shown as a button on the extension's card. Optional; at most two.
  quick: z.boolean().default(false),
});

// The card template has room for this many quick actions.
export const maxQuickActions = 2;
// The action Tunarr runs itself when the Info tab opens.
export const statusActionId = 'status';
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
const guideLine = z.string().trim().min(1).max(300);
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
    // The publisher's plain-language summary, shown before install.
    accessGuide: z
      .strictObject({
        reads: guideLine,
        changes: guideLine,
        connectsTo: guideLine,
        downloads: guideLine,
      })
      .optional(),
    // Memory the package code may use, in MiB. Shown before install.
    memoryMiB: z.number().int().min(16).max(256).default(16),
    // Disk space for the extension's own data, in MiB. Shown before install.
    storageMiB: z.number().int().min(0).max(1024).default(1),
    // Data files shipped next to adapter.js, downloaded and hash-checked.
    files: z
      .array(
        z.strictObject({
          name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
          bytes: z
            .number()
            .int()
            .positive()
            .max(256 * 1024 * 1024),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .max(16)
      .default([])
      .refine((files) => unique(files.map((f) => f.name)))
      .refine(
        (files) =>
          files.reduce((sum, f) => sum + f.bytes, 0) <= 512 * 1024 * 1024,
      ),
    // Optional binary entrypoint from the verified package files.
    computeModule: z.string().endsWith('.wasm').optional(),
    // Capabilities this package implements (see capabilities/contracts.ts).
    // Tunarr consults it for them on its own, without a button.
    provides: z.array(z.enum(capabilityNames)).max(4).default([]),
    setupHelp: z.string().optional(),
    credentialHelp: z.string().optional(),
    settings: settingField.array().default([]),
    actions: action.array().min(1),
    requests: serviceRequest.array().max(32).default([]),
  })
  .refine(
    (m) =>
      !m.computeModule ||
      m.files.some(
        (f) => f.name === m.computeModule && f.bytes <= maxComputeModuleBytes,
      ),
    {
      message:
        'The compute module must be a declared .wasm file of at most 1 MiB.',
    },
  )
  .refine((m) => !m.computeModule || m.memoryMiB >= 32, {
    message:
      'Compute modules need at least 32 MiB shared between the two runtimes.',
  })
  .refine((m) => m.actions.filter((a) => a.quick).length <= maxQuickActions, {
    message: `A card has room for ${maxQuickActions} quick actions. Mark at most ${maxQuickActions} actions "quick"; the rest stay in the extension's details.`,
  })
  .refine(
    (m) =>
      m.actions.every(
        (a) => a.id !== statusActionId || (!a.quick && a.inputs.length === 0),
      ),
    {
      message:
        'The "status" action runs when the Info tab opens, so it can\'t be quick or ask for inputs.',
    },
  )
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
  if (!parsed.success) {
    // Rules written for publishers carry their own sentence: pass it on, so
    // they can see what to change.
    const rule = parsed.error.issues.find(
      (issue) => issue.code === 'custom' && issue.message !== 'Invalid input',
    )?.message;
    throw new ExtensionError(422, rule ? `${message} ${rule}` : message);
  }
  return parsed.data;
}

// What Tunarr hands a similarity provider, and what it answers.
export const similarityIndexResult = z.object({
  indexed: z.number().int().min(0),
});
export const similarityQueryResult = z.object({
  matches: z
    .array(z.object({ id: z.string().max(200), score: z.number() }))
    .max(1000),
});

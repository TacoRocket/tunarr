import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { ServicePayload } from './runtime.ts';
import {
  ExtensionError,
  type Manifest,
  type RequestDeclaration,
  type Settings,
} from './schema.ts';

const responseLimit = 4 * 1024 * 1024;
const requestTimeoutMs = 8_000;

// Never reachable: "this network", link-local (which includes the usual cloud
// metadata address), multicast, reserved ranges and known metadata endpoints.
const blockedV4 = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blockedV4.addSubnet(ip, prefix, 'ipv4');
for (const ip of ['100.100.100.200', '168.63.129.16'])
  blockedV4.addAddress(ip, 'ipv4');
const blockedV6 = new BlockList();
for (const ip of ['fd00:ec2::254', 'fd00:ec2::23'])
  blockedV6.addAddress(ip, 'ipv6');
blockedV6.addSubnet('2001::', 32, 'ipv6');
blockedV6.addSubnet('2002::', 16, 'ipv6');
// Global and unique-local IPv6. Everything else (e.g. link-local) is refused.
const unicastV6 = new BlockList();
unicastV6.addSubnet('2000::', 3, 'ipv6');
unicastV6.addSubnet('fc00::', 7, 'ipv6');
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

// ::ffff:7f00:1 and ::ffff:127.0.0.1 are both 127.0.0.1.
function mappedIpv4(address: string) {
  const lower = address.toLowerCase();
  if (!lower.startsWith('::ffff:')) return undefined;
  const rest = lower.slice('::ffff:'.length);
  if (isIP(rest) === 4) return rest;
  const groups = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!groups) return undefined;
  const high = parseInt(groups[1]!, 16);
  const low = parseInt(groups[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function ownAddresses() {
  const own = new BlockList();
  for (const iface of Object.values(networkInterfaces())) {
    for (const address of iface ?? []) {
      own.addAddress(
        address.address.split('%')[0]!,
        address.family === 'IPv6' ? 'ipv6' : 'ipv4',
      );
    }
  }
  return own;
}

/**
 * Whether an extension may connect to this address and port. Services on the
 * same machine are fine (Bazarr next to Tunarr is the common setup), except on
 * Tunarr's own ports, so a package can't read Tunarr's API through loopback.
 */
export function addressAllowed(
  address: string,
  family: number,
  port: number,
  own: BlockList,
  tunarrPorts: readonly number[],
): boolean {
  const mapped = family === 6 ? mappedIpv4(address) : undefined;
  if (mapped) return addressAllowed(mapped, 4, port, own, tunarrPorts);
  const type = family === 6 ? 'ipv6' : 'ipv4';
  const sameMachine = loopback.check(address, type) || own.check(address, type);
  if (family === 6) {
    if (!sameMachine && !unicastV6.check(address, 'ipv6')) return false;
    if (blockedV6.check(address, 'ipv6')) return false;
  } else if (blockedV4.check(address, 'ipv4')) {
    return false;
  }
  return !(sameMachine && tunarrPorts.includes(port));
}

type Scalar = string | number | boolean;
function isScalar(value: unknown): value is Scalar {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function plainObject(value: unknown, what: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ExtensionError(400, `The service request's ${what} is invalid.`);
  return value as Record<string, unknown>;
}

function serviceUrl(
  declaration: RequestDeclaration,
  settings: Settings,
  query: Record<string, unknown>,
  label: string,
) {
  const raw = settings[declaration.baseUrlSetting];
  const match = raw?.match(
    /^https?:\/\/(?:\[[\da-f:.]+\]|[\w.-]+)(?::\d+)?((?:\/[\w.~-]+)*\/?)$/i,
  );
  const invalid = new ExtensionError(
    400,
    `Enter a valid HTTP or HTTPS address in ${label}.`,
  );
  if (
    !raw ||
    raw.length > 2048 ||
    !match ||
    match[0] !== raw ||
    match[1]?.split('/').some((s) => s === '..' || s === '.')
  ) {
    throw invalid;
  }
  const url = URL.parse(raw);
  if (!url || url.port === '0') throw invalid;
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + declaration.path;
  for (const [key, value] of Object.entries(query)) {
    if (!declaration.query.includes(key))
      throw new ExtensionError(
        400,
        `The service request used a query value it didn't declare: ${key}.`,
      );
    const values = key.endsWith('[]') && Array.isArray(value) ? value : [value];
    if (
      values.length > 50 ||
      !values.every((v) => isScalar(v) && String(v).length <= 1024)
    )
      throw new ExtensionError(400, `The query value ${key} is invalid.`);
    for (const v of values) url.searchParams.append(key, String(v));
  }
  return url;
}

function requestBody(
  declaration: RequestDeclaration,
  body: Record<string, unknown>,
) {
  const entries = Object.entries(body);
  if (entries.length === 0) return undefined;
  if (declaration.method === 'GET')
    throw new ExtensionError(400, 'A GET request has no body.');
  for (const [key, value] of entries) {
    if (!declaration.body.includes(key))
      throw new ExtensionError(
        400,
        `The service request used a body value it didn't declare: ${key}.`,
      );
    if (value !== null && !isScalar(value))
      throw new ExtensionError(400, `The body value ${key} is invalid.`);
  }
  return Buffer.from(JSON.stringify(body));
}

type Reply = { status: number; body: Buffer };

function sendPinned(
  url: URL,
  method: string,
  host: string,
  address: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  signal: AbortSignal,
): Promise<Reply> {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        method,
        hostname: address,
        port: url.port || undefined,
        path: url.pathname + url.search,
        // Connect only to the approved IP, keeping the original credential
        // destination as HTTP Host and the TLS certificate / SNI identity.
        rejectUnauthorized: true,
        servername: isIP(host) ? undefined : host,
        headers,
        agent: false,
        signal,
      },
      (res) => {
        res.on('error', reject);
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.destroy();
          resolve({ status, body: Buffer.alloc(0) });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > responseLimit) {
            reject(new ExtensionError(502, 'too-large'));
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ status, body: Buffer.concat(chunks, bytes) }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const tlsCodes = [
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
];

export async function serviceRequest(
  manifest: Manifest,
  settings: Settings,
  id: string,
  payload: ServicePayload,
  remainingMs: number,
  tunarrPorts: readonly number[],
): Promise<unknown> {
  const declaration = manifest.requests.find((r) => r.id === id);
  if (!declaration)
    throw new ExtensionError(
      403,
      `This extension has no service request named ${id}.`,
    );
  const name = manifest.name;
  const label =
    manifest.settings.find((f) => f.key === declaration.baseUrlSetting)
      ?.label ?? 'the service address';
  const url = serviceUrl(
    declaration,
    settings,
    plainObject(payload?.query ?? {}, 'query'),
    label,
  );
  const body = requestBody(
    declaration,
    plainObject(payload?.body ?? {}, 'body'),
  );
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const headers: Record<string, string> = {
    Host: url.host,
    Accept: 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(body.length);
  }
  const credential = declaration.credential;
  const credentialLabel = credential
    ? (manifest.settings.find((f) => f.key === credential.setting)?.label ??
      'credentials')
    : undefined;
  if (credential) {
    const value = settings[credential.setting];
    if (value) {
      if (value.length > 4096 || /[^\x20-\x7e]/.test(value))
        throw new ExtensionError(
          400,
          `The ${credentialLabel} isn't a valid HTTP header value.`,
        );
      headers[credential.header] = value;
    }
  }

  const controller = new AbortController();
  const timeout = new ExtensionError(
    504,
    remainingMs <= requestTimeoutMs
      ? 'Extension timed out.'
      : `${name} didn't answer in time.`,
  );
  let timer: NodeJS.Timeout | undefined;

  function explain(reply: Reply): ExtensionError {
    const { status } = reply;
    if (status >= 300 && status < 400)
      return new ExtensionError(
        502,
        `${name} answered with a redirect. Use its direct address in ${label}.`,
      );
    if (status === 401 || status === 403)
      return new ExtensionError(
        502,
        credentialLabel
          ? `${name} refused the ${credentialLabel}.`
          : `${name} asked for credentials this extension doesn't send.`,
      );
    if (status === 404)
      return new ExtensionError(
        502,
        `${name} doesn't have the page this extension asked for. Check the address and any URL base in ${label}.`,
      );
    if (status >= 500)
      return new ExtensionError(502, `${name} had an error (HTTP ${status}).`);
    return new ExtensionError(502, `${name} answered with HTTP ${status}.`);
  }

  function connectionError(error: unknown): ExtensionError {
    if (error instanceof ExtensionError)
      return error.message === 'too-large'
        ? new ExtensionError(
            502,
            `${name}'s reply is larger than extensions can handle (4 MiB).`,
          )
        : error;
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : '';
    if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL'].includes(code))
      return new ExtensionError(
        502,
        `Tunarr can't find the address in ${label}. Check it, and that ${name} is on a network Tunarr can reach.`,
      );
    if (code === 'ECONNREFUSED')
      return new ExtensionError(
        502,
        `${name} refused the connection. Check the port in ${label} and that ${name} is running.`,
      );
    if (['EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code))
      return new ExtensionError(
        502,
        `Tunarr can't reach ${name}. Check ${label}.`,
      );
    if (tlsCodes.includes(code) || code.startsWith('ERR_TLS'))
      return new ExtensionError(
        502,
        `Tunarr doesn't trust ${name}'s HTTPS certificate.`,
      );
    return new ExtensionError(
      502,
      `Tunarr couldn't complete the request to ${name}.`,
    );
  }

  async function send() {
    // Check every DNS answer before sending credentials, then use the numeric
    // address. A DNS result arriving after the deadline cannot start a request.
    const addresses = await lookup(host, { all: true });
    controller.signal.throwIfAborted();
    const own = ownAddresses();
    for (const { address, family } of addresses) {
      if (!addressAllowed(address, family, port, own, tunarrPorts)) {
        throw new ExtensionError(
          403,
          `${label} points at an address extensions can't use: Tunarr itself or a cloud metadata address.`,
        );
      }
    }
    let lastError: unknown;
    for (const { address } of addresses) {
      controller.signal.throwIfAborted();
      let reply: Reply;
      try {
        reply = await sendPinned(
          url,
          declaration!.method,
          host,
          address,
          headers,
          body,
          controller.signal,
        );
      } catch (error) {
        lastError = error;
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : '';
        if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code))
          continue;
        throw error;
      }
      if (reply.status < 200 || reply.status >= 300) throw explain(reply);
      if (reply.body.length === 0) {
        // Write requests may answer with no body (e.g. 204).
        if (declaration!.method !== 'GET') return null;
        throw new ExtensionError(
          502,
          `${name} sent an empty reply this extension can't read.`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(reply.body.toString('utf8'));
      } catch {
        throw new ExtensionError(
          502,
          `${name} sent a reply this extension can't read.`,
        );
      }
      if (
        declaration!.method === 'GET' &&
        (parsed === null || typeof parsed !== 'object')
      )
        throw new ExtensionError(
          502,
          `${name} sent a reply this extension can't read.`,
        );
      return parsed;
    }
    throw lastError instanceof Error ? lastError : new Error('no address');
  }

  try {
    return await Promise.race([
      send(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            reject(timeout);
            controller.abort();
          },
          Math.max(0, Math.min(remainingMs, requestTimeoutMs)),
        );
      }),
    ]);
  } catch (error) {
    if (error === timeout) throw timeout;
    throw connectionError(error);
  } finally {
    clearTimeout(timer);
  }
}

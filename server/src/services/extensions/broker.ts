import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  ExtensionError,
  type Manifest,
  type ReadDeclaration,
  type Settings,
} from './schema.ts';

const responseLimit = 4 * 1024 * 1024;
const readTimeoutMs = 8_000;

// Private LANs are valid service destinations. Keep special-use networks,
// transition prefixes and known cloud metadata endpoints outside that boundary.
const blocked = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(ip, prefix, 'ipv4');
for (const ip of ['100.100.100.200', '168.63.129.16'])
  blocked.addAddress(ip, 'ipv4');
for (const ip of ['fd00:ec2::254', 'fd00:ec2::23'])
  blocked.addAddress(ip, 'ipv6');
blocked.addSubnet('2001::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
const ipv6Unicast = new BlockList();
ipv6Unicast.addSubnet('2000::', 3, 'ipv6');
ipv6Unicast.addSubnet('fc00::', 7, 'ipv6');
ipv6Unicast.addSubnet('::ffff:0:0', 96, 'ipv6');

function serviceUrl(
  read: ReadDeclaration,
  settings: Settings,
  params: Record<string, unknown>,
) {
  const raw = settings[read.baseUrlSetting];
  const match = raw?.match(
    /^https?:\/\/(?:\[[\da-f:.]+\]|[\w.-]+)(?::\d+)?((?:\/[\w.~-]+)*\/?)$/i,
  );
  if (
    !raw ||
    raw.length > 2048 ||
    !match ||
    match[0] !== raw ||
    match[1]?.split('/').some((s) => s === '..' || s === '.')
  ) {
    throw new ExtensionError(
      400,
      'Enter a valid HTTP or HTTPS service address and optional base path.',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
    if (url.port === '0') throw new RangeError();
  } catch {
    throw new ExtensionError(
      400,
      'Enter a valid HTTP or HTTPS service address and optional base path.',
    );
  }
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + read.path;
  if (!params || typeof params !== 'object' || Array.isArray(params))
    throw new ExtensionError(400, 'Invalid service query parameters.');
  for (const [key, value] of Object.entries(params)) {
    if (!read.query.includes(key))
      throw new ExtensionError(
        400,
        'The service read received an undeclared query parameter.',
      );
    if (
      (typeof value !== 'string' &&
        typeof value !== 'boolean' &&
        !(typeof value === 'number' && Number.isFinite(value))) ||
      String(value).length > 1024
    )
      throw new ExtensionError(400, 'Invalid service query parameter.');
    url.searchParams.set(key, String(value));
  }
  return url;
}

function ownAddresses() {
  const local = new BlockList();
  for (const iface of Object.values(networkInterfaces())) {
    for (const address of iface ?? []) {
      local.addAddress(
        address.address.split('%')[0]!,
        address.family === 'IPv6' ? 'ipv6' : 'ipv4',
      );
    }
  }
  return local;
}

function getPinned(
  url: URL,
  host: string,
  address: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Buffer> {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.get(
      {
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
        if (res.statusCode !== 200) {
          reject(
            new ExtensionError(502, `Service returned HTTP ${res.statusCode}.`),
          );
          res.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > responseLimit) {
            reject(
              new ExtensionError(
                502,
                'The service response exceeds the size limit.',
              ),
            );
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks, bytes)));
      },
    );
    req.on('error', reject);
  });
}

export async function serviceRead(
  manifest: Manifest,
  settings: Settings,
  id: string,
  params: Record<string, unknown>,
  remainingMs: number,
): Promise<unknown> {
  const read = manifest.reads.find((r) => r.id === id);
  if (!read)
    throw new ExtensionError(403, 'This extension has no such service read.');
  const url = serviceUrl(read, settings, params);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const normalized = host.toLowerCase().replace(/\.$/, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    throw new ExtensionError(403, 'The configured service address is blocked.');
  }
  const headers: Record<string, string> = {
    Host: url.host,
    Accept: 'application/json',
  };
  if (read.credential) {
    const value = settings[read.credential.setting];
    if (value) {
      if (value.length > 4096 || /[^\x20-\x7e]/.test(value))
        throw new ExtensionError(
          400,
          'The service credential is not a valid HTTP header value.',
        );
      headers[read.credential.header] = value;
    }
  }
  const controller = new AbortController();
  const timeout = new ExtensionError(
    504,
    remainingMs <= readTimeoutMs
      ? 'Extension timed out.'
      : 'The configured service timed out.',
  );
  let timer: NodeJS.Timeout | undefined;
  async function request() {
    // Check every DNS answer before sending credentials, then use the numeric
    // address. A DNS result arriving after the deadline cannot initiate a request.
    const addresses = await lookup(host, { all: true });
    controller.signal.throwIfAborted();
    const local = ownAddresses();
    for (const { address, family } of addresses) {
      const type = family === 6 ? 'ipv6' : 'ipv4';
      if (
        (family === 6 && !ipv6Unicast.check(address, type)) ||
        blocked.check(address, type) ||
        local.check(address, type)
      ) {
        throw new ExtensionError(
          403,
          'The configured service address is blocked.',
        );
      }
    }
    for (const { address } of addresses) {
      controller.signal.throwIfAborted();
      let body: Buffer;
      try {
        body = await getPinned(url, host, address, headers, controller.signal);
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(
            String(error.code),
          )
        )
          continue;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        throw new ExtensionError(502, 'The service returned invalid JSON.');
      }
      if (parsed === null || typeof parsed !== 'object')
        throw new ExtensionError(502, 'The service returned invalid JSON.');
      return parsed;
    }
    throw new ExtensionError(
      502,
      'Could not connect to the configured service.',
    );
  }
  try {
    return await Promise.race([
      request(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            reject(timeout);
            controller.abort();
          },
          Math.max(0, Math.min(remainingMs, readTimeoutMs)),
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof ExtensionError) throw error;
    throw new ExtensionError(502, 'Could not complete the service request.');
  } finally {
    clearTimeout(timer);
  }
}

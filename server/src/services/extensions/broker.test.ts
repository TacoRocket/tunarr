import { BlockList } from 'node:net';
import { describe, expect, it } from 'vitest';
import { addressAllowed } from './broker.ts';

const tunarrPorts = [8000, 7700];
const own = new BlockList();
own.addAddress('192.0.2.20', 'ipv4');
own.addAddress('fd12:3456::20', 'ipv6');

const allowed = (address: string, family: number, port: number) =>
  addressAllowed(address, family, port, own, tunarrPorts);

describe('addressAllowed', () => {
  it('lets an extension reach a service on the same machine', () => {
    expect(allowed('127.0.0.1', 4, 6767)).toBe(true);
    expect(allowed('::1', 6, 6767)).toBe(true);
    expect(allowed('192.0.2.20', 4, 6767)).toBe(true);
    expect(allowed('fd12:3456::20', 6, 6767)).toBe(true);
  });

  it("keeps extensions off Tunarr's own ports on this machine", () => {
    expect(allowed('127.0.0.1', 4, 8000)).toBe(false);
    expect(allowed('127.0.0.2', 4, 7700)).toBe(false);
    expect(allowed('::1', 6, 8000)).toBe(false);
    expect(allowed('192.0.2.20', 4, 8000)).toBe(false);
    expect(allowed('::ffff:127.0.0.1', 6, 8000)).toBe(false);
    expect(allowed('::ffff:7f00:1', 6, 8000)).toBe(false);
  });

  it('allows the same port number on another machine', () => {
    expect(allowed('192.0.2.30', 4, 8000)).toBe(true);
    expect(allowed('198.51.100.2', 4, 6767)).toBe(true);
  });

  it('refuses metadata, link-local and reserved addresses', () => {
    expect(allowed('169.254.169.254', 4, 80)).toBe(false);
    expect(allowed('100.100.100.200', 4, 80)).toBe(false);
    expect(allowed('0.0.0.0', 4, 6767)).toBe(false);
    expect(allowed('224.0.0.1', 4, 6767)).toBe(false);
    expect(allowed('fe80::1', 6, 6767)).toBe(false);
    expect(allowed('fd00:ec2::254', 6, 80)).toBe(false);
    expect(allowed('::ffff:169.254.169.254', 6, 80)).toBe(false);
  });
});

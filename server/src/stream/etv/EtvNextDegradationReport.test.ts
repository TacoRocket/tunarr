import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { CrtHdrBypassedMessage } from '../../ffmpeg/StreamDegradations.ts';
import { readEtvNextDegradations } from './EtvNextDegradationReport.ts';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

async function writeReport(report: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'etv-degradations-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'degradations.json');
  await fs.writeFile(
    file,
    typeof report === 'string' ? report : JSON.stringify(report),
  );
  return file;
}

const onAir = {
  id: 'on-air',
  start: '2026-11-01T12:00:00Z',
  finish: '2026-11-01T12:30:00Z',
};
const next = {
  id: 'next',
  start: '2026-11-01T12:30:00Z',
  finish: '2026-11-01T13:00:00Z',
};
const now = Date.parse('2026-11-01T12:10:00Z');

test('preserves both HDR status codes and the worker messages', async () => {
  const file = await writeReport({
    items: [
      {
        ...onAir,
        degradations: [
          {
            code: 'hdr_tone_mapped',
            message:
              'Converted to SDR because this profile produces 8-bit video.',
            since: onAir.start,
          },
          {
            code: 'hdr_preservation_unsupported',
            message:
              'Dolby Vision profile 5 cannot be preserved with tone mapping Off.',
            since: onAir.start,
          },
        ],
      },
    ],
  });

  expect(readEtvNextDegradations(file, now)).toEqual([
    {
      code: 'hdr_tone_mapped',
      message: 'Converted to SDR because this profile produces 8-bit video.',
      firstSeen: Date.parse(onAir.start),
    },
    {
      code: 'hdr_preservation_unsupported',
      message:
        'Dolby Vision profile 5 cannot be preserved with tone mapping Off.',
      firstSeen: Date.parse(onAir.start),
    },
  ]);
});

test('reports the item on air, not the one transcoded ahead', async () => {
  const file = await writeReport({
    items: [
      {
        ...onAir,
        degradations: [
          {
            code: 'hardware_decode_unavailable',
            message: 'VAAPI hardware decoding cannot be used for this item.',
            since: '2026-11-01T11:00:00Z',
          },
        ],
      },
      {
        ...next,
        degradations: [
          {
            code: 'hardware_encode_unavailable',
            message: 'later',
            since: '2026-11-01T12:09:00Z',
          },
        ],
      },
    ],
  });

  expect(readEtvNextDegradations(file, now)).toEqual([
    {
      code: 'hardware_decode_unavailable',
      message: 'VAAPI hardware decoding cannot be used for this item.',
      firstSeen: Date.parse('2026-11-01T11:00:00Z'),
    },
  ]);
});

test('shader codes become CRT codes with CRT wording', async () => {
  const file = await writeReport({
    items: [
      {
        ...onAir,
        degradations: [
          {
            code: 'custom_shader_hdr_skipped',
            message: 'The custom shader is not drawn on this Hdr10 source.',
            since: '2026-11-01T12:00:00Z',
          },
          {
            code: 'custom_shader_unavailable',
            message: 'worker wording',
            since: '2026-11-01T12:00:00Z',
          },
        ],
      },
    ],
  });

  const reported = readEtvNextDegradations(file, now);
  expect(reported.map((d) => d.code)).toEqual([
    'crt_hdr_bypassed',
    'crt_unavailable',
  ]);
  expect(reported[0]?.message).toBe(CrtHdrBypassedMessage);
  expect(reported[1]?.message).toMatch(/^CRT is off: the ErsatzTV next/);
});

test('codes this version does not know are skipped', async () => {
  const file = await writeReport({
    items: [
      {
        ...onAir,
        degradations: [
          { code: 'constructor', message: 'x', since: onAir.start },
          { code: 'something_newer', message: 'x', since: onAir.start },
          {
            code: 'vaapi_low_power_unavailable',
            message: 'no low-power H.264',
            since: onAir.start,
          },
        ],
      },
    ],
  });

  expect(readEtvNextDegradations(file, now).map((d) => d.code)).toEqual([
    'vaapi_low_power_unavailable',
  ]);
});

test('a run of short clips prepared ahead keeps the one on air', async () => {
  const startMs = Date.parse('2026-11-01T12:00:00Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  // nine three-second clips; the last starts 24 s ahead of the read
  const items = Array.from({ length: 9 }, (_, i) => ({
    id: `clip-${i}`,
    start: iso(startMs + i * 3_000),
    finish: iso(startMs + (i + 1) * 3_000),
    degradations: [
      {
        code: 'hardware_decode_unavailable',
        message: `clip ${i} decodes on the CPU`,
        since: iso(startMs),
      },
    ],
  }));
  const file = await writeReport({ items });

  expect(readEtvNextDegradations(file, startMs + 1_000)).toEqual([
    {
      code: 'hardware_decode_unavailable',
      message: 'clip 0 decodes on the CPU',
      firstSeen: startMs,
    },
  ]);
});

test('nothing is reported before the worker builds the item on air', async () => {
  const file = await writeReport({ items: [{ ...next, degradations: [] }] });

  expect(readEtvNextDegradations(file, now)).toEqual([]);
});

test('a missing or unreadable report reports nothing', async () => {
  const malformed = await writeReport('{"items": [');
  const wrongShape = await writeReport({ items: 'none' });

  expect(readEtvNextDegradations(malformed, now)).toEqual([]);
  expect(readEtvNextDegradations(wrongShape, now)).toEqual([]);
  expect(
    readEtvNextDegradations(path.join(os.tmpdir(), 'no-such-report.json'), now),
  ).toEqual([]);
});

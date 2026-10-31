import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createSubtitleMatroska } from './SelectiveMatroskaReader.ts';

function element(id: string, ...parts: Buffer[]) {
  const payload = Buffer.concat(parts);
  let width = 1;
  while (payload.length >= 2 ** (7 * width) - 1) width++;
  const size = Buffer.alloc(width);
  let value = BigInt(payload.length) | (1n << BigInt(7 * width));
  for (let i = width - 1; i >= 0; i--) {
    size[i] = Number(value & 255n);
    value >>= 8n;
  }
  return Buffer.concat([Buffer.from(id, 'hex'), size, payload]);
}

it('retains first-packet timing anchors but skips subsequent unselected payloads', async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'selective-matroska-'),
  );
  try {
    const video = element(
      'ae',
      element('d7', Buffer.from([1])),
      element('83', Buffer.from([1])),
      element('86', Buffer.from('V_MPEG4/ISO/AVC')),
    );
    const subtitle = element(
      'ae',
      element('d7', Buffer.from([2])),
      element('83', Buffer.from([17])),
      element('86', Buffer.from('S_TEXT/UTF8')),
    );
    const otherSubtitle = element(
      'ae',
      element('d7', Buffer.from([3])),
      element('83', Buffer.from([17])),
      element('86', Buffer.from('S_TEXT/ASS')),
      element('63a2', Buffer.from('[Script Info]\n')),
    );
    const videoAnchor = element(
      'a3',
      Buffer.from([0x81, 0, 0, 0x80]),
      Buffer.from('FIRST VIDEO PACKET'),
    );
    const videoBlock = element(
      'a3',
      Buffer.from([0x81, 0, 0, 0x80]),
      Buffer.alloc(2 * 1024 * 1024, 0x55),
    );
    const text = Buffer.from('Selected subtitle\nWith a second line');
    const subtitleGroup = element(
      'a0',
      element('a1', Buffer.from([0x82, 0, 123, 0]), text),
      element('9b', Buffer.from([0x07, 0xd0])),
    );
    const unselected = element(
      'a3',
      Buffer.from([0x83, 0, 0, 0]),
      Buffer.from('UNSELECTED SUBTITLE'),
    );
    const info = element(
      '1549a966',
      element('2ad7b1', Buffer.from([0x0f, 0x42, 0x40])),
    );
    const source = Buffer.concat([
      element('1a45dfa3', element('4282', Buffer.from('matroska'))),
      element(
        '18538067',
        info,
        element('1654ae6b', video, subtitle, otherSubtitle),
        element(
          '1f43b675',
          element('e7', Buffer.from([0x03, 0xe8])),
          videoAnchor,
          videoBlock,
          subtitleGroup,
          unselected,
          element(
            'a3',
            Buffer.from([0x83, 0, 0, 0]),
            Buffer.from('SECOND UNSELECTED SUBTITLE'),
          ),
        ),
      ),
    ]);
    const input = path.join(directory, 'input.mkv');
    const output = path.join(directory, 'subtitles.mks');
    await fs.writeFile(input, source);
    const result = await createSubtitleMatroska(input, output, [1]);
    const extracted = await fs.readFile(output);
    expect(result.sourceSizeBytes).toBe(source.length);
    expect(result.bytesRead).toBeLessThan(16 * 1024);
    expect(result.streamIndexes).toEqual(new Map([[1, 1]]));
    expect(extracted.includes(subtitle)).toBe(true);
    expect(extracted.includes(subtitleGroup)).toBe(true);
    expect(extracted.includes(info)).toBe(true);
    expect(extracted.includes(element('e7', Buffer.from([0x03, 0xe8])))).toBe(
      true,
    );
    expect(extracted.includes(video)).toBe(true);
    expect(extracted.includes(videoAnchor)).toBe(true);
    expect(extracted.includes(videoBlock)).toBe(false);
    expect(extracted.includes(otherSubtitle)).toBe(true);
    expect(extracted.includes(unselected)).toBe(true);
    expect(extracted.includes(Buffer.from('SECOND UNSELECTED SUBTITLE'))).toBe(
      false,
    );
    expect(extracted.length).toBeLessThan(1024);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

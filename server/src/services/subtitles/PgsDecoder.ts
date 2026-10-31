// PGS parser/palette adapted from Subtitle Edit's BluRaySupParser.cs and
// BluRaySupPalette.cs. Copyright 2009 Volker Oth (0xdeadbeef).
// Upstream: converted to C# and modified by Nikse.dk@gmail.com.
// Licensed under the Apache License, Version 2.0; see LICENSE.PGS-Apache-2.0.
// You may not use this file except in compliance with that license:
// https://www.apache.org/licenses/LICENSE-2.0
// Distributed on an AS IS BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
// either express or implied. See the license for permissions and limitations.
// Modified for Tunarr: TypeScript direct-block parsing, strict input failures,
// immutable bitmap snapshots, RGBA source-over composition and PGM output.
// OCR preparation also adapts Subtitle Edit's MIT-licensed seconv/common code;
// see LICENSE.SubtitleEdit and README.md for the pinned source and differences.
import type { PgsBlock } from './PgsMatroskaReader.ts';

type Bitmap = {
  width: number;
  height: number;
  data: Buffer;
  expected: number;
  complete: boolean;
};
type Placement = { id: number; x: number; y: number };
export type PgsCue = {
  startMs: number;
  endMs: number | null;
  width: number;
  height: number;
  paletteId: number;
  paletteUpdate: boolean;
  placements: Placement[];
  palettes: Buffer[];
  bitmaps: Bitmap[];
};

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error('Missing PGS image or composition entry');
  return value;
}

function need(data: Buffer, length: number) {
  if (data.length < length) throw new Error('Truncated PGS segment');
}

export function decodePgs(blocks: PgsBlock[]): PgsCue[] {
  const palettes = new Map<number, Buffer[]>();
  const objects = new Map<number, Bitmap>();
  const cues: PgsCue[] = [];
  let current: PgsCue | undefined;
  let pending = Buffer.alloc(0);
  let pendingMs = 0;
  let finalBlockEnd: number | null = null;
  let forceFirst = true;
  const complete = () => {
    if (current === undefined) return;
    if (current.placements.length > 0) {
      const palette = palettes.get(current.paletteId);
      if (palette === undefined) throw new Error('PGS picture has no palette');
      current.palettes = [...palette];
      current.bitmaps = current.placements.map(({ id }) => {
        const bitmap = objects.get(id);
        if (
          bitmap === undefined ||
          !bitmap.complete ||
          bitmap.data.length !== bitmap.expected
        ) {
          throw new Error('PGS picture has an incomplete bitmap');
        }
        return bitmap;
      });
    }
    cues.push(current);
    current = undefined;
  };
  for (const block of blocks) {
    const blockMs = Number(block.timestampNs) / 1_000_000;
    if (block.durationNs !== null) {
      finalBlockEnd = Math.max(
        finalBlockEnd ?? -Infinity,
        Number(block.timestampNs + block.durationNs) / 1_000_000,
      );
    }
    if (pending.length === 0) pendingMs = blockMs;
    pending = Buffer.concat([pending, block.data]);
    while (pending.length >= 3) {
      const length = pending.readUInt16BE(1);
      if (pending.length < length + 3) break;
      const kind = pending.readUInt8(0);
      const data = pending.subarray(3, length + 3);
      if (kind === 0x16) {
        complete();
        const previous = cues.at(-1);
        if (previous !== undefined && previous.endMs === null)
          previous.endMs = pendingMs;
        need(data, 11);
        const state = data.readUInt8(7);
        if (![0, 0x40, 0x80, 0xc0].includes(state))
          throw new Error('Invalid PGS composition state');
        if (state === 0x80) {
          objects.clear();
          palettes.clear();
        }
        const placements: Placement[] = [];
        for (let offset = 11, i = 0; i < data.readUInt8(10); i++, offset += 8) {
          need(data, offset + 8);
          if ((data.readUInt8(offset + 3) & 0x80) !== 0)
            throw new Error('Cropped PGS objects are not supported');
          placements.push({
            id: data.readUInt16BE(offset),
            x: data.readUInt16BE(offset + 4),
            y: data.readUInt16BE(offset + 6),
          });
        }
        current = {
          startMs: pendingMs,
          endMs: null,
          width: data.readUInt16BE(0),
          height: data.readUInt16BE(2),
          paletteId: data.readUInt8(9),
          paletteUpdate: data.readUInt8(8) === 0x80,
          placements,
          palettes: [],
          bitmaps: [],
        };
        forceFirst = true;
      } else if (kind === 0x14 && current !== undefined) {
        need(data, 7);
        if ((data.length - 2) % 5 !== 0) throw new Error('Invalid PGS palette');
        const previous = palettes.get(data.readUInt8(0)) ?? [];
        palettes.set(data.readUInt8(0), [
          ...(current.paletteUpdate ? previous.slice(0, -1) : previous),
          Buffer.from(data.subarray(2)),
        ]);
      } else if (kind === 0x15 && current !== undefined) {
        need(data, 4);
        const id = data.readUInt16BE(0);
        if (!current.paletteUpdate) {
          if ((data.readUInt8(3) & 0x80) !== 0 || forceFirst) {
            need(data, 11);
            const width = data.readUInt16BE(7);
            const height = data.readUInt16BE(9);
            const expected = data.readUIntBE(4, 3) - 4;
            if (
              width === 0 ||
              height === 0 ||
              width * height > 16_777_216 ||
              expected < 0
            )
              throw new Error('Invalid or oversized PGS bitmap');
            objects.set(id, {
              width,
              height,
              expected,
              data: Buffer.from(data.subarray(11)),
              complete: (data.readUInt8(3) & 0x40) !== 0,
            });
          } else {
            const previous = objects.get(id);
            if (previous === undefined || previous.complete)
              throw new Error('Orphan PGS bitmap fragment');
            const joined = Buffer.concat([previous.data, data.subarray(4)]);
            if (joined.length > previous.expected)
              throw new Error('Oversized PGS bitmap fragment');
            objects.set(id, {
              ...previous,
              data: joined,
              complete: (data.readUInt8(3) & 0x40) !== 0,
            });
          }
        }
        forceFirst = false;
      } else if (kind === 0x80) {
        complete();
        forceFirst = true;
      }
      pending = pending.subarray(length + 3);
      pendingMs = blockMs;
    }
  }
  if (pending.length !== 0) throw new Error('Incomplete final PGS segment');
  complete();
  const last = cues.at(-1);
  if (
    last !== undefined &&
    last.endMs === null &&
    finalBlockEnd !== null &&
    finalBlockEnd > last.startMs
  )
    last.endMs = finalBlockEnd;
  return mergeFades(cues.filter((cue) => cue.placements.length > 0));
}

function paletteColors(data: Buffer) {
  const colors = new Uint8ClampedArray(1024);
  const channel = (value: number) =>
    Math.max(
      0,
      Math.min(255, Math.floor(value + (value > 254 ? 0.35 : 0) + 0.5)),
    );
  for (let i = 0; i < data.length; i += 5) {
    const index = data.readUInt8(i) * 4;
    const alpha = data.readUInt8(i + 4);
    const y = alpha < 14 ? 0 : (data.readUInt8(i + 1) - 16) * 1.164383562;
    const cr = alpha < 14 ? 0 : data.readUInt8(i + 2) - 128;
    const cb = alpha < 14 ? 0 : data.readUInt8(i + 3) - 128;
    colors[index] = channel(y + 1.792741071 * cr);
    colors[index + 1] = channel(y - 0.5329093286 * cr - 0.2132486143 * cb);
    colors[index + 2] = channel(y + 2.112401786 * cb);
    colors[index + 3] = Math.max(required(colors[index + 3]), alpha);
  }
  return colors;
}

function decodeBitmap(bitmap: Bitmap, colors: Uint8ClampedArray) {
  const pixels = Buffer.alloc(bitmap.width * bitmap.height * 4);
  let position = 0;
  let x = 0;
  for (let i = 0; i < bitmap.data.length; ) {
    let color = bitmap.data.readUInt8(i++);
    let count = 1;
    if (color === 0) {
      need(bitmap.data, i + 1);
      const control = bitmap.data.readUInt8(i++);
      if (control === 0) {
        position =
          Math.floor(position / bitmap.width) * bitmap.width +
          (x < bitmap.width ? bitmap.width : 0);
        x = 0;
        continue;
      }
      count = control & 0x3f;
      if ((control & 0x40) !== 0) {
        need(bitmap.data, i + 1);
        count = (count << 8) + bitmap.data.readUInt8(i++);
      }
      if ((control & 0x80) !== 0) {
        need(bitmap.data, i + 1);
        color = bitmap.data.readUInt8(i++);
      }
    }
    if (position + count > bitmap.width * bitmap.height)
      throw new Error('PGS run exceeds bitmap');
    for (let j = 0; j < count; j++)
      pixels.set(colors.subarray(color * 4, color * 4 + 4), (position + j) * 4);
    position += count;
    x += count;
  }
  return pixels;
}

export function renderPgs(cue: PgsCue) {
  const palette = cue.palettes.at(-1);
  if (palette === undefined || cue.bitmaps.length === 0)
    throw new Error('PGS cue is missing image data');
  const colors = paletteColors(palette);
  const left = Math.min(...cue.placements.map((p) => p.x));
  const top = Math.min(...cue.placements.map((p) => p.y));
  const width =
    Math.max(
      ...cue.placements.map((p, i) => p.x + required(cue.bitmaps[i]).width),
    ) - left;
  const height =
    Math.max(
      ...cue.placements.map((p, i) => p.y + required(cue.bitmaps[i]).height),
    ) - top;
  if (width * height > 16_777_216) throw new Error('Oversized PGS composition');
  const pixels = Buffer.alloc(width * height * 4);
  cue.bitmaps.forEach((bitmap, i) => {
    const layer = decodeBitmap(bitmap, colors);
    const placement = required(cue.placements[i]);
    for (let y = 0; y < bitmap.height; y++) {
      for (let x = 0; x < bitmap.width; x++) {
        const src = (y * bitmap.width + x) * 4;
        const dst =
          ((placement.y - top + y) * width + placement.x - left + x) * 4;
        const sourceAlpha = layer.readUInt8(src + 3) / 255;
        if (sourceAlpha === 0) continue;
        const remainingAlpha =
          (pixels.readUInt8(dst + 3) / 255) * (1 - sourceAlpha);
        const alpha = sourceAlpha + remainingAlpha;
        // Porter-Duff source-over: transparent parts of later objects retain text below.
        for (let channel = 0; channel < 3; channel++) {
          pixels[dst + channel] = Math.round(
            (layer.readUInt8(src + channel) * sourceAlpha +
              pixels.readUInt8(dst + channel) * remainingAlpha) /
              alpha,
          );
        }
        pixels[dst + 3] = Math.round(alpha * 255);
      }
    }
  });
  return { width, height, pixels };
}

function mergeFades(cues: PgsCue[]) {
  const groups: number[][] = [];
  let group: number[] = [];
  for (let i = cues.length - 1; i > 0; i--) {
    const current = required(cues[i]),
      previous = required(cues[i - 1]);
    const same =
      previous.endMs !== null &&
      Math.abs(previous.endMs - current.startMs) < 10 / 90 &&
      previous.width === current.width &&
      previous.height === current.height &&
      previous.bitmaps.length === current.bitmaps.length &&
      current.bitmaps.every((bitmap, j) =>
        bitmap.data.equals(required(previous.bitmaps[j]).data),
      );
    if (same) {
      if (group.length === 0) group.push(i);
      group.push(i - 1);
    } else if (group.length > 0) {
      groups.push(group);
      group = [];
    }
  }
  if (group.length > 0) groups.push(group);
  if (groups.length < 3) return cues;
  const removed = new Set<number>();
  for (const indexes of groups) {
    const a = required(cues[required(indexes[0])]),
      b = required(cues[required(indexes[1])]);
    let qualifies =
      indexes.length !== 2 ||
      (a.endMs !== null && a.endMs - a.startMs < 400) ||
      (b.endMs !== null && b.endMs - b.startMs < 400) ||
      a.palettes.length > 2 ||
      b.palettes.length > 2;
    if (!qualifies) {
      const first = renderPgs(a),
        second = renderPgs(b);
      const pixels = first.pixels;
      let minX = first.width,
        minY = first.height,
        maxX = -1,
        maxY = -1;
      for (let y = 0; y < first.height; y++)
        for (let x = 0; x < first.width; x++)
          if (required(pixels[(y * first.width + x) * 4 + 3]) > 0) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
      const otherPixels = second.pixels;
      qualifies =
        maxX - minX + 1 > 300 ||
        maxY - minY + 1 > 110 ||
        (first.width === second.width &&
          first.height === second.height &&
          pixels.equals(otherPixels));
    }
    if (!qualifies) continue;
    const half = indexes.length / 2;
    const middle = Number.isInteger(half)
      ? half
      : Math.floor(half) % 2 === 0
        ? Math.floor(half)
        : Math.ceil(half);
    const retained = required(indexes[middle]);
    required(cues[retained]).startMs = required(
      cues[required(indexes.at(-1))],
    ).startMs;
    required(cues[retained]).endMs = a.endMs;
    for (const index of indexes) if (index !== retained) removed.add(index);
  }
  return cues.filter((_, i) => !removed.has(i));
}

export function preparePgsForOcr(cue: PgsCue) {
  const { width, height, pixels } = renderPgs(cue);
  const mask = Buffer.alloc(width * height);
  for (let i = 0; i < mask.length; i++) {
    const offset = i * 4;
    mask[i] =
      pixels.readUInt8(offset + 3) >= 100 &&
      Math.max(
        pixels.readUInt8(offset),
        pixels.readUInt8(offset + 1),
        pixels.readUInt8(offset + 2),
      ) >= 90
        ? 0
        : 255;
  }
  const scaledWidth = width * 2;
  const grayscale = Buffer.alloc(scaledWidth * height * 2);
  // Fixed 2x Mitchell-Netravali filter (B = C = 1/3), matching the original
  // Skia preparation. Nearest/bilinear introduced OCR errors in the track A/B.
  const weights = [-27 / 1152, 901 / 1152, 295 / 1152, -17 / 1152];
  for (let y = 0; y < height * 2; y++) {
    const top = Math.floor(y / 2 - 0.25);
    for (let x = 0; x < scaledWidth; x++) {
      const left = Math.floor(x / 2 - 0.25);
      let value = 0;
      for (let dy = 0; dy < 4; dy++) {
        const sourceY = Math.max(0, Math.min(height - 1, top + dy - 1));
        const wy = required(weights[y % 2 === 0 ? 3 - dy : dy]);
        for (let dx = 0; dx < 4; dx++) {
          const sourceX = Math.max(0, Math.min(width - 1, left + dx - 1));
          const wx = required(weights[x % 2 === 0 ? 3 - dx : dx]);
          value += mask.readUInt8(sourceY * width + sourceX) * wx * wy;
        }
      }
      grayscale[y * scaledWidth + x] = Math.max(
        0,
        Math.min(255, Math.round(value)),
      );
    }
  }
  return Buffer.concat([
    Buffer.from(`P5\n${scaledWidth} ${height * 2}\n255\n`),
    grayscale,
  ]);
}

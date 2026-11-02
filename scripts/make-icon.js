#!/usr/bin/env node
/**
 * Regenerate images/icon.png — the 128x128 Marketplace icon.
 *
 * The mark is drawn from geometry rather than shipped as opaque binary art:
 * a dark rounded tile with three offset parchment bars for the palimpsest
 * layers the project is named after. Output is deterministic, so rerunning
 * this script reproduces the committed PNG byte for byte.
 *
 *   npm run icon
 *
 * PNGs are written with node:zlib only, so there is no image dependency.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIZE = 128;
const SUPERSAMPLE = 4; // Box-downsample for smooth rounded corners.
const SCALE = SIZE * SUPERSAMPLE;
const TILE_RADIUS = 26;
const PAGE_RADIUS = 5;

const TILE = [0x1f, 0x24, 0x30];
// Back to front, each page a shade lighter than the one beneath it.
const PAGES = [
  { x: [34, 94], y: [30, 48], color: [0xc2, 0xac, 0x82] },
  { x: [26, 102], y: [52, 70], color: [0xd8, 0xc6, 0xa2] },
  { x: [18, 110], y: [74, 92], color: [0xea, 0xde, 0xc6] },
];

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

/** Paint a rounded rectangle into the supersampled RGBA buffer. */
function roundRect(pixels, x0, y0, x1, y1, radius, [red, green, blue]) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const dx = x - clamp(x, x0 + radius, x1 - radius);
      const dy = y - clamp(y, y0 + radius, y1 - radius);
      if (dx * dx + dy * dy > radius * radius) continue;
      const i = (y * SCALE + x) * 4;
      pixels[i] = red;
      pixels[i + 1] = green;
      pixels[i + 2] = blue;
      pixels[i + 3] = 255;
    }
  }
}

function renderIcon() {
  const pixels = new Uint8Array(SCALE * SCALE * 4);
  const s = (value) => value * SUPERSAMPLE;

  roundRect(pixels, 0, 0, s(SIZE) - 1, s(SIZE) - 1, s(TILE_RADIUS), TILE);
  for (const page of PAGES) {
    roundRect(
      pixels,
      s(page.x[0]),
      s(page.y[0]),
      s(page.x[1]),
      s(page.y[1]),
      s(PAGE_RADIUS),
      page.color,
    );
  }

  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const i = ((y * SUPERSAMPLE + sy) * SCALE + (x * SUPERSAMPLE + sx)) * 4;
          for (let c = 0; c < 4; c += 1) acc[c] += pixels[i + c];
        }
      }
      const o = (y * SIZE + x) * 4;
      for (let c = 0; c < 4; c += 1) out[o + c] = Math.round(acc[c] / SUPERSAMPLE ** 2);
    }
  }
  return out;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const target = path.join(__dirname, "..", "images", "icon.png");
fs.mkdirSync(path.dirname(target), { recursive: true });
const png = encodePng(renderIcon());
fs.writeFileSync(target, png);
console.log(`wrote ${target} (${SIZE}x${SIZE}, ${png.length} bytes)`);

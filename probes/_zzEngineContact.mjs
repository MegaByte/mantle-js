// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzEngineContact — a contact sheet of the fill engines against the exact reference.
//
// Every number in this work is an aggregate, and an aggregate cannot say what a defect LOOKS like.
// This takes the raw frames _zzEnginePaint dumps (OUTDIR=) and writes nearest-neighbour magnified
// crops as PNGs, one row per place worth looking at, so the engines can be compared by eye at the
// same pixels the metrics name.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { deflateSync } from 'zlib';

const N = +(process.env.N || 512);
const SRC = process.env.SRC || '/private/tmp/frames/t512';
const DST = process.env.DST || '/private/tmp/frames/png';
mkdirSync(DST, { recursive: true });

// ---- a minimal PNG writer: IHDR + IDAT + IEND, no dependencies ----
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
};
/// rgb: Uint8Array of w*h*3.
function png(rgb, w, h) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    rgb.subarray ? raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (1 + w * 3) + 1) : 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- the frames. Engines are RGBA and BOTTOM-UP (readPixels order); the reference is RGB, same. ----
const load = (name, stride) => {
  const b = readFileSync(`${SRC}_${name}.raw`);
  const want = N * N * stride;
  if (b.length !== want) throw new Error(`${name}: ${b.length} bytes, expected ${want}`);
  return b;
};
// Which columns to cut. A before/after of one engine is as useful as the full sheet and needs
// only the two frames it names, so the roster is not fixed.
const ENGINES = (process.env.ENGINES || 'ref,slug,aac,lb,cpatch').split(',');
const frames = {};
for (const e of ENGINES)
  frames[e] = { buf: load(e, e === 'ref' ? 3 : 4), stride: e === 'ref' ? 3 : 4 };

/// A magnified crop, centered on (cx, cy) in probe coordinates (y counted from the BOTTOM), written
/// top-down as a PNG expects. ZOOM is nearest-neighbour on purpose: the subject IS the pixels.
function crop(src, cx, cy, R, zoom) {
  const w = (2 * R + 1) * zoom,
    h = w;
  const out = new Uint8Array(w * h * 3);
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const sx = Math.min(N - 1, Math.max(0, cx + dx)),
        sy = Math.min(N - 1, Math.max(0, cy + dy));
      const si = (sy * N + sx) * src.stride;
      const r = src.buf[si],
        g = src.buf[si + 1],
        b = src.buf[si + 2];
      // PNG rows run top-down; the frames run bottom-up, so the row index flips here and nowhere else.
      const oy0 = (R - dy) * zoom,
        ox0 = (dx + R) * zoom;
      for (let py = 0; py < zoom; py++)
        for (let px = 0; px < zoom; px++) {
          const o = ((oy0 + py) * w + ox0 + px) * 3;
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
        }
    }
  return png(out, w, h);
}
/// The whole frame, unmagnified, for orientation.
function whole(src) {
  const out = new Uint8Array(N * N * 3);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const si = ((N - 1 - y) * N + x) * src.stride,
        o = (y * N + x) * 3;
      out[o] = src.buf[si];
      out[o + 1] = src.buf[si + 1];
      out[o + 2] = src.buf[si + 2];
    }
  return png(out, N, N);
}

const SITES = JSON.parse(process.env.SITES || '[]');
const manifest = { n: N, engines: ENGINES, whole: {}, sites: [] };
for (const e of ENGINES) {
  const f = `whole_${e}.png`;
  writeFileSync(`${DST}/${f}`, whole(frames[e]));
  manifest.whole[e] = f;
}
for (const s of SITES) {
  const row = {
    name: s.name,
    x: s.x,
    y: s.y,
    r: s.r || 20,
    zoom: s.zoom || 10,
    note: s.note || '',
    img: {},
  };
  for (const e of ENGINES) {
    const f = `site_${s.name.replace(/[^a-z0-9]+/gi, '_')}_${e}.png`;
    writeFileSync(`${DST}/${f}`, crop(frames[e], s.x, s.y, row.r, row.zoom));
    row.img[e] = f;
  }
  manifest.sites.push(row);
}
writeFileSync(`${DST}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(
  `wrote ${ENGINES.length} whole frames and ${SITES.length} sites x ${ENGINES.length} crops to ${DST}`,
);

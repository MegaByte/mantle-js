// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterLinearRenderSmoke -- color-interpolation-filters: the linearRGB default (Filter Effects 1 §15.8), the property on the filter
// and on each primitive (inherited, overridden), chains that change space, and CSS filter functions (always sRGB) match Chrome. Each cell
// (test/_filterLinearCases.mjs) is a 64-unit cell drawn at 128 px by Mantle and by Chrome's own SVG engine at 8x, box-averaged; pixels on an
// edge of the Chrome picture are not scored in the first number, every pixel in the second.
//
//   FL_ONLY=lin-,mix-   run only the cells whose id starts with one of the prefixes (or equals one id)
//   FL_ROUTES=none      the fill routes to draw the source with (default both: 'none' = cover quads, 'lb' = the unified Loop-Blinn route)
//   FL_OUT=file         write every cell's numbers as JSON; FL_DUMP=dir a PNG per cell (Mantle | Chrome | |difference| x4)
import { writeFileSync, mkdirSync } from 'fs';
import zlib from 'zlib';
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';
import { CASES } from './_filterLinearCases.mjs';

const W = 128,
  H = 128;
// FS_DUMP=dir: a PNG per cell, Mantle | Chrome 8x | |difference| x4.
function pngOf(w, h, rgba) {
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type),
      len = Buffer.alloc(4),
      c = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function dump(dir, id, a, b, w = W, h = H) {
  mkdirSync(dir, { recursive: true });
  const out = new Uint8Array(w * 3 * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let k = 0; k < 4; k++) {
        const i = (y * w + x) * 4 + k,
          o = (y * w * 3 + x) * 4 + k;
        out[o] = k === 3 ? 255 : a[i];
        out[o + w * 4] = k === 3 ? 255 : b[i];
        out[o + 2 * w * 4] = k === 3 ? 255 : Math.min(255, Math.abs(a[i] - b[i]) * 4);
      }
  writeFileSync(dir + '/' + id + '.png', pngOf(w * 3, h, out));
}
let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const only = process.env.FL_ONLY ? process.env.FL_ONLY.split(',') : null;
const ROUTES = process.env.FL_ROUTES ? process.env.FL_ROUTES.split(',') : ['none', 'lb'];
const ref = await openChrome8Ref(launchBrowser);
const results = {};
try {
  for (const route of ROUTES)
    for (const [cid, svg, bound] of CASES) {
      if (only && !only.some((p) => cid === p || cid.startsWith(p))) continue;
      const id = ROUTES.length > 1 ? `${cid}@${route}` : cid;
      const r = await ref.render(svg, { w: W, h: H, route, importOpts: bound.importOpts || null });
      if (process.env.FL_DUMP) dump(process.env.FL_DUMP, id, r.mantle, r.chrome);
      const tol = bound.tol ?? 8;
      const s = compare(r.mantle, r.chrome, W, H, { tol, edge: r.chrome });
      const meanB = bound.mean ?? 1.5,
        overB = bound.over ?? 30;
      // Every pixel too, edges included: a wrong conversion at a partial-alpha edge (the fringe of a merge) shows only there.
      const all = compare(r.mantle, r.chrome, W, H, { tol });
      const allB = bound.meanAll ?? 2.5;
      const line = `${id}: mean ${s.mean.toFixed(2)} max ${s.max} over ${s.over}/${s.n} (bounds ${meanB} / ${overB}); all-pixel mean ${all.mean.toFixed(2)} (bound ${allB})`;
      const bad = !(s.mean <= meanB && s.over <= overB && all.mean <= allB);
      results[id] = {
        mean: +s.mean.toFixed(3),
        max: s.max,
        over: s.over,
        n: s.n,
        meanAll: +all.mean.toFixed(3),
      };
      if (bad) fail(line);
      else console.log('ok ' + line);
    }
} catch (e) {
  fail('setup: ' + ((e && e.stack) || e));
}
for (const m of ref.pageErrors) fail('page: ' + m);
await ref.close();
if (process.env.FL_OUT) writeFileSync(process.env.FL_OUT, JSON.stringify(results, null, 1));
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nfilterLinearRenderSmoke: color-interpolation-filters (the linearRGB default, per-primitive spaces, sRGB CSS functions) matches Chrome',
);

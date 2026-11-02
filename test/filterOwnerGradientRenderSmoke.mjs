// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterOwnerGradientRenderSmoke -- the FillPaint and StrokePaint inputs when the owner's paint is a GRADIENT (linear or radial, objectBoundingBox
// or userSpaceOnUse, spread pad / reflect / repeat, gradientTransform, stops with alpha), per Filter Effects 1: the paint server over the filter region,
// at infinite extent. Chrome has no FillPaint, so every cell (test/_filterOwnerGradientCases.mjs) carries a reference Chrome renders: the element itself
// for `FillPaint in SourceAlpha`, or the same filter on an <feImage> of the paint server over the region. Scored like filterLinearRenderSmoke (Chrome at 8x,
// box-averaged; non-edge pixels, then every pixel). Then a cell authored at 2^-20 and 2^20 times the size must come out the same as at scale 1.
//
//   FOG_ONLY=lin-,blur   run only the cells whose id starts with one of the prefixes
//   FOG_ROUTES=none      the fill routes to draw the source with (default both: 'none' = cover quads, 'lb' = the unified Loop-Blinn route)
//   FOG_OUT=file         write every cell's numbers as JSON; FOG_DUMP=dir a PNG per cell (Mantle | Chrome | |difference| x4)
import { writeFileSync, mkdirSync } from 'fs';
import zlib from 'zlib';
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';
import { CELLS, cellSvgs } from './_filterOwnerGradientCases.mjs';

const W = 128,
  H = 128;
// FOG_DUMP=dir: a PNG per cell, Mantle | Chrome 8x | |difference| x4.
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
const only = process.env.FOG_ONLY ? process.env.FOG_ONLY.split(',') : null;
const ROUTES = process.env.FOG_ROUTES ? process.env.FOG_ROUTES.split(',') : ['none', 'lb'];
const ref = await openChrome8Ref(launchBrowser);
const results = {};
try {
  for (const route of ROUTES)
    for (const c of CELLS) {
      if (only && !only.some((p) => c.id.startsWith(p))) continue;
      const id = `${c.id}@${route}`;
      const { mantle, chrome } = cellSvgs(c);
      const r = await ref.render(mantle, { w: W, h: H, route, chromeSvg: chrome });
      if (process.env.FOG_DUMP) dump(process.env.FOG_DUMP, id, r.mantle, r.chrome);
      const s = compare(r.mantle, r.chrome, W, H, { tol: 8, edge: r.chrome });
      const all = compare(r.mantle, r.chrome, W, H, { tol: 8 });
      const meanB = c.mean ?? 1.5,
        overB = c.over ?? 30,
        allB = c.meanAll ?? (c.ref === 'plain' ? 6 : 2.5);
      // (a cell whose picture is flat white would pass anything: the reference must have ink)
      let ink = 0;
      for (let i = 0; i < W * H; i++)
        if (r.chrome[i * 4] < 240 || r.chrome[i * 4 + 1] < 240 || r.chrome[i * 4 + 2] < 240) ink++;
      // A 'plain' cell is also held to Mantle's own unfiltered picture of the element, which has no antialiasing difference with Chrome in it.
      let self = null;
      if (c.ref === 'plain') {
        const u = await ref.render(chrome, { w: W, h: H, route });
        self = compare(r.mantle, u.mantle, W, H, { tol: 4 });
      }
      const line =
        `${id}: mean ${s.mean.toFixed(2)} max ${s.max} over ${s.over}/${s.n} (bounds ${meanB} / ${overB}); all-pixel mean ${all.mean.toFixed(2)} (bound ${allB}); ink ${ink}` +
        (self
          ? `; vs the unfiltered element: mean ${self.mean.toFixed(3)} max ${self.max} over ${self.over}`
          : '');
      results[id] = {
        mean: +s.mean.toFixed(3),
        max: s.max,
        over: s.over,
        n: s.n,
        meanAll: +all.mean.toFixed(3),
        ink,
      };
      if (
        ink < 400 ||
        !(s.mean <= meanB && s.over <= overB && all.mean <= allB) ||
        (self && !(self.mean <= 0.5 && self.over <= 60))
      )
        fail(line);
      else console.log('ok ' + line);
    }
  // scale: the same cell re-authored at 2^-20 and 2^20 times the size, against the scale-1 render
  for (const route of ROUTES)
    for (const cid of ['lin-obb', 'radial-focal-reflect', 'blur']) {
      if (only && !only.some((p) => cid.startsWith(p))) continue;
      const c = CELLS.find((x) => x.id === cid);
      const base = await ref.render(cellSvgs(c).mantle, { w: W, h: H, route });
      for (const s of [2 ** -20, 2 ** 20]) {
        const r = await ref.render(cellSvgs(c, s).mantle, { w: W, h: H, route });
        const d = compare(r.mantle, base.mantle, W, H, { tol: 3 });
        let ink = 0;
        for (let i = 0; i < W * H; i++)
          if (
            base.mantle[i * 4] < 240 ||
            base.mantle[i * 4 + 1] < 240 ||
            base.mantle[i * 4 + 2] < 240
          )
            ink++;
        const id = `scale-${cid}@${route}@${s === 1 ? 1 : s < 1 ? '2^-20' : '2^20'}`;
        const line = `${id}: vs scale 1 mean ${d.mean.toFixed(3)} max ${d.max} over ${d.over}`;
        results[id] = { mean: +d.mean.toFixed(4), max: d.max, over: d.over };
        if (ink < 400 || !(d.mean <= 0.3 && d.over <= 40)) fail(line + ` ink ${ink}`);
        else console.log('ok ' + line);
      }
    }
} catch (e) {
  fail('setup: ' + ((e && e.stack) || e));
}
for (const m of ref.pageErrors) fail('page: ' + m);
await ref.close();
if (process.env.FOG_OUT) writeFileSync(process.env.FOG_OUT, JSON.stringify(results, null, 1));
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nfilterOwnerGradientRenderSmoke: gradient FillPaint / StrokePaint match Chrome (the element itself, or the same filter on an feImage of the paint) at any scale',
);

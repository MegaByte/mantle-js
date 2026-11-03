// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// basicShapeClipRenderSmoke -- CSS basic-shape clip-path (inset(), circle(), ellipse(), polygon(), path(), rect(), xywh(), with
// reference boxes) and clip-path on a nested <svg> match Chrome. Each cell (test/_basicShapeClipCases.mjs) is a
// 64-unit cell drawn at 128 px by Mantle and by Chrome's own SVG engine at 8x, box-averaged; pixels on an edge of the Chrome
// picture are not scored, and the all-pixel mean is bounded too (an 8x average has true coverage on a ramp). A cell with a control
// must also equal the plain userSpaceOnUse <clipPath> it stands for, to 3 levels. `scales` cells run again at 64 and 256 px.
//
//   BS_ONLY=circle-,inset   run only the cells whose id starts with one of the prefixes (or equals one id)
//   BS_ROUTES=none          fill routes to draw with (default both: 'none' = cover quads, 'lb' = the unified Loop-Blinn route)
//   BS_OUT=file             write every cell's numbers as JSON
import { writeFileSync, mkdirSync } from 'fs';
import zlib from 'zlib';
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';
import { CASES, CONTROLS } from './_basicShapeClipCases.mjs';

// BS_DUMP=dir: a PNG per cell, Mantle | Chrome 8x | |difference| x4.
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
function dump(dir, id, a, b, w = 128, h = 128) {
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
const W = 128,
  H = 128;
let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const only = process.env.BS_ONLY ? process.env.BS_ONLY.split(',') : null;
const ROUTES = process.env.BS_ROUTES ? process.env.BS_ROUTES.split(',') : ['none', 'lb'];
const ref = await openChrome8Ref(launchBrowser);
const results = {};
try {
  for (const route of ROUTES)
    for (const [cid, svg, bound] of CASES) {
      if (only && !only.some((p) => cid === p || cid.startsWith(p))) continue;
      const id = ROUTES.length > 1 ? `${cid}@${route}` : cid;
      const r = await ref.render(svg, { w: W, h: H, route, importOpts: bound.opts || null });
      if (process.env.BS_DUMP) dump(process.env.BS_DUMP, id, r.mantle, r.chrome);
      const tol = bound.tol ?? 8,
        meanB = bound.mean ?? 1.5,
        overB = bound.over ?? 30,
        allB = bound.meanAll ?? 2.5;
      const s = compare(r.mantle, r.chrome, W, H, { tol, edge: r.chrome });
      const all = compare(r.mantle, r.chrome, W, H, { tol });
      let line = `${id}: mean ${s.mean.toFixed(2)} max ${s.max} over ${s.over}/${s.n} (bounds ${meanB} / ${overB}); all-pixel mean ${all.mean.toFixed(2)} (bound ${allB})`;
      let bad = bound.spec ? false : !(s.mean <= meanB && s.over <= overB && all.mean <= allB);
      if (bound.spec) line += ' [spec cell: Chrome is reported, not scored]';
      if (CONTROLS[cid]) {
        const c = await ref.render(CONTROLS[cid], { w: W, h: H, route });
        const cs = compare(r.mantle, c.mantle, W, H, { tol: 3 });
        line += `; control max ${cs.max} over ${cs.over}`;
        if (cs.max > 3) bad = true;
      } else if (bound.spec) {
        line += ' -- a spec cell needs a control';
        bad = true;
      }
      results[id] = {
        mean: +s.mean.toFixed(3),
        max: s.max,
        over: s.over,
        meanAll: +all.mean.toFixed(3),
      };
      if (bad) fail(line);
      else console.log('ok ' + line);
      if (bound.scales)
        for (const size of [64, 256]) {
          const rs = await ref.render(svg, {
            w: size,
            h: size,
            route,
            importOpts: bound.opts || null,
          });
          const ss = compare(rs.mantle, rs.chrome, size, size, { tol, edge: rs.chrome });
          const ob = Math.ceil(overB * (size / W) ** 2 * 2);
          const l2 = `${id} at ${size}px: mean ${ss.mean.toFixed(2)} max ${ss.max} over ${ss.over}/${ss.n} (bounds ${meanB} / ${ob})`;
          results[id + '#' + size] = { mean: +ss.mean.toFixed(3), max: ss.max, over: ss.over };
          if (!(ss.mean <= meanB && ss.over <= ob)) fail(l2);
          else console.log('ok ' + l2);
        }
    }
} catch (e) {
  fail('setup: ' + ((e && e.stack) || e));
}
for (const m of ref.pageErrors) fail('page: ' + m);
await ref.close();
if (process.env.BS_OUT) writeFileSync(process.env.BS_OUT, JSON.stringify(results, null, 1));
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nbasicShapeClipRenderSmoke: basic-shape clip-path and nested-svg clip-path match Chrome',
);

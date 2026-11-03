// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterSubregionRenderSmoke -- primitive subregions (x / y / width / height on a filter primitive), primitiveUnits="objectBoundingBox"
// and CSS filter functions / filter lists match Chrome. Each cell (test/_filterSubregionCases.mjs) is a 64-unit cell drawn
// at 128 px by Mantle and by Chrome's own SVG engine at 8x, box-averaged; pixels on an edge of the Chrome picture are not scored. A cell
// with a control is also drawn from an equivalent plain construction (user units, an ordinary filter) and must equal it to 3 levels.
//
//   FS_ONLY=s-,p-   run only the cells whose id starts with one of the prefixes (or equals one id)
//   FS_ROUTES=none  the fill routes to draw the source with (default both: 'none' = cover quads, 'lb' = the unified Loop-Blinn route)
//   FS_OUT=file     write every cell's numbers as JSON
import { writeFileSync, mkdirSync } from 'fs';
import zlib from 'zlib';
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';
import { CASES, CONTROLS } from './_filterSubregionCases.mjs';

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
const only = process.env.FS_ONLY ? process.env.FS_ONLY.split(',') : null;
const ROUTES = process.env.FS_ROUTES ? process.env.FS_ROUTES.split(',') : ['none', 'lb'];
const ref = await openChrome8Ref(launchBrowser);
const results = {};
try {
  for (const route of ROUTES)
    for (const [cid, svg, bound] of CASES) {
      if (only && !only.some((p) => cid === p || cid.startsWith(p))) continue;
      const id = ROUTES.length > 1 ? `${cid}@${route}` : cid;
      const r = await ref.render(svg, { w: W, h: H, route, importOpts: bound.opts || null });
      if (process.env.FS_DUMP) dump(process.env.FS_DUMP, id, r.mantle, r.chrome);
      const tol = bound.tol ?? 8;
      const s = bound.exact1x
        ? compare(r.mantle, r.chrome1, W, H, { tol })
        : compare(r.mantle, r.chrome, W, H, { tol, edge: r.chrome });
      const meanB = bound.mean ?? 1.5,
        overB = bound.over ?? 30;
      // Every pixel too, edges included (an 8x box average has true coverage on a ramp, so a wrong blur width shows even where the picture is never flat).
      const all = compare(r.mantle, r.chrome, W, H, { tol });
      const allB = bound.meanAll ?? 2.5;
      let line = `${id}: mean ${s.mean.toFixed(2)} max ${s.max} over ${s.over}/${s.n} (bounds ${meanB} / ${overB}); all-pixel mean ${all.mean.toFixed(2)} (bound ${allB})`;
      // { spec: true }: the default import is held to its literal control (below), not to Chrome, which departs from the spec text here; Chrome's
      // difference is only reported. { opts: { compat: 'chrome' } } cells are Chrome-parity cells.
      let bad = bound.spec
        ? false
        : !(s.mean <= meanB && s.over <= overB && (bound.exact1x || all.mean <= allB));
      if (bound.spec) line += ' [spec cell: Chrome is reported, not scored]';
      const res = {
        mean: +s.mean.toFixed(3),
        max: s.max,
        over: s.over,
        n: s.n,
        meanAll: +all.mean.toFixed(3),
      };
      if (CONTROLS[cid]) {
        const c = await ref.render(CONTROLS[cid], { w: W, h: H, route, chrome: false });
        const cs = compare(r.mantle, c.mantle, W, H, { tol: 3 });
        line += `; control max ${cs.max} over ${cs.over}`;
        res.controlMax = cs.max;
        res.controlOver = cs.over;
        if (cs.max > 3) bad = true;
      } else if (bound.spec) {
        line += ' -- a spec cell needs a control';
        bad = true;
      }
      results[id] = res;
      if (bad) fail(line);
      else console.log('ok ' + line);
      // Correct at any scale: the same cell on a canvas half and twice the size (the subregion, the units and the blur all follow the device scale).
      if (bound.scales)
        for (const size of [64, 256]) {
          const rs = await ref.render(svg, {
            w: size,
            h: size,
            route,
            importOpts: bound.opts || null,
          });
          if (process.env.FS_DUMP)
            dump(process.env.FS_DUMP, `${id}-${size}`, rs.mantle, rs.chrome, size, size);
          const ss = compare(rs.mantle, rs.chrome, size, size, { tol, edge: rs.chrome });
          const k = (size / W) ** 2,
            ob = Math.ceil(overB * k * 2);
          const l2 = `${id} at ${size}px: mean ${ss.mean.toFixed(2)} max ${ss.max} over ${ss.over}/${ss.n} (bounds ${meanB} / ${ob})`;
          results[id + '#' + size] = {
            mean: +ss.mean.toFixed(3),
            max: ss.max,
            over: ss.over,
            n: ss.n,
          };
          if (!(ss.mean <= meanB && ss.over <= ob)) fail(l2);
          else console.log('ok ' + l2);
        }
    }
} catch (e) {
  fail('setup: ' + ((e && e.stack) || e));
}
for (const m of ref.pageErrors) fail('page: ' + m);
await ref.close();
if (process.env.FS_OUT) writeFileSync(process.env.FS_OUT, JSON.stringify(results, null, 1));
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nfilterSubregionRenderSmoke: primitive subregions, primitiveUnits and CSS filters match Chrome',
);

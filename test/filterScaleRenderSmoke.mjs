// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterScaleRenderSmoke -- a filter's lengths follow the REFERENCING ELEMENT's transform. SVG 1.1 section 15.7 / Filter Effects 1
// section 3.2: with userSpaceOnUse units the filter works in the user coordinate system of the element that references it, which includes
// that element's transform; a blur under transform="scale(2)" reaches twice as far in device space, under scale(2 1) it is an ellipse, and
// under a turn or skew it follows the element's own axes. The same holds for dx / dy, radius, scale, light positions and baseFrequency,
// for a group, an element, a <use> instance and CSS filter functions. Each cell (test/_filterScaleCases.mjs) is drawn at 128 px by Mantle
// and by Chrome's own SVG engine at 8x, box-averaged, and scored on every pixel (a wrong blur width shows on a ramp).
//
//   FSC_ONLY=g.blur.,el.   run only the cells whose id starts with one of the prefixes (id = variant.prim.transform, css.fn.transform)
//   FSC_ROUTES=none        the fill routes to draw the source with (default none; 'lb' = unified Loop-Blinn)
//   FSC_OUT=file           write every cell's numbers as JSON
//   FSC_REPORT=1           report every cell and never fail (to survey a tree that is expected to fail)
import { writeFileSync, mkdirSync } from 'fs';
import zlib from 'zlib';
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';
import { TRANSFORMS, PRIMS, VARIANTS, CSS, IMAGES } from './_filterScaleCases.mjs';

const W = 128,
  H = 128;
// FSC_DUMP=dir: a PNG per cell, Mantle | Chrome 8x | |difference| x4.
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
const only = process.env.FSC_ONLY ? process.env.FSC_ONLY.split(',') : null;
const ROUTES = process.env.FSC_ROUTES ? process.env.FSC_ROUTES.split(',') : ['none'];
const report = process.env.FSC_REPORT === '1';
// Per-primitive bounds on the all-pixel mean (levels). Lights and noise differ from Chrome by their own residuals, so they get their own.
// A lit surface under a transform that is not a similarity is shaded by Chrome in a layer scaled by the axis lengths and then turned or sheared; Mantle
// shades in device space (exact for a scale and a turn, an approximation under a skew), so lights get a wider bound there.
const BOUND = {
  default: 2.5,
  lightPoint: 4.5,
  lightSpot: 4,
  lightDistant: 4,
  displace: 4,
  turbulence: 4,
  feImage: 3,
};
const boundFor = (id, pn) =>
  /^light/.test(pn) && /\.skew/.test(id) ? 9 : (BOUND[pn] ?? BOUND.default);
const CELLS = [];
// Not scored: a primitive subregion (feTile's tile, an feImage placement) that a turn or skew carries to a parallelogram clips to its axis-aligned bound
// here (the filter region has always done the same), and Chrome draws a lit surface opaque black under a mirroring transform (negative determinant).
const SKIP = (pn, tn) =>
  ((pn === 'tile' || pn === 'feImage') && /^(rot|rotAniso|skew)$/.test(tn)) ||
  (/^light/.test(pn) && tn === 'flip');
for (const [tn, t] of Object.entries(TRANSFORMS))
  for (const pn of Object.keys(PRIMS))
    if (!SKIP(pn, tn)) CELLS.push([`g.${pn}.${tn}`, VARIANTS.g(t, PRIMS[pn]), pn]);
for (const vn of ['el', 'useIn', 'useEl', 'nested'])
  for (const pn of ['blur', 'two', 'lightPoint', 'morphDilate'])
    for (const tn of ['s2', 's21', 'rot', 'skew'])
      CELLS.push([`${vn}.${pn}.${tn}`, VARIANTS[vn](TRANSFORMS[tn], PRIMS[pn]), pn]);
for (const [fn, mk] of Object.entries(CSS))
  for (const tn of ['id', 's2', 's21', 'rot'])
    CELLS.push([`css.${fn}.${tn}`, mk(TRANSFORMS[tn]), fn]);

// (An override on a GROUP id is not addressable on a filtered group: a group marker row has no id.)
// An OVERRIDE that scales a filtered row acts as a transform of the element (Mantle's runtime transform of a shape): the filter's lengths follow
// it, as they follow a transform attribute. [id, Mantle svg, override sets, Chrome svg with the same transform written out].
const OREG =
  'filterUnits="userSpaceOnUse" x="-60" y="-60" width="120" height="120" color-interpolation-filters="sRGB"';
const odoc = (body, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/><defs><filter id="f" ${OREG}>${inner}</filter></defs>${body}</svg>`;
const RECT = (extra) =>
  `<rect ${extra} x="-16" y="-16" width="32" height="32" fill="#e04020" filter="url(#f)"/>`;
const OVR = [];
for (const [on, inner] of [
  ['blur', '<feGaussianBlur stdDeviation="2"/>'],
  ['two', '<feGaussianBlur stdDeviation="1.5" result="b"/><feOffset in="b" dx="4" dy="3"/>'],
  ['morph', '<feMorphology operator="dilate" radius="2 1"/>'],
]) {
  for (const [sn, sc] of [
    ['s2', [2, 2]],
    ['s21', [2, 1]],
    ['s12', [0.5, 1.5]],
  ]) {
    OVR.push([
      `ovr.rect.${on}.${sn}`,
      odoc(`<g transform="translate(32 32)">${RECT('id="a"')}</g>`, inner),
      [['a', { localScale: sc, localPosition: [32 - 32 * sc[0], 32 - 32 * sc[1]] }]],
      odoc(`<g transform="translate(32 32) scale(${sc[0]} ${sc[1]})">${RECT('')}</g>`, inner),
      on,
    ]);
  }
}

for (const [fn, mk] of Object.entries(IMAGES))
  for (const tn of ['id', 's2', 's21', 'rot'])
    CELLS.push([`img.${fn}.${tn}`, mk(TRANSFORMS[tn]), fn]);

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const ref = await openChrome8Ref(launchBrowser);
const results = {};
try {
  for (const route of ROUTES)
    for (const [cid, svg, pn] of CELLS) {
      if (only && !only.some((p) => cid === p || cid.startsWith(p))) continue;
      const id = ROUTES.length > 1 ? `${cid}@${route}` : cid;
      const r = await ref.render(svg, { w: W, h: H, route });
      if (process.env.FSC_DUMP) dump(process.env.FSC_DUMP, id, r.mantle, r.chrome);
      const all = compare(r.mantle, r.chrome, W, H, { tol: 8 });
      const flat = compare(r.mantle, r.chrome, W, H, { tol: 8, edge: r.chrome });
      const bound = boundFor(cid, pn);
      results[id] = {
        meanAll: +all.mean.toFixed(3),
        maxAll: all.max,
        meanFlat: +flat.mean.toFixed(3),
      };
      const line = `${id}: all-pixel mean ${all.mean.toFixed(2)} max ${all.max}; non-edge mean ${flat.mean.toFixed(2)} (bound ${bound})`;
      if (all.mean > bound && !report) fail(line);
      else console.log((all.mean > bound ? 'BAD ' : 'ok ') + line);
    }
  for (const route of ROUTES)
    for (const [cid, svg, sets, csvg, pn] of OVR) {
      if (only && !only.some((p) => cid === p || cid.startsWith(p))) continue;
      const id = ROUTES.length > 1 ? `${cid}@${route}` : cid;
      const r = await ref.render(svg, { w: W, h: H, route, overrideSets: sets, chromeSvg: csvg });
      if (process.env.FSC_DUMP) dump(process.env.FSC_DUMP, id, r.mantle, r.chrome);
      const all = compare(r.mantle, r.chrome, W, H, { tol: 8 });
      const bound = boundFor(cid, pn);
      results[id] = { meanAll: +all.mean.toFixed(3), maxAll: all.max };
      const line = `${id}: all-pixel mean ${all.mean.toFixed(2)} max ${all.max} (bound ${bound})`;
      if (all.mean > bound && !report) fail(line);
      else console.log((all.mean > bound ? 'BAD ' : 'ok ') + line);
    }
} catch (e) {
  fail('setup: ' + ((e && e.stack) || e));
}
for (const m of ref.pageErrors) fail('page: ' + m);
await ref.close();
if (process.env.FSC_OUT) writeFileSync(process.env.FSC_OUT, JSON.stringify(results, null, 1));
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nfilterScaleRenderSmoke: filter lengths follow the referencing element transform and match Chrome',
);

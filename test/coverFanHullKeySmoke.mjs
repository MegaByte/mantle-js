// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coverFanHullKeySmoke -- the cover-fan hull cache names everything but the translation, and a far copy leaves it nothing rounded.
//
// (1) A key that holds the variation coordinates through JSON.stringify writes every non-finite number as null: +Infinity and -Infinity on an axis are two outlines and would be one key, so the heavy glyph
// would get the light glyph's hull, a fan smaller than the glyph it covers. (2) The first copy's hull is stored relative to its pen, and at a pen far out for the glyph's size its coordinates have already
// rounded: a copy near the origin must not inherit that hull (up to 7.8e-3 of the glyph's em inside the outline, a scale-dependent loss). CPU.
import { getCoverFanVerts } from '../src/svg/mesh.js';
import { transformAndFlip } from '../src/font/textColrEmit.js';
import { buildStyled } from '../src/font/textRun.js';
import { defaultStyle } from '../src/font/markupParser.js';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// A stand-in font is all the assembly needs to reach the key: a glyph whose outline follows the 'wght' axis's sign, as a clamped axis does. It is the key that is under test, not the variation code.
const outline = (w) => [
  [0, 0],
  [100 + w, 0],
  [50, 700],
]; // (a triangle: a shape that fills its box takes the box, not a fan)
const segsOf = (pts) =>
  pts.map((p, i) => ({ type: 0, p1: p, p2: pts[(i + 1) % pts.length], is_fill_only: false }));
const { MantleFontAsset } = await import('../src/font/fontAsset.js');
const { readFileSync } = await import('node:fs');
const font = new MantleFontAsset(
  new Uint8Array(readFileSync(new URL('./fixtures/fonts/jstfPriorities.ttf', import.meta.url))),
);
const realSegs = font.getGlyphSegsByGidVar.bind(font);
font.getGlyphSegsByGidVar = (gid, coords) =>
  coords && 'wght' in coords ? segsOf(outline(coords.wght > 0 ? 500 : 0)) : realSegs(gid, coords);
const fansOf = (raw) => {
  const f = raw.curveGeomFloats,
    out = [];
  let i = 0;
  while (i < f.length) {
    const nv = f[i];
    const v = [];
    let j = i + 12;
    for (let k = 0; k < nv; k++, j += 12) v.push(f[j]);
    out.push(Math.max(...v));
    i = j;
  }
  return out;
};
const span = (text) => [{ text, style: { ...defaultStyle(), color: [0, 0, 0, 1] } }];
{
  const light = fansOf(await buildStyled(span('a'), font, { varCoords: { wght: -Infinity } }));
  const heavy = fansOf(await buildStyled(span('a'), font, { varCoords: { wght: Infinity } }));
  const lw = Math.max(...light),
    hw = Math.max(...heavy);
  ok(
    hw > lw,
    `+Infinity and -Infinity on an axis are two hulls: the fan's right edge ${hw.toFixed(4)} against ${lw.toFixed(4)} em`,
  );
}

// (2) The hull of a copy far out for its size stays out of the cache.
const box = (segs) => {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of segs)
    for (const p of [s.p1, s.p2, s.p3, s.p4])
      if (p) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
  return (x1 - x0) * (y1 - y0);
};
const A = [
  [0, 0],
  [1000, 0],
  [1400, 1400],
  [500, 2000],
  [0, 1000],
  [300, 500],
];
const SRC = [];
for (let i = 0; i < A.length; i++)
  SRC.push({
    type: 1,
    p1: A[i],
    p2: [
      (A[i][0] + A[(i + 1) % A.length][0]) / 2 + 50,
      (A[i][1] + A[(i + 1) % A.length][1]) / 2 - 50,
    ],
    p3: A[(i + 1) % A.length],
    is_fill_only: false,
  });
const uniq = (fan) => {
  const o = [];
  for (let k = 0; k < fan.length; k += 2)
    if (!o.some((q) => q[0] === fan[k][0] && q[1] === fan[k][1])) o.push(fan[k]);
  const cx = o.reduce((a, q) => a + q[0], 0) / o.length,
    cy = o.reduce((a, q) => a + q[1], 0) / o.length;
  return o.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
};
const outside = (P, p) => {
  let w = -Infinity;
  for (let i = 0; i < P.length; i++) {
    const a = P[i],
      b = P[(i + 1) % P.length],
      dx = b[0] - a[0],
      dy = b[1] - a[1],
      L = Math.hypot(dx, dy);
    if (L > 0) w = Math.max(w, ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L);
  }
  return w;
};
const run = (size, t0, t1) => {
  const cache = new Map(),
    s = size / 2048;
  const a = transformAndFlip(SRC, t0, t0 * 0.5, s, s, 0, 0);
  getCoverFanVerts(a, box(a), { cache, key: 'k', tx: t0, ty: t0 * 0.5 });
  const b = transformAndFlip(SRC, t1, t1 * 0.5, s, s, 0, 0);
  const shared = getCoverFanVerts(b, box(b), { cache, key: 'k', tx: t1, ty: t1 * 0.5 });
  if (!shared) return { fan: false, fresh: !!getCoverFanVerts(b, box(b)) };
  const P = uniq(shared);
  let w = -Infinity;
  for (const seg of b)
    for (let t = 0; t <= 1; t += 1 / 16) {
      // the outline itself: a control point may lie past the hull of the curve
      const u = 1 - t,
        x = u * u * seg.p1[0] + 2 * u * t * seg.p2[0] + t * t * seg.p3[0],
        y = u * u * seg.p1[1] + 2 * u * t * seg.p2[1] + t * t * seg.p3[1];
      w = Math.max(w, outside(P, [Math.fround(x), Math.fround(y)]));
    }
  return { fan: true, w, inCache: cache.size };
};
for (const size of [1e-6, 1e-3, 1, 1e3, 1e6])
  for (const ratio of [1e3, 1e6, 1e9, 1e12, 1e15]) {
    const r = run(size, size * ratio, 0);
    // relative to the shape: the same answer at every size is the point
    if (!r.fan)
      ok(
        !r.fresh,
        `size ${size}, first copy at ${ratio} sizes out, reused at 0: a fresh copy has no fan either`,
      );
    else
      ok(
        !(r.w > 0),
        `size ${size}, first copy at ${ratio} sizes out, reused at 0: the outline stays inside the fan (worst outside ${r.w > 0 ? (r.w / size).toExponential(1) + ' of the size' : 'none'})`,
      );
  }
{
  const r = run(1, 1e12, 0);
  ok(
    r.inCache === 1,
    'and the near copy leaves its hull behind: the far copy left none in its way',
  );
  const cache = new Map(),
    near = transformAndFlip(SRC, 10, 5, 1 / 2048, 1 / 2048, 0, 0);
  getCoverFanVerts(near, box(near), { cache, key: 'k', tx: 10, ty: 5 });
  ok(cache.size === 1, 'a copy at an ordinary pen does store its hull');
  const stored = cache.get('k');
  const far = transformAndFlip(SRC, 3e7, 1.5e7, 1 / 2048, 1 / 2048, 0, 0);
  getCoverFanVerts(far, box(far), { cache, key: 'k', tx: 3e7, ty: 1.5e7 });
  ok(cache.get('k') === stored, 'and a far copy reuses it and leaves it as it was');
}
console.log(fail ? `coverFanHullKeySmoke: ${fail} FAILED` : 'coverFanHullKeySmoke: PASS');
process.exit(fail ? 1 : 0);

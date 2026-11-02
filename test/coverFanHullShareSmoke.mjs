// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coverFanHullShareSmoke -- a glyph's cover-fan hull is computed once and reused for every copy, and the fan a copy gets still contains that copy.
//
// A passage re-flowed in play spent 40% of its rebuild recomputing hulls. Pinned on glyph-shaped outlines at many pens, near and far from the origin:
// the cache holds one hull per key; a shared fan matches a fresh one within the float32 push; the float32 push stays per copy (it depends on where the copy lands), so every outline point
// is inside the shared fan's polygon; a null answer (a shape with no hull) is cached too; different keys do not collide.
import { getCoverFanVerts } from '../src/svg/mesh.js';
import { transformAndFlip } from '../src/font/textColrEmit.js';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const L = 0,
  Q = 1;
const line = (a, b) => ({ type: L, p1: a, p2: b, is_fill_only: false });
const quad = (a, c, b) => ({ type: Q, p1: a, p2: c, p3: b, is_fill_only: false });
const TRI = [line([0, 0], [1000, 0]), line([1000, 0], [500, 1400]), line([500, 1400], [0, 0])];
const BLOB = [
  quad([0, 500], [0, 1000], [500, 1000]),
  quad([500, 1000], [1000, 1000], [1000, 500]),
  quad([1000, 500], [700, 100], [500, 0]),
  quad([500, 0], [150, 100], [0, 500]),
];
const S = 1 / 2048;
const area = (segs) => {
  let x0 = 1e9,
    y0 = 1e9,
    x1 = -1e9,
    y1 = -1e9;
  for (const s of segs)
    for (const p of [s.p1, s.p2, s.p3])
      if (p) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
  return (x1 - x0) * (y1 - y0);
};
const polyOf = (fan) => {
  const v = [];
  for (let k = 0; k < fan.length; k += 2)
    if (!v.some((q) => q[0] === fan[k][0] && q[1] === fan[k][1])) v.push(fan[k]);
  return v;
};
const contains = (poly, p, eps) => {
  const c = [
    poly.reduce((a, q) => a + q[0], 0) / poly.length,
    poly.reduce((a, q) => a + q[1], 0) / poly.length,
  ];
  const o = [...poly].sort(
    (a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]),
  );
  for (let i = 0; i < o.length; i++) {
    const a = o[i],
      b = o[(i + 1) % o.length];
    if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < -eps) return false;
  }
  return true;
};

for (const [name, src] of [
  ['triangle', TRI],
  ['blob', BLOB],
]) {
  console.log(`(${name}) one hull, reused at every pen`);
  const cache = new Map();
  let worst = 0,
    inside = true,
    fans = 0;
  for (const [tx, ty] of [
    [0, 0],
    [0.37, 1.25],
    [3.5, 0.1],
    [11.2, 9.3],
    [40.125, 21.75],
    [300.5, 180.25],
  ]) {
    const segs = transformAndFlip(src, tx, ty, S, S, 0, 0),
      box = area(segs);
    const shared = getCoverFanVerts(segs, box, { cache, key: name, tx, ty }),
      fresh = getCoverFanVerts(segs, box);
    ok(!!shared === !!fresh, `pen ${tx},${ty}: the same answer whether a fan pays (${!!shared})`);
    if (!shared || !fresh) continue;
    fans++;
    const ps = polyOf(shared),
      pf = polyOf(fresh),
      mag = Math.max(Math.abs(tx), Math.abs(ty), 1);
    if (ps.length === pf.length)
      for (let i = 0; i < ps.length; i++)
        worst = Math.max(
          worst,
          Math.abs(ps[i][0] - pf[i][0]) / mag,
          Math.abs(ps[i][1] - pf[i][1]) / mag,
        );
    else worst = Infinity;
    for (const s of segs)
      for (const p of [s.p1, s.p3 || s.p2]) if (p && !contains(ps, p, 0)) inside = false;
  }
  ok(cache.size === 1, `one hull in the cache (${cache.size})`);
  ok(fans > 0, `a fan paid at some pen (${fans})`);
  ok(worst < 2 ** -19, `a shared fan matches a fresh one within the float32 push (worst ${worst})`);
  ok(inside, 'every outline point is inside the shared fan');
}
console.log('(null) a shape with no hull is remembered');
{
  const cache = new Map(),
    degenerate = [line([0, 0], [1000, 0]), line([1000, 0], [0, 0])],
    segs = transformAndFlip(degenerate, 1, 1, S, S, 0, 0);
  ok(
    getCoverFanVerts(segs, 1, { cache, key: 'd', tx: 1, ty: 1 }) === null &&
      cache.get('d') === null,
    'no fan, and the answer is cached',
  );
  ok(getCoverFanVerts(segs, 1, { cache, key: 'd', tx: 2, ty: 2 }) === null, 'and reused');
}
console.log('(keys) different keys do not collide');
{
  const cache = new Map();
  const a = transformAndFlip(TRI, 0, 0, S, S, 0, 0),
    b = transformAndFlip(TRI, 0, 0, 2 * S, 2 * S, 0, 0);
  getCoverFanVerts(a, area(a), { cache, key: 'one', tx: 0, ty: 0 });
  getCoverFanVerts(b, area(b), { cache, key: 'two', tx: 0, ty: 0 });
  ok(cache.size === 2, 'two scales, two hulls');
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');

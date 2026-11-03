// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Exercise the retained seam decomposition; complete-paint area is checked separately.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
// cpatchLensSmoke — no CPatch patch is a lens: none runs along one arc both ways, and none is narrower
// than one float32 step at its own coordinates.
//
// THE TRAP. A curve cut whose two crossings bound a stretch of the curve's own sibling -- a slice of
// the same source curve, or an extension arc an earlier cut made along it -- has E between them equal to
// that stretch, so one side comes out as the stretch and E run back along it: a lens of zero area. A patch
// lies to the left of each piece of its loop, and left of an arc run forward is the other side from left
// of it run back, so the lens's conjunction is empty and the signs its constraints take at its interior
// point (which lies on their shared zero set) are rounding. The same happens with two DIFFERENT curves a
// rounding apart -- an SVG cubic split in two and written to a few decimals, where the first half's
// extension runs back along the second -- except that the sliver between them is real, only far narrower
// than float32 can resolve. Drawn, such a patch paints whatever its rounding says: 155 px each outside
// tiger's #270/#271 at one offset. The in-tree smoke corpus holds such contours in aacBandLevels,
// lbMemBudget and the shape-animation fixtures.
//
// WHAT this PINS, over those assets, on every patch packCPatchShape hands the kernel:
//   L. no two curved pieces of a patch are sliced from the same source curve, traversed opposite ways over
//      the same stretch of it (the provenance the converter tags every piece with), and none is the
//      bit-exact reverse of another;
//   F. no curved patch has area at most 2^-24 of its own extent squared (Green's theorem, computed here on
//      its own, the conic's segment included) -- a looser bar than the converter's, which measures against
//      its frame's coordinates, so anything this flags the converter should have refused.
// A converter that packs lenses FAILS: 10 patches, in all four assets.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: importSvg } = await import('../src/svg/importer.js');
const cb = await import('../src/renderer/cpatchBuild.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
console.warn = () => {};

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const cr = (a, b) => a[0] * b[1] - a[1] * b[0];
const segRatio = (w) => {
  if (Math.abs(w - 1) < 1e-4) return 2 / 3 + (4 / 15) * (w - 1);
  if (w < 1) {
    const q = Math.sqrt(1 - w * w);
    return (w / (q * q)) * (Math.acos(w) / q - w);
  }
  const q = Math.sqrt(w * w - 1);
  return (w / (q * q)) * (w - Math.acosh(w) / q);
};
/// Twice the signed area, piece by piece (Green's theorem), joints closed with their chords.
function area2(l) {
  let a = 0;
  for (let i = 0; i < l.length; i++) {
    const g = l[i],
      P = g.P,
      Q = l[(i + 1) % l.length].P;
    a += cr(P[P.length - 1], Q[0]);
    if (g.t === 'line') a += cr(P[0], P[P.length - 1]);
    else if (g.t === 'rquad')
      a +=
        cr(P[0], P[2]) +
        segRatio(g.w == null ? 1 : g.w) *
          cr([P[1][0] - P[0][0], P[1][1] - P[0][1]], [P[2][0] - P[0][0], P[2][1] - P[0][1]]);
    else if (P.length === 3) a += (2 * (cr(P[0], P[1]) + cr(P[1], P[2])) + cr(P[0], P[2])) / 3;
    else
      a +=
        (6 * cr(P[0], P[1]) +
          3 * cr(P[0], P[2]) +
          cr(P[0], P[3]) +
          3 * cr(P[1], P[2]) +
          3 * cr(P[1], P[3]) +
          6 * cr(P[2], P[3])) /
        10;
  }
  return a;
}
function lens(l) {
  for (let i = 0; i < l.length; i++)
    for (let j = i + 1; j < l.length; j++) {
      const a = l[i],
        b = l[j];
      if (a.t === 'line' || b.t === 'line') continue;
      if (
        a.t === b.t &&
        a.P.length === b.P.length &&
        a.P.every(
          (p, k) => p[0] === b.P[b.P.length - 1 - k][0] && p[1] === b.P[b.P.length - 1 - k][1],
        )
      )
        return 'exact reverse';
      const p = a._src,
        q = b._src;
      if (!p || !q || p.k !== q.k || !((p.b - p.a) * (q.b - q.a) < 0)) continue;
      const lo = Math.max(Math.min(p.a, p.b), Math.min(q.a, q.b)),
        hi = Math.min(Math.max(p.a, p.b), Math.max(q.a, q.b));
      if (hi - lo >= 0.5 * Math.min(Math.abs(p.b - p.a), Math.abs(q.b - q.a)))
        return `source ${p.k} both ways`;
    }
  return null;
}
function thin(l) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of l)
    for (const p of c.P) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  const ext = Math.max(x1 - x0, y1 - y0);
  return Math.abs(area2(l)) * 0.5 <= 5.960464477539063e-8 * ext * ext;
}

const ASSETS = [
  'examples/smoke/aacBandLevels__SVG.svg',
  'examples/smoke/lbMemBudget__SVG.svg',
  'examples/smoke/shapeAnimationMultiCurveDiag__DST_SVG.svg',
  'examples/smoke/shapeAnimationMultiCurveRepro__DST_SVG.svg',
];
let nPatch = 0;
for (const f of ASSETS) {
  const b = cb.headlessCPatchBundle(await importSvg(readFileSync(path.join(ROOT, f), 'utf8'))),
    cf = cb.cpatchCurvePlane(b);
  const bad = [];
  for (let s = 0; s < b.curveRangesByShape.length; s++) {
    const r = b.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    let cs = null;
    try {
      cs = cb.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
    } catch {
      cs = null;
    }
    if (!cs || !cs.length) continue;
    const pats = [];
    try {
      packCPatchShape(cs, 0, {
        evenOdd: cb.shapeEvenOdd(b, s),
        onPatches: (ps) => pats.push(...ps),
      });
    } catch {
      continue;
    }
    for (const p of pats) {
      nPatch++;
      if (p.curves.every((c) => c.t === 'line')) continue;
      const why = lens(p.curves) || (thin(p.curves) ? 'narrower than a float32 step' : null);
      if (why)
        bad.push(`#${s} ${p.curves.map((c) => c.t + (c.cut ? '*' : '')).join(' ')} (${why})`);
    }
  }
  ok(
    bad.length === 0,
    `${path.basename(f)}: no lens and no sub-float32 sliver${bad.length ? ' -- ' + bad.slice(0, 4).join('; ') : ''}`,
  );
}
ok(nPatch > 2000, `and the corpus is not vacuous (${nPatch} patches)`);

console.log(fail ? `\ncpatchLensSmoke FAIL (${fail})` : '\ncpatchLensSmoke PASS');
process.exit(fail ? 1 : 0);

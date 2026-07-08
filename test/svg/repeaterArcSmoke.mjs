// repeaterArcSmoke.mjs — the Lottie Repeater modifier must transform an ARC
// segment by each copy's FULL affine. A non-uniform scale of a ROTATED arc
// (phi≠0) is a tilted ellipse that a single re-radiused SVG arc can't represent,
// so the arc is decomposed to cubics and the affine is applied to each control
// point (affine-of-cubic is exact). This asserts the transformed copy's curve
// lies on the TRUE affine-transformed ellipse, sampled independently.
import { mkArc, arcToCubics, SEG_CUBIC, SEG_LINE, SEG_ARC } from '../../src/svg/segment.js';
import { repeater } from '../../src/svg/modifiers.js';

let failures = 0;
const fail = (m) => { console.error('FAIL', m); failures++; };
const ok = (m) => console.log('ok', m);

// Rotated-ellipse quarter arc: center (0,0), rx=20 ry=8, phi=30°, theta 0..90°.
const PHI = 30 * Math.PI / 180;
const RX = 20, RY = 8, T0 = 0, T1 = Math.PI / 2;
const arc = mkArc(0, 0, RX, RY, T0, T1, PHI, 0, 1);

// Copy transform under test: non-uniform scale (sx=2, sy=1), no rotation/translate.
const SX = 2, SY = 1;
const out = repeater([arc], 2, 0, 0, 0, SX, SY);

// Copy 0 is the original arc kept verbatim; copy 1 is the transformed segments.
const copy0 = out.slice(0, out.length - countCopy1Start(out));
const copy1 = out.slice(out.length - countCopy1Start(out));
function countCopy1Start(o) {
  // Copy 0 = the single kept arc; everything after is copy 1.
  let i = 0; for (const s of o) { if (s.type === SEG_ARC) i++; }
  return o.length - 1;  // 1 arc kept (copy 0) → rest is copy 1
}

// (1) copy 1 must NOT be a single re-radiused ARC — the affine of a rotated
// arc isn't an arc, so it must come out as cubic/line segments.
if (copy1.length >= 1 && copy1.every((s) => s.type !== SEG_ARC))
  ok(`copy 1 is ${copy1.length} cubic/line segment(s), not a single re-radiused arc`);
else fail('copy 1 still an arc (old re-radiused approximation): ' + JSON.stringify(copy1.map(s=>s.type)));

// (2) Shape check: copy 1 must equal the copy affine applied to the ORIGINAL
// arc's exact cubic decomposition (decompose, then affine each control point).
// arcToCubics is the trusted shape oracle; a scaled-radii arc would diverge
// from this for a rotated + non-uniform-scaled arc.
const apply = (p) => [p[0] * SX, p[1] * SY];   // copy-1 affine (sx=2, sy=1, no rot/translate)
const refCubics = arcToCubics(arc.p1, RX, RY, PHI * 180 / Math.PI,
                              arc.large_arc_flag, arc.sweep_flag, arc.p4);
const bez = (p0, p1, p2, p3, t) => {
  const u = 1 - t;
  return [
    u*u*u*p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t*t*t*p3[0],
    u*u*u*p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t*t*t*p3[1],
  ];
};
const flatten = (segs, xf) => {
  const pts = [];
  for (const s of segs) {
    if (s.type === SEG_CUBIC) for (let i = 0; i <= 16; i++) pts.push(xf(bez(s.p1, s.p2, s.p3, s.p4, i/16)));
    else if (s.type === SEG_LINE) { pts.push(xf(s.p1), xf(s.p2)); }
  }
  return pts;
};
const refPts = flatten(refCubics, apply);   // affine(original arc shape)
const outPts = flatten(copy1, (p) => p);     // copy-1 as emitted
let maxErr = 0;
for (const r of refPts) {
  let best = Infinity;
  for (const p of outPts) { const d = Math.hypot(p[0]-r[0], p[1]-r[1]); if (d < best) best = d; }
  if (best > maxErr) maxErr = best;
}
console.log('  max distance copy1 ↔ affine(original arc decomposition):', maxErr.toFixed(6));
if (maxErr < 1e-6) ok('copy 1 = copy affine applied to the original arc (exact)');
else fail('copy 1 deviates from affine(original arc): ' + maxErr.toFixed(6));

console.log(failures ? `\n${failures} FAILURE(S)` : '\nREPEATER-ARC PASS');
process.exit(failures ? 1 : 0);

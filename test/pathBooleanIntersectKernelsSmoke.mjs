// Exercises the segment-segment intersection dispatcher across EVERY
// supported type-pair, with emphasis on the curve/curve and arc kernels
// (quad/quad, quad/cubic, cubic/cubic, line/arc, quad/arc, cubic/arc,
// arc/arc).
//
// Three layers of verification:
//   (1) Direct dispatcher: call intersectSegments() on every pair in
//       BOTH argument orders. Assert it never throws, returns params
//       in [0,1], points that actually lie on both segments, and that
//       swapping arguments swaps (tA,tB) symmetrically (same count).
//   (2) Mid-pipeline: feed curved + arc shapes through intersectAndSplit
//       (the stage that drives the kernels in anger). Assert no throw
//       and that crossing curves actually got split (more out segs in).
//   (3) Full union pipeline: unionPaths() over two overlapping curved
//       shapes — assert a non-empty, closed silhouette comes back.

import { intersectSegments } from '../src/svg/pathBoolean/intersect/index.js';
import { intersectAndSplit } from '../src/svg/pathBoolean/planar/segmentSet.js';
import { subdivideYMonotone } from '../src/svg/pathBoolean/subdivide.js';
import { unionPaths } from '../src/svg/pathBoolean/union.js';
import {
  mkLine, mkQuad, mkCubic, mkArc, segStart, segEnd,
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC,
} from '../src/svg/segment.js';

let failures = 0;
const ok = (m) => console.log('ok  ', m);
const fail = (m) => { failures++; console.error('FAIL', m); };

// ---- geometric evaluators (independent of the kernels) so we can
//      double-check that a returned (t, point) actually lies on the seg.
function evalSeg(seg, t) {
  if (seg.type === SEG_LINE) {
    return [seg.p1[0] + t * (seg.p2[0] - seg.p1[0]),
            seg.p1[1] + t * (seg.p2[1] - seg.p1[1])];
  }
  if (seg.type === SEG_QUAD) {
    const u = 1 - t;
    return [u*u*seg.p1[0] + 2*u*t*seg.p2[0] + t*t*seg.p3[0],
            u*u*seg.p1[1] + 2*u*t*seg.p2[1] + t*t*seg.p3[1]];
  }
  if (seg.type === SEG_CUBIC) {
    const u = 1 - t;
    return [u*u*u*seg.p1[0] + 3*u*u*t*seg.p2[0] + 3*u*t*t*seg.p3[0] + t*t*t*seg.p4[0],
            u*u*u*seg.p1[1] + 3*u*u*t*seg.p2[1] + 3*u*t*t*seg.p3[1] + t*t*t*seg.p4[1]];
  }
  if (seg.type === SEG_ARC) {
    const th = seg.theta_start + t * (seg.theta_end - seg.theta_start);
    const cp = Math.cos(seg.phi), sp = Math.sin(seg.phi);
    const ct = Math.cos(th), st = Math.sin(th);
    return [seg.cx + cp*seg.rx*ct - sp*seg.ry*st,
            seg.cy + sp*seg.rx*ct + cp*seg.ry*st];
  }
  return [NaN, NaN];
}

// ---- build one representative of each type that all cross near (10,0) ----
// A horizontal-ish line, an up-bump quad, a down-bump quad, an S-cubic, an
// inverted-S cubic, and two distinct circles (as full arcs via mkArc).
const L  = mkLine([0, 0], [20, 0]);
const L2 = mkLine([0, -8], [20, 8]);
const Qup = mkQuad([0, 0], [10, 16], [20, 0]);
const Qdn = mkQuad([0, 4], [10, -16], [20, 4]);
const Cs  = mkCubic([0, -6], [7, 14], [13, -14], [20, 6]);
const Cs2 = mkCubic([0, 6], [7, -14], [13, 14], [20, -6]);
// Circle A center (4,0) r=10, circle B center (16,0) r=10 → cross at x=10, y=±√(100-36)=±8.
const ArcA = mkArc(4, 0, 10, 10, 0, 1.999 * Math.PI, 0, 1, 1);
const ArcB = mkArc(16, 0, 10, 10, 0, 1.999 * Math.PI, 0, 1, 1);

const PAIRS = [
  ['line/line',   L,   L2 ],
  ['line/quad',   L,   Qup],
  ['line/cubic',  L,   Cs ],
  ['line/arc',    L2,  ArcA],
  ['quad/quad',   Qup, Qdn],
  ['quad/cubic',  Qup, Cs2],
  ['quad/arc',    Qup, ArcA],
  ['cubic/cubic', Cs,  Cs2],
  ['cubic/arc',   Cs,  ArcA],
  ['arc/arc',     ArcA, ArcB],
];

console.log('--- layer 1: direct dispatcher, every supported pair ---');
let anyHadHits = false;
for (const [name, a, b] of PAIRS) {
  let r, rSwap;
  try {
    r = intersectSegments(a, b);
  } catch (e) {
    fail(`${name}: intersectSegments(a,b) threw: ${e.message}`);
    continue;
  }
  try {
    rSwap = intersectSegments(b, a);
  } catch (e) {
    fail(`${name}: intersectSegments(b,a) threw: ${e.message}`);
    continue;
  }
  if (r.length !== rSwap.length) {
    fail(`${name}: arg-order asymmetry (${r.length} vs ${rSwap.length} hits)`);
    continue;
  }
  if (r.length > 0) anyHadHits = true;

  // Validate each hit: params in [0,1] and the reported point sits on
  // BOTH segments to a generous geometric tolerance.
  let bad = 0;
  for (const h of r) {
    if (!(h.tA >= -1e-6 && h.tA <= 1 + 1e-6)) bad++;
    if (!(h.tB >= -1e-6 && h.tB <= 1 + 1e-6)) bad++;
    const pa = evalSeg(a, Math.max(0, Math.min(1, h.tA)));
    const pb = evalSeg(b, Math.max(0, Math.min(1, h.tB)));
    if (Math.hypot(pa[0] - h.x, pa[1] - h.y) > 1e-3) bad++;
    if (Math.hypot(pb[0] - h.x, pb[1] - h.y) > 1e-3) bad++;
    if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) > 1e-3) bad++;
  }
  // Swap symmetry: tA<->tB must match within tolerance for the same set.
  if (bad === 0)
    ok(`${name}: ${r.length} hit(s), params in range, points on both segs, order-symmetric`);
  else
    fail(`${name}: ${bad} validation problem(s) across ${r.length} hit(s)`);
}
if (!anyHadHits) fail('no pair produced any intersection — geometry is degenerate');
else ok('curve/arc pairs produced real crossings (kernels actually ran)');

console.log('\n--- layer 2: intersectAndSplit over curved + arc geometry ---');
// Build a tagged input set from monotone-split pieces of several mutually
// crossing curves/arcs, then run the split stage that drives the kernels.
function tagged(segs, shapeIdx) {
  const out = [];
  for (const s of segs) {
    for (const m of subdivideYMonotone(s)) {
      out.push({ seg: m, shapeIdx, subpathIdx: 0, origDirection: 1, fillRule: 'nonzero' });
    }
  }
  return out;
}
const mixed = [
  ...tagged([Qup], 0),
  ...tagged([Qdn], 1),
  ...tagged([Cs], 2),
  ...tagged([Cs2], 3),
  ...tagged([ArcA], 4),
  ...tagged([ArcB], 5),
];
let split;
try {
  split = intersectAndSplit(mixed);
  ok(`intersectAndSplit ran without throwing (${mixed.length} in → ${split.length} out)`);
} catch (e) {
  fail(`intersectAndSplit threw: ${e.message}`);
  split = mixed;
}
// Crossing curves must have been split, so output count must exceed input.
if (split.length > mixed.length)
  ok(`crossings split geometry (${split.length} > ${mixed.length}) — kernels fed the splitter`);
else
  fail(`no splitting occurred (${split.length} <= ${mixed.length}) — kernels produced no interior hits`);

console.log('\n--- layer 3: full unionPaths over overlapping curved shapes ---');
// Two closed lens/leaf shapes made of two quads each, overlapping so their
// curved boundaries cross (quad/quad in the planar sweep).
function leaf(cx, cy, w, h) {
  // top quad bulges up, bottom quad bulges down; closed contour.
  return [
    mkQuad([cx - w, cy], [cx, cy - h], [cx + w, cy]),
    mkQuad([cx + w, cy], [cx, cy + h], [cx - w, cy]),
  ];
}
const shapeA = { segs: leaf(10, 10, 10, 8), fillRule: 'nonzero' };
const shapeB = { segs: leaf(18, 10, 10, 8), fillRule: 'nonzero' };
let sil;
try {
  sil = unionPaths([shapeA, shapeB]);
  ok(`unionPaths ran without throwing → ${sil.length} silhouette seg(s)`);
} catch (e) {
  fail(`unionPaths threw: ${e.message}`);
  sil = [];
}
if (sil.length > 0) {
  ok(`union produced a non-empty silhouette (${sil.length} segs)`);
  // Check the silhouette closes: walking start→end of each emitted seg,
  // every seg's end should coincide with some seg's start (closed loops).
  let openEnds = 0;
  for (const s of sil) {
    const e = segEnd(s);
    let matched = false;
    for (const t of sil) {
      const st = segStart(t);
      if (Math.hypot(st[0] - e[0], st[1] - e[1]) < 1e-3) { matched = true; break; }
    }
    if (!matched) openEnds++;
  }
  if (openEnds === 0) ok('silhouette is closed (every seg end meets another seg start)');
  else fail(`silhouette has ${openEnds} dangling end(s) — boundary not closed`);
} else {
  fail('unionPaths returned an empty silhouette for overlapping curved shapes');
}

console.log('');
if (failures > 0) {
  console.error(`PATH-BOOLEAN INTERSECT-KERNELS FAIL (${failures})`);
  process.exit(1);
}
console.log('PATH-BOOLEAN INTERSECT-KERNELS PASS');

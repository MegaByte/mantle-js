// lbBuildRoutesSmoke.mjs — node-side route coverage for the Loop-Blinn build
// pipeline across its satellite modules (no browser). Each fixture exercises a
// distinct builder route; a build that returns null OR trips the builder's
// internal catch (globalThis.__lbPartitionErr) fails. Guards the split-module wiring:
// a missing cross-module import surfaces here as a swallowed ReferenceError
// (the browser render smokes see only the silent Slug fallback).
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { buildLbShape } from '../src/renderer/lbBuildCore.js';
import { mkLine, mkQuad, mkCubic, mkRQuad } from '../src/primitives/seg.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => { failures++; console.error('FAIL', m); };

const L = (x1, y1, x2, y2) => mkLine([x1, y1], [x2, y2]);
const Q = (x1, y1, cx, cy, x2, y2) => mkQuad([x1, y1], [cx, cy], [x2, y2]);
const C = (x1, y1, c1x, c1y, c2x, c2y, x2, y2) => mkCubic([x1, y1], [c1x, c1y], [c2x, c2y], [x2, y2]);

// Full circle out of two half-circle rational quads (w = cos(90°/2) per 90°
// piece would be 4 pieces; two 180° halves via two 90°+90° pairs kept simple:
// use four quarter arcs, w = cos(45°) ≈ 0.7071).
const W = Math.SQRT1_2;
const circle = (cx, cy, r) => [
  mkRQuad([cx + r, cy], [cx + r, cy + r], [cx, cy + r], W, { cx, cy, r }),
  mkRQuad([cx, cy + r], [cx - r, cy + r], [cx - r, cy], W, { cx, cy, r }),
  mkRQuad([cx - r, cy], [cx - r, cy - r], [cx, cy - r], W, { cx, cy, r }),
  mkRQuad([cx, cy - r], [cx + r, cy - r], [cx + r, cy], W, { cx, cy, r }),
];

const FIXTURES = [
  ['convex quad shape (partition fast route)', [[
    Q(20, 20, 100, 0, 180, 20), L(180, 20, 180, 180), Q(180, 180, 100, 200, 20, 180), L(20, 180, 20, 20),
  ]]],
  // A thick concave-cubic "C": stresses the winding-calibration route (concave cubics
  // on both walls) and BUILDS an LB mesh, which is what this route-coverage smoke asserts.
  // NOTE: a THINNER C (walls close enough that the two concave cubics' crescents over-paint
  // the gap) correctly DECLINES to Slug via the cubic self-audit — Slug renders it exactly,
  // so that decline is right, not a route loss. A route that swallows a ReferenceError and
  // declines silently still fails here via __lbPartitionErr; a legitimate audit decline must
  // not masquerade as one, so this fixture uses a C the audit passes.
  ['concave cubic C-shape (winding calibration route)', [[
    C(150, 40, 70, 20, 30, 70, 30, 100), C(30, 100, 30, 130, 70, 180, 150, 160),
    L(150, 160, 150, 130), C(150, 130, 90, 150, 60, 130, 60, 100),
    C(60, 100, 60, 70, 90, 50, 150, 70), L(150, 70, 150, 40),
  ]]],
  ['holed shape — square with quad-lens hole (CDT + inside-removal)', [[
    L(10, 10, 190, 10), L(190, 10, 190, 190), L(190, 190, 10, 190), L(10, 190, 10, 10),
  ], [
    Q(60, 100, 100, 40, 140, 100), Q(140, 100, 100, 160, 60, 100),
  ]]],
  ['exact circle (circular-SDF disc route)', [circle(100, 100, 70)]],
  ['annulus — concentric circle pair (annulus-SDF route)', [circle(100, 100, 70), circle(100, 100, 40)]],
  ['rquad arc wedge (rational-quad crescent route)', [[
    mkRQuad([180, 100], [180, 180], [100, 180], W), L(100, 180, 100, 100), L(100, 100, 180, 100),
  ]]],
];

for (const [name, contours] of FIXTURES) {
  if (typeof globalThis !== 'undefined') globalThis.__lbPartitionErr = '';
  let mesh = null, threw = null;
  try { mesh = buildLoopBlinnCDT(contours, { fillRule: 'nonzero' }); }
  catch (e) { threw = e; }
  const partitionErr = (typeof globalThis !== 'undefined' && globalThis.__lbPartitionErr) || '';
  if (threw) fail(`${name}: builder threw — ${threw.message}`);
  else if (partitionErr) fail(`${name}: builder caught internally — ${partitionErr.split('\n')[0]}`);
  else if (!mesh) fail(`${name}: builder returned null (route lost to Slug fallback)`);
  else ok(`${name}`);
}

const hasInteriorChain = (built) => {
  const rows = built && built.raw && built.raw.interiorChainA;
  return !!rows && rows.some((v) => v !== 0);
};
const hasConicMode = (built) => {
  const rows = built && built.raw && built.raw.interiorChainC;
  if (!rows) return false;
  for (let i = 2; i < rows.length; i += 4) if (rows[i] > 2.5) return true;
  return false;
};

// Translucent fills need a non-overlapping partition. A simple convex quadratic
// can still use its normal curve bands without paying the interior PART-chain
// fragment kernel; concave and holed outlines need their local chains.
const convexTrans = buildLbShape(FIXTURES[0][1], true, false);
if (convexTrans && !hasInteriorChain(convexTrans)) ok('convex translucent quadratic skips PART chains');
else fail('convex translucent quadratic unexpectedly carries PART chains');

const concaveQuad = [[
  L(20, 20, 180, 20), L(180, 20, 180, 180),
  Q(180, 180, 100, 100, 20, 180), L(20, 180, 20, 20),
]];
const concaveTrans = buildLbShape(concaveQuad, true, false);
if (concaveTrans && hasInteriorChain(concaveTrans)) ok('concave translucent quadratic retains PART chains');
else fail('concave translucent quadratic lost required PART chains');

const holedTrans = buildLbShape(FIXTURES[2][1], true, false);
if (holedTrans && hasInteriorChain(holedTrans)) ok('holed translucent quadratic retains PART chains');
else fail('holed translucent quadratic lost required PART chains');

if (!hasConicMode(concaveTrans)) ok('CONIC chains are disabled by default');
else fail('CONIC chains unexpectedly enabled by default');
globalThis.__LB_CONIC = true;
const conicProbe = buildLbShape(concaveQuad, true, false);
delete globalThis.__LB_CONIC;
if (conicProbe && hasConicMode(conicProbe)) ok('CONIC chains remain available as an explicit probe');
else fail('CONIC probe opt-in did not produce conic chains');

console.log(failures ? `\nLB-BUILD-ROUTES FAIL (${failures})` : '\nLB-BUILD-ROUTES PASS');
process.exit(failures ? 1 : 0);

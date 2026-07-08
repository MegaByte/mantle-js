// modifiersSmoke.mjs — verify Lottie-flavoured path-segment modifiers
// in svg/modifiers.js + filter-effect synthesizers in svg/effectsSynth.js.
//
// Verifies the math + geometry by feeding small segment lists through
// each modifier and asserting structural invariants (vertex count,
// endpoint positions, total arc length).

import {
  trimPath, puckerBloat, repeater, roundCorners, offsetPath, polystar,
} from '../../src/svg/modifiers.js';
import { tintGraph, tritoneGraph } from '../../src/svg/effectsSynth.js';
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkCubic } from '../../src/svg/segment.js';
import { SRC_GRAPHIC } from '../../src/filterGraph/filterGraph.js';

let failures = 0;
function ok(msg)   { console.log('ok', msg); }
function fail(msg) { failures++; console.error('FAIL', msg); }
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

// ────────────────────────────────────────────────────────────────
// Trim Path
// ────────────────────────────────────────────────────────────────

// Unit square traversed CW: each edge length 1, total length 4.
const unitSquare = [
  mkLine([0, 0], [1, 0]),
  mkLine([1, 0], [1, 1]),
  mkLine([1, 1], [0, 1]),
  mkLine([0, 1], [0, 0]),
];

(() => {
  // Identity: start=0, end=1 → all 4 segs intact.
  const out = trimPath(unitSquare, 0, 1, 0);
  if (out.length !== 4) fail(`trimPath identity: expected 4 segs got ${out.length}`);
  else ok('trimPath identity preserves 4 segs');
})();

(() => {
  // Half: start=0, end=0.5 — first 2 edges (total length 2 of 4).
  const out = trimPath(unitSquare, 0, 0.5, 0);
  if (out.length !== 2) fail(`trimPath 0..0.5: expected 2 segs got ${out.length}`);
  else if (!approx(out[1].p2[0], 1) || !approx(out[1].p2[1], 1))
    fail(`trimPath 0..0.5: end vertex not (1,1) (${out[1].p2})`);
  else ok('trimPath 0..0.5 → first 2 edges ending at (1,1)');
})();

(() => {
  // Partial-edge crop: start=0, end=0.125 — 50% of first edge only.
  const out = trimPath(unitSquare, 0, 0.125, 0);
  if (out.length !== 1) fail(`trimPath 0..0.125: expected 1 seg got ${out.length}`);
  else if (!approx(out[0].p2[0], 0.5)) fail(`trimPath partial: end x not 0.5 (${out[0].p2[0]})`);
  else ok('trimPath 0..0.125 → first half of first edge');
})();

(() => {
  // Wrap: start=0.875, end=0.125 — last quarter of edge 4 + first quarter of edge 1.
  const out = trimPath(unitSquare, 0.875, 0.125, 0);
  if (out.length !== 2) fail(`trimPath wrap: expected 2 segs got ${out.length}`);
  else ok(`trimPath wrap 0.875..0.125 → 2 segs`);
})();

(() => {
  // Offset: start=0, end=0.25 with offset=0.25 — second edge (length 1).
  const out = trimPath(unitSquare, 0, 0.25, 0.25);
  if (out.length !== 1) fail(`trimPath offset 0.25: expected 1 seg got ${out.length}`);
  else if (!approx(out[0].p1[0], 1) || !approx(out[0].p1[1], 0))
    fail(`trimPath offset: start not (1,0) (${out[0].p1})`);
  else ok('trimPath offset=0.25 selects second edge');
})();

// ────────────────────────────────────────────────────────────────
// Pucker & Bloat
// ────────────────────────────────────────────────────────────────

(() => {
  // Centroid of unit square = (0.5, 0.5). Bloat by amount=1 → scale 2×.
  // Vertex (0,0) should map to (0.5 - 0.5*2, 0.5 - 0.5*2) = (-0.5, -0.5).
  const out = puckerBloat(unitSquare, 1.0);
  if (out.length !== 4) fail(`puckerBloat: expected 4 segs got ${out.length}`);
  else if (!approx(out[0].p1[0], -0.5) || !approx(out[0].p1[1], -0.5))
    fail(`puckerBloat bloat: vertex (0,0) → (${out[0].p1[0]}, ${out[0].p1[1]}); want (-0.5,-0.5)`);
  else ok('puckerBloat amount=+1 doubles square around centroid');
})();

(() => {
  // Pucker (amount=-0.5): vertex (0,0) → (0.5 - 0.5*0.5, 0.5 - 0.5*0.5) = (0.25, 0.25).
  const out = puckerBloat(unitSquare, -0.5);
  if (!approx(out[0].p1[0], 0.25) || !approx(out[0].p1[1], 0.25))
    fail(`puckerBloat pucker: vertex (0,0) → (${out[0].p1[0]}, ${out[0].p1[1]}); want (0.25, 0.25)`);
  else ok('puckerBloat amount=-0.5 halves square inward');
})();

// ────────────────────────────────────────────────────────────────
// Repeater
// ────────────────────────────────────────────────────────────────

(() => {
  // 3 copies, translate (2, 0) each step → original + (2,0)-shift + (4,0)-shift.
  const seg = [mkLine([0, 0], [1, 0])];
  const out = repeater(seg, 3, 2, 0, 0, 1, 1);
  if (out.length !== 3) fail(`repeater 3 copies: expected 3 segs got ${out.length}`);
  else if (!approx(out[2].p1[0], 4) || !approx(out[2].p2[0], 5))
    fail(`repeater: third copy not at x=4..5 (got ${out[2].p1[0]}..${out[2].p2[0]})`);
  else ok('repeater 3 copies @ tx=2 → translated triples');
})();

(() => {
  // 2 copies, scale 0.5, rotate 0 — second copy is half-size at origin.
  const seg = [mkLine([0, 0], [1, 0])];
  const out = repeater(seg, 2, 0, 0, 0, 0.5, 0.5);
  if (!approx(out[1].p1[0], 0) || !approx(out[1].p2[0], 0.5))
    fail(`repeater scale: second copy not at 0..0.5 (got ${out[1].p1[0]}..${out[1].p2[0]})`);
  else ok('repeater scale 0.5 halves second copy');
})();

// ────────────────────────────────────────────────────────────────
// Roundness
// ────────────────────────────────────────────────────────────────

(() => {
  // Square with r=0.1: each corner becomes line+quad. Closed-path,
  // so all 4 corners get rounded → 8 segs out (4 line + 4 quad).
  const sq = unitSquare.map(s => ({ ...s }));   // defensive copy
  const out = roundCorners(sq, 0.1);
  if (out.length !== 8) fail(`roundCorners square: expected 8 segs got ${out.length}`);
  else if (out.filter(s => s.type === SEG_QUAD).length !== 4)
    fail(`roundCorners square: expected 4 quads got ${out.filter(s => s.type === SEG_QUAD).length}`);
  else ok('roundCorners square r=0.1 → 4 line + 4 quad');
})();

(() => {
  // Open path (not closed): only interior corners get rounded.
  // L-shape: (0,0)→(1,0)→(1,1) — one interior corner.
  const lshape = [mkLine([0, 0], [1, 0]), mkLine([1, 0], [1, 1])];
  const out = roundCorners(lshape, 0.2);
  // Expected: line(0,0)→inA + quad inA→corner→inB + (open: last line not rewritten).
  // Actually with closed=false, the wrap iteration is skipped, so corner
  // at index 0 (last seg's end → first seg's start) is also skipped.
  // Interior corner between segs[0] and segs[1] gets filleted.
  if (out.length !== 3) fail(`roundCorners L-shape: expected 3 segs got ${out.length}`);
  else if (out[1].type !== SEG_QUAD)
    fail(`roundCorners L-shape: middle should be quad, got type=${out[1].type}`);
  else ok('roundCorners open L-shape rounds interior corner only');
})();

// ────────────────────────────────────────────────────────────────
// Offset Path
// ────────────────────────────────────────────────────────────────

(() => {
  // Horizontal line (0,0)→(1,0). Offset +1 (outward = rotate tangent
  // +90° in y-down = (0,-1)·d). Should produce a line at y=-1.
  const seg = [mkLine([0, 0], [1, 0])];
  const out = offsetPath(seg, 1.0);
  if (out.length !== 1) fail(`offsetPath line: expected 1 seg got ${out.length}`);
  else if (!approx(out[0].p1[1], -1) || !approx(out[0].p2[1], -1))
    fail(`offsetPath line: y not -1 (got ${out[0].p1[1]}, ${out[0].p2[1]})`);
  else ok('offsetPath horizontal line +1 → shifted to y=-1');
})();

(() => {
  // Cubic curve: should produce many short line segs (the polyline approx).
  const seg = [mkCubic([0, 0], [0, 1], [1, 1], [1, 0])];
  const out = offsetPath(seg, 0.2);
  if (out.length < 4) fail(`offsetPath cubic: expected ≥4 segs got ${out.length}`);
  else ok(`offsetPath cubic → ${out.length} polyline segs`);
})();

// ────────────────────────────────────────────────────────────────
// Polystar
// ────────────────────────────────────────────────────────────────

(() => {
  // 5-point star (no fillet) → 10 line segments.
  const out = polystar(0, 0, 5, 10, 5, 0, 0, -90, true);
  if (out.length !== 10) fail(`polystar 5-pt star: expected 10 segs got ${out.length}`);
  else ok('polystar 5-pt star → 10 line segs');
})();

(() => {
  // Triangle (polygon mode, 3 pts) → 3 line segments.
  const out = polystar(0, 0, 3, 10, 0, 0, 0, -90, false);
  if (out.length !== 3) fail(`polystar triangle: expected 3 segs got ${out.length}`);
  else ok('polystar triangle → 3 line segs');
})();

(() => {
  // Square (4-gon) with outerRoundness=0.5 → 4 line + 4 quad = 8 segs.
  const out = polystar(0, 0, 4, 10, 0, 0.5, 0, -90, false);
  if (out.length !== 8) fail(`polystar rounded square: expected 8 segs got ${out.length}`);
  else if (out.filter(s => s.type === SEG_QUAD).length !== 4)
    fail(`polystar rounded square: expected 4 quads got ${out.filter(s => s.type === SEG_QUAD).length}`);
  else ok('polystar rounded square r=0.5 → 4 line + 4 quad');
})();

// ────────────────────────────────────────────────────────────────
// Tint / Tritone synthesizers
// ────────────────────────────────────────────────────────────────

(() => {
  // Black-to-white tint should leave luminance basically unchanged.
  const g = tintGraph([0, 0, 0, 1], [1, 1, 1, 1]);
  if (g.nodes.length !== 2 || g.rootOut !== 1)
    fail(`tintGraph: expected 2 nodes + rootOut=1 (got ${g.nodes.length}/${g.rootOut})`);
  else if (g.nodes[0].type !== 'feColorMatrix' || g.nodes[1].type !== 'feComponentTransfer')
    fail(`tintGraph: wrong node types`);
  else if (g.nodes[0].inputs[0] !== SRC_GRAPHIC)
    fail(`tintGraph: first node should sample SRC_GRAPHIC`);
  else if (g.nodes[1].inputs[0] !== 0)
    fail(`tintGraph: second node should feed from node 0`);
  else if (g.nodes[1].params.lutBytes.length !== 256 * 4 * 4)
    fail(`tintGraph: LUT size wrong (${g.nodes[1].params.lutBytes.length})`);
  else ok('tintGraph: 2-node graph (colorMatrix + CT) with correct topology');
})();

(() => {
  // Tint with a pure red destination at L=1 — LUT row R at byte 255 should be 255.
  const g = tintGraph([0, 0, 0, 1], [1, 0, 0, 1]);
  const lut = g.nodes[1].params.lutBytes;
  // R row at i=255 maps to c1.r=1 → 255.
  if (lut[(0 * 256 + 255) * 4 + 0] !== 255)
    fail(`tintGraph red: LUT row R at L=1 should be 255 (got ${lut[(0 * 256 + 255) * 4 + 0]})`);
  // G row at i=255 maps to c1.g=0 → 0.
  else if (lut[(1 * 256 + 255) * 4 + 0] !== 0)
    fail(`tintGraph red: LUT row G at L=1 should be 0 (got ${lut[(1 * 256 + 255) * 4 + 0]})`);
  else ok('tintGraph black→red: R-row peaks at 255, G-row stays at 0');
})();

(() => {
  // Tritone: shadow=black, mid=gray, highlight=white → identity grayscale ramp.
  const g = tritoneGraph([0, 0, 0, 1], [0.5, 0.5, 0.5, 1], [1, 1, 1, 1]);
  if (g.nodes.length !== 2) fail(`tritoneGraph: expected 2 nodes got ${g.nodes.length}`);
  else {
    const lut = g.nodes[1].params.lutBytes;
    // R row: should be roughly the identity ramp at i=128 (≈ 128).
    const mid = lut[(0 * 256 + 128) * 4 + 0];
    if (mid < 124 || mid > 132)
      fail(`tritoneGraph identity: midpoint R should be ~128 (got ${mid})`);
    else ok(`tritoneGraph identity gray-ramp: midpoint=${mid}`);
  }
})();

// ────────────────────────────────────────────────────────────────

if (failures === 0) console.log('\nMODIFIERS PASS');
else { console.error(`\nMODIFIERS FAIL (${failures})`); process.exit(1); }

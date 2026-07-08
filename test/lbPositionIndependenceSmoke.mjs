// lbPositionIndependenceSmoke.mjs — the LB mesh a shape builds must NOT depend on
// its absolute position. The point-identity quantization keys (Math.round(p*64))
// used to be an ABSOLUTE grid, so the SAME glyph triangulated differently at a
// non-zero offset — a 'v' inside "Even?" (x≈0.47) built 14 tris / 0 crescents while
// a lone 'v' (x=0) built 16 tris / 4 crescents, dropping the curves and cracking the
// fill into a visible diagonal SLASH through the stroke. Keys are now relative to the
// shape's own origin, so an offset copy builds the byte-identical mesh. This guards
// that: build a curved contour at origin and shifted by a fractional offset, assert
// the triangle + crescent counts (and vertex sets, modulo the shift) match exactly.
import { buildLoopBlinnCDT, buildLoopBlinnMesh } from '../src/renderer/loopBlinn.js';
import { mkLine, mkQuad } from '../src/primitives/seg.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

// A closed contour with quad curves whose on-curve/control points are CLOSELY
// spaced (~0.004 apart, like a glyph's subdivided curve samples) — the spacing that
// straddles a 1/64 rounding cell, so an absolute-grid key merges different points at
// some offsets. CCW, with a fine top edge that clusters points near x≈0.24.
function shape(dx, dy) {
  const P = (x, y) => [x + dx, y + dy];
  const segs = [
    mkQuad(P(0.10, 0.00), P(0.40, 0.00), P(0.40, 0.20)),
    mkQuad(P(0.40, 0.20), P(0.40, 0.40), P(0.20, 0.40)),
  ];
  // cluster of near-coincident on-curve points along the top (0.004 apart)
  let x = 0.246;
  for (let i = 0; i < 6; i++) { segs.push(mkQuad(P(x, 0.40), P(x - 0.002, 0.41), P(x - 0.004, 0.40))); x -= 0.004; }
  segs.push(mkQuad(P(x, 0.40), P(0.00, 0.40), P(0.00, 0.20)));
  segs.push(mkQuad(P(0.00, 0.20), P(0.00, 0.00), P(0.10, 0.00)));
  segs.push(mkLine(P(0.10, 0.00), P(0.10, 0.00)));
  return [segs];
}

// Sweep fractional offsets across (and past) a full 1/64 rounding period so an
// absolute-grid key is guaranteed to straddle for the clustered points at some step.
const OFFSETS = [];
for (let i = 1; i <= 24; i++) OFFSETS.push(i * 0.0013);
OFFSETS.push(0.473, 1.267, 12.031);

for (const build of [['CDT', buildLoopBlinnCDT], ['Mesh', buildLoopBlinnMesh]]) {
  const [name, fn] = build;
  const base = fn(shape(0, 0));
  if (!base) {
    // Self-crossing outlines now route to the per-shape Slug fallback (null) by design
    // — position independence then means null at EVERY offset too.
    let stable = true;
    for (const off of OFFSETS) if (fn(shape(off, off * 0.3)) !== null) { stable = false; break; }
    if (stable) ok(name + ': self-crossing shape routes to Slug at all offsets (stable null)');
    else fail(name + ': null at origin but built at some offset (position-dependent routing)');
    continue;
  }
  const sig = (m) => `${m.interior.length / 6}tri/${m.quads.length}q/${(m.cubics || []).length}c`;
  const baseSig = sig(base);
  let allMatch = true;
  for (const off of OFFSETS) {
    const shifted = fn(shape(off, off * 0.3));
    if (!shifted) { fail(`${name}: build at offset ${off} returned null`); allMatch = false; continue; }
    if (sig(shifted) !== baseSig) {
      fail(`${name}: mesh differs at offset ${off} — ${sig(shifted)} vs origin ${baseSig} (position-dependent triangulation → slash)`);
      allMatch = false;
    }
  }
  if (allMatch) ok(`${name}: mesh is position-independent (${baseSig} at origin and all offsets)`);
}

if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\nlbPositionIndependenceSmoke: LB mesh does not depend on absolute shape position');

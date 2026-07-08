// pathBooleanSlice6aSmoke — intersectAndSplit.
// Verifies that pairwise-intersection + segment-splitting produces
// the correct number of elementary segments + no segments cross
// interiorly.

import { mkLine, mkQuad } from '../src/svg/segment.js';
import { intersectAndSplit } from '../src/svg/pathBoolean/planar/segmentSet.js';
import { intersectSegments } from '../src/svg/pathBoolean/intersect/index.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => { failures++; console.error('FAIL', m); };

function inp(seg, shapeIdx = 0, subpathIdx = 0) {
  return { seg, shapeIdx, subpathIdx, origDirection: 1, fillRule: 'nonzero' };
}

// Verify no two output segments cross interiorly.
function verifyNoInteriorCrossings(out) {
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const hits = intersectSegments(out[i].seg, out[j].seg);
      for (const h of hits) {
        const interiorA = h.tA > 1e-6 && h.tA < 1 - 1e-6;
        const interiorB = h.tB > 1e-6 && h.tB < 1 - 1e-6;
        if (interiorA && interiorB) {
          return `interior crossing: seg${i} tA=${h.tA.toFixed(4)} × seg${j} tB=${h.tB.toFixed(4)}`;
        }
      }
    }
  }
  return null;
}

// ----- 1. Two crossing lines → 4 elementary segments -----
{
  const out = intersectAndSplit([
    inp(mkLine([-1, 0], [1, 0])),    // horizontal
    inp(mkLine([0, -1], [0, 1])),    // vertical
  ]);
  if (out.length === 4)
    ok(`LL: cross → 4 elementary segments`);
  else fail(`LL: expected 4, got ${out.length}`);
  const err = verifyNoInteriorCrossings(out);
  if (err) fail(`LL: post-split ${err}`);
  else ok(`LL: post-split has no interior crossings`);
}

// ----- 2. Three concurrent lines through origin → 6 elementary segments -----
{
  const out = intersectAndSplit([
    inp(mkLine([-1, 0], [1, 0])),
    inp(mkLine([0, -1], [0, 1])),
    inp(mkLine([-1, -1], [1, 1])),    // 45° diagonal
  ]);
  if (out.length === 6)
    ok(`LLL: three concurrent → 6 elementary segments`);
  else fail(`LLL: expected 6, got ${out.length}`);
}

// ----- 3. Non-crossing pair → 2 segments (passthrough) -----
{
  const out = intersectAndSplit([
    inp(mkLine([0, 0], [1, 0])),
    inp(mkLine([0, 2], [1, 2])),
  ]);
  if (out.length === 2) ok('LL: parallel passthrough');
  else fail(`LL: parallel got ${out.length}`);
}

// ----- 4. Quadratic crossing line at 2 points -----
{
  // Arch quad crossing horizontal line y = 0.5 at 2 points. A weak arch
  // (-1,0)→(0,1)→(1,0) gives y(s)=2s-2s², tangent at y=0.5 (double root);
  // use a stronger arch (-1,0)→(0,2)→(1,0): y(s)=4s-4s², x(s)=-1+2s.
  // y=0.5 → s²-s+0.125=0 → s ∈ {0.5 ± √0.125} ≈ {0.146, 0.854}.
  const out = intersectAndSplit([
    inp(mkQuad([-1, 0], [0, 2], [1, 0])),
    inp(mkLine([-2, 0.5], [2, 0.5])),
  ]);
  // Quad splits at 2 interior params → 3 sub-quads.
  // Line splits at 2 interior params → 3 sub-lines.
  // Total: 6 segments.
  if (out.length === 6) ok(`QL: 2-cross → 6 elementary segments`);
  else fail(`QL: 2-cross expected 6, got ${out.length}`);
  const err = verifyNoInteriorCrossings(out);
  if (err) fail(`QL: post-split ${err}`);
  else ok(`QL: post-split has no interior crossings`);
}

if (failures > 0) {
  console.error(`\nPATH-BOOLEAN SLICE-6a FAIL (${failures})`);
  process.exit(1);
}
console.log('\nPATH-BOOLEAN SLICE-6a PASS');

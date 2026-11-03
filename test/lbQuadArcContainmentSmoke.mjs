// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbQuadArcContainmentSmoke — the containment split has to see a QUADRATIC and an ARC as
// themselves.
//
// THE TRAP. A curve to walk built as `o.p4 ? [p1,p2,p3,p4] : [p1,p1,p2,p2]` is the segment for a
// LINE. For a QUADRATIC or an ARC, p2 is the CONTROL point, so what gets walked is the chord from
// the start point to it -- a curve the outline does not contain -- and the segment's real body is
// never inside any hull no matter where it runs. An end point read the same way (`p4 || p2`) makes
// the shared-endpoint test ask about the control point too and applies the joint whisker to the
// wrong end. Both the split driver and the face proof walk the real curve.
//
// Real art rarely tells them apart: the shapes with cubic faces (tiger, lbMemBudget) carry no
// quadratics or arcs at all, and the quadratic- and arc-heavy ones (aacBandLevels,
// lbWorkerWireParity) produce no curve faces. So this builds the case directly: one
// cubic whose control hull is the box (0,0)..(100,100), and a quadratic whose body dips into that
// box near t = 1 while the chord from its start to its control point passes well above it.
//
// WHAT IS ASSERTED. The containment split must CUT the cubic because of the quadratic, which is the
// only thing that can intrude on it -- the lines stay clear and split nothing -- so the cubic's own
// split plan has to hold more cuts here than on the same shape with the quadratic lifted clear.
// Walking the chord, the split on and off produce identical meshes on this exact shape while six
// face hulls hold the quadratic: the split is not declining to act, it cannot see what to act on.
// Walking the curve, the build differs from the unsplit one and the face hulls holding the
// quadratic fall to three (five unsplit).
//
// It does not reach zero under the shipped split, which is a SAMPLER: it converges on "no sample of the quadratic
// is inside" rather than "no part of it is", and a few faces still meet it (counted exactly, by rquadMeetsTri).
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { curveRangeToContours } = await import('../src/renderer/loopBlinn.js');
const { SEG_QUAD, SEG_RQUAD } = await import('../src/primitives/seg.js');
const { rquadMeetsTri } = await import('../src/geom/lbCubicMath.js');
const { cubicSplitPlan9 } = await import('../src/renderer/lbPartition.js');

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

const INTRUDE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-360 -260 820 720">' +
  '<path fill="#3060c0" fill-rule="evenodd" d="M 0 0 C 0 100, 100 100, 100 0 L 300 0 L 300 -200 ' +
  'L -200 -200 L -200 0 Z M 400 400 Q -300 50 110 50 L 400 50 Z"/></svg>';
// the same shape with the quadratic lifted clear: every control y >= 250, so it cannot reach the box
const CLEAR = INTRUDE.replace('Q -300 50 110 50 L 400 50', 'Q -300 250 110 250 L 400 250');

async function build(svg) {
  const b = await importSvg(svg);
  const r = b.curveRangesByShape[0];
  const contours = curveRangeToContours(new Float32Array(b.curves), r.begin, r.end);
  const built = buildLbShape(contours, false, true);
  // The cubic's split plan, from the builder's own function, against the shape's own boundary.
  const all = contours.flat(),
    cub = all.find((s) => s.p4);
  const plan = cub ? cubicSplitPlan9([cub.p1, cub.p2, cub.p3, cub.p4], all, cub) : null;
  const quads = [];
  for (const c of contours) for (const s of c) if (!s.p4 && s.p3) quads.push(s);
  let held = 0,
    faces = 0;
  for (const c of (built && built.raw && built.raw.cubics) || []) {
    const H = c.hull;
    if (!H || H.length < 6) continue;
    faces++;
    const A = [H[0], H[1]],
      B = [H[2], H[3]],
      C = [H[4], H[5]];
    for (const q of quads) {
      if (q === c.seg9) continue;
      const w = q.type === SEG_RQUAD ? q.w || 1 : 1;
      if (rquadMeetsTri(q.p1, q.p2, q.p3, w, A, B, C)) held++;
    }
  }
  return {
    faces,
    held,
    quads,
    verts: built && built.pk ? built.pk.vertexCount | 0 : -1,
    cuts: plan ? plan.ts.length : -1,
  };
}

const on = await build(INTRUDE);
const clear = await build(CLEAR);

check(
  on.quads.length === 1 && (on.quads[0].type === SEG_QUAD || on.quads[0].type === SEG_RQUAD),
  'the quadratic survives import as a quadratic (the case under test is present)',
);
check(on.faces > 0, `the shape meshes on the partition route (${on.faces} curve faces)`);
check(
  clear.cuts >= 0 && on.cuts > clear.cuts,
  `the containment split RESPONDS to the quadratic: the cubic is cut ${on.cuts} times, against ${clear.cuts} with it lifted clear`,
);
check(on.held <= 3, `and ${on.held} faces meet it (five without the split)`);
check(clear.held === 0, 'the lifted-clear variant holds nothing');
check(clear.faces === 4, `and needs no containment split (${clear.faces} curve faces)`);

if (fail) {
  console.error(`LB-QUAD-ARC-CONTAINMENT FAIL (${fail})`);
  process.exit(1);
}
console.log('LB-QUAD-ARC-CONTAINMENT PASS');

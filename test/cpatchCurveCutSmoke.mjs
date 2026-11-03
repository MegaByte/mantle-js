// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchCurveCutSmoke — the paper's stage (e): cutting a patch along a CURVE.
//
// A LEAK is the one violation class no straight line addresses on its own terms. The region a
// leaking patch wrongly claims is bounded by the offending curve's own extension re-entering
// the patch, so the cut edge has to be that extension arc. cutPatchByCurve builds it by
// carrying the Bezier outside [0,1] with the blossom — the same algebraic curve, not a fit.
//
// What this pins:
//   T1  the two halves are closed loops and together return the boundary they were cut from
//   T2  a line is refused (its extension is its own supporting line, already a line cut)
//   T3  the cut is REFUSED, not faked, when the extension never re-enters
//   T4  the move is gated out of taped decompositions — a tape has to be a function of the
//       control points alone, and whether an extension re-enters is not pose-stable. Without
//       this gate the morph pairing falls from 20/20 to 3/20 with 17 poses refusing the tape.
import {
  cutPatchByCurve,
  convertContour,
  validatePatch,
  patchBBox,
} from '../src/renderer/cpatchConvert.js';

let pass = 0,
  fail = 0;
const ok = (m) => {
  console.log('ok ' + m);
  pass++;
};
const bad = (m) => {
  console.log('FAIL ' + m);
  fail++;
};
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const P = (...pts) => pts;
const line = (a, b) => ({ t: 'line', P: P(a, b) });
const cubic = (a, b, c, d) => ({ t: 'cubic', P: P(a, b, c, d) });
const segStart = (s) => s.P[0];
const segEnd = (s) => s.P[s.P.length - 1];

// A real leaking contour, lifted from examples/tiger.svg — three cubics forming a claw, where
// the extension off the first one bends back through the body of the patch. Synthetic hooks
// tend to come out already-valid; this is the shape class the move is built for.
const claw = [
  cubic([-122.3, 84.29], [-122.3, 84.29], [-122.2, 86.18], [-123.03, 86.16]),
  cubic([-123.03, 86.16], [-123.85, 86.14], [-140.3, 38.07], [-160.83, 40.31]),
  cubic([-160.83, 40.31], [-160.83, 40.31], [-143.05, 32.96], [-122.3, 84.29]),
];

// ---- T1: the halves are closed, and their non-seam edges rebuild the original boundary ----
{
  const r = cutPatchByCurve(claw, 0, patchBBox(claw));
  if (!r) bad('T1 cutPatchByCurve found no separating arc on the claw contour');
  else {
    const loops = r.keep.concat(r.drop);
    let closed = 0;
    for (const l of loops) {
      const a = segStart(l[0]),
        b = segEnd(l[l.length - 1]);
      if (near(a[0], b[0], 1e-5) && near(a[1], b[1], 1e-5)) closed++;
      for (let i = 0; i + 1 < l.length; i++) {
        const e = segEnd(l[i]),
          s = segStart(l[i + 1]);
        if (!near(e[0], s[0], 1e-5) || !near(e[1], s[1], 1e-5)) {
          bad('T1 loop has a gap between consecutive segments');
          i = l.length;
        }
      }
    }
    if (closed === loops.length)
      ok(`T1 both halves are closed loops (${loops.map((l) => l.length).join(',')} curves)`);
    else bad(`T1 only ${closed}/${loops.length} halves closed`);
    // Exactly one seam per half: the shared cut arc, marked so the renderer does not AA it.
    const seams = loops.map((l) => l.filter((s) => s.cut).length);
    if (seams.every((n) => n === 1)) ok('T1 each half carries exactly one cut-marked seam');
    else bad(`T1 seam counts ${JSON.stringify(seams)} — expected one per half`);
  }
}

// ---- T2: a line is refused ----
{
  const square = [
    line([0, 0], [10, 0]),
    line([10, 0], [10, 10]),
    line([10, 10], [0, 10]),
    line([0, 10], [0, 0]),
  ];
  if (cutPatchByCurve(square, 0, patchBBox(square)) === null)
    ok('T2 a line is refused — its extension is its own supporting line');
  else bad('T2 a line was accepted; cutPatchByLine already makes that cut');
}

// ---- T3: refused when nothing re-enters ----
{
  // A shallow convex arc plus its chord: the extension leaves and never comes back.
  const crescent = [cubic([0, 0], [3, 4], [7, 4], [10, 0]), line([10, 0], [0, 0])];
  const r = cutPatchByCurve(crescent, 0, patchBBox(crescent));
  if (r === null) ok('T3 refused when the extension never re-enters the patch');
  else
    bad(
      `T3 invented a cut on a crescent (${r.keep
        .concat(r.drop)
        .map((l) => l.length)
        .join(',')})`,
    );
}

// ---- T4: never taken while recording or following a tape ----
{
  const tape = [];
  const out = convertContour(claw, { maxCurves: 8, tolPx: 0.05, record: tape });
  if (!out) bad('T4 convertContour returned nothing while recording');
  else {
    const eight = tape.filter((e) => e.branch === 8).length;
    if (eight === 0) ok(`T4 no curve cut recorded in a tape (${tape.length} decisions)`);
    else
      bad(
        `T4 ${eight} branch-8 entries recorded — a tape must replay on another pose, and this move does not`,
      );
    // ...and the untaped run is free to use it.
    const free = convertContour(claw, { maxCurves: 8, tolPx: 0.05 });
    if (free && (free.stats.curveCuts | 0) > 0)
      ok(`T4 the untaped run does use it (${free.stats.curveCuts} curve cuts)`);
    else ok('T4 untaped run resolved without needing a curve cut (allowed)');
  }
}

// ---- T5: the cut never makes a patch WORSE ----
{
  const bb = patchBBox(claw);
  const S = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  const out = convertContour(claw, { maxCurves: 8, tolPx: (0.05 * S) / 128 });
  if (!out) bad('T5 convertContour returned nothing');
  else {
    const invalid = out.patches.filter((p) => !validatePatch(p, (0.05 * S) / 128).ok).length;
    if (invalid === 0)
      ok(`T5 the claw contour decomposes to ${out.patches.length} patches, all valid`);
    else bad(`T5 ${invalid}/${out.patches.length} patches still invalid`);
  }
}

console.log(`\nCPATCH CURVE CUT ${fail ? 'FAIL' : 'PASS'} (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);

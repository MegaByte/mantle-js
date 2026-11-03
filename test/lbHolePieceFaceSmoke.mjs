// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbHolePieceFaceSmoke.mjs — every CUBIC PIECE OF A HOLE KEEPS ITS FACE.
//
// The partition cuts a cubic into pieces, constrains each piece's control hull,
// and the triangulation hands the faces inside that hull back as crescents. A
// piece whose hull collapses below what the triangulation can carry gets NO face,
// and a piece with no face contributes nothing at all — not the crescent, and not
// the exterior ring that is the only geometry a curved outline has OUTSIDE itself.
// The pixels just beyond that stretch of the outline are then reached by no
// primitive and their partial coverage is dropped rather than antialiased.
//
// A same-wound even-odd hole can do that to itself. The reorientation that points
// such a hole the right way round REPLACES its segments, and two places ask "is
// this segment my own" by identity, so unless that identity survives the
// replacement the curve becomes other boundary to itself: the containment rule
// finds its own arc inside its own hull and halves it to the depth limit. On the
// cubic ring below that is 97 cuts per arc, 392 pieces, and 576 of 784 hull
// records with no face — the outline's whole exterior band, gone.
//
// Asserted on the BUILD, so it needs no GPU: every piece record must own at least
// one face. probes/_lbBandDrop.mjs measures the pixels themselves.
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { mkCubic, mkLine } from '../src/primitives/seg.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// The unified-fill feature matrix's even-odd case: a cubic ring with a curved
// counter, both contours wound the same way, which is exactly what forces the
// reorientation.
const RING = [
  [
    [20, 4],
    [31, 4],
    [36, 9],
    [36, 20],
  ],
  [
    [36, 20],
    [36, 31],
    [31, 36],
    [20, 36],
  ],
  [
    [20, 36],
    [9, 36],
    [4, 31],
    [4, 20],
  ],
  [
    [4, 20],
    [4, 9],
    [9, 4],
    [20, 4],
  ],
];
const COUNTER = [
  [
    [20, 12],
    [26, 12],
    [28, 14],
    [28, 20],
  ],
  [
    [28, 20],
    [28, 26],
    [26, 28],
    [20, 28],
  ],
  [
    [20, 28],
    [14, 28],
    [12, 26],
    [12, 20],
  ],
  [
    [12, 20],
    [12, 14],
    [14, 12],
    [20, 12],
  ],
];
const contour = (cps, k) => {
  const segs = cps.map((P) => mkCubic(...P.map((p) => [p[0] * k, p[1] * k])));
  const last = segs[segs.length - 1].p4;
  segs.push(mkLine(last, segs[0].p1)); // the closing line importers emit
  return segs;
};

for (const k of [0.05, 1, 20]) {
  const contours = [contour(RING, k), contour(COUNTER, k)];
  const mesh = buildLoopBlinnCDT(contours, { fillRule: 'evenodd' });
  if (!mesh) {
    ok(false, `scale ${k}: the partition declined the even-odd ring`);
    continue;
  }
  const recs = mesh.cubicRecs9 || [];
  const withFace = new Set((mesh.cubics || []).map((c) => c._ri9));
  let orphan = 0;
  for (let i = 0; i < recs.length; i++) if (!withFace.has(i)) orphan++;
  ok(
    orphan === 0,
    `scale ${k}: every one of ${recs.length} cubic hull records owns a face (orphans ${orphan})`,
  );
  // 8 cubics, at most a handful of pieces each: a piece count in the hundreds is
  // the runaway split, whatever it then does to the faces.
  ok(recs.length <= 32, `scale ${k}: 8 cubics stay ${recs.length} hull records, not hundreds`);
}

// Control: the same ring wound the way nonzero wants it never reorients, so it
// is not affected and must not change.
{
  const rev = COUNTER.slice()
    .reverse()
    .map((P) => P.slice().reverse());
  const mesh = buildLoopBlinnCDT([contour(RING, 1), contour(rev, 1)], { fillRule: 'nonzero' });
  const recs = (mesh && mesh.cubicRecs9) || [];
  const withFace = new Set(((mesh && mesh.cubics) || []).map((c) => c._ri9));
  let orphan = 0;
  for (let i = 0; i < recs.length; i++) if (!withFace.has(i)) orphan++;
  ok(
    !!mesh && orphan === 0,
    `nonzero, counter already reversed: ${recs.length} records, ${orphan} orphans`,
  );
}

console.log(fail ? `lbHolePieceFaceSmoke: ${fail} failure(s)` : 'lbHolePieceFaceSmoke: PASS');
process.exit(fail ? 1 : 0);

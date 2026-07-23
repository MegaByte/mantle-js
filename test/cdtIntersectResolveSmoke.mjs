// cdtIntersectResolveSmoke.mjs — G4: intersecting-constraint resolution.
// Verifies the opt-in `resolveIntersections` pre-pass splits properly-crossing
// constraints at a shared inserted vertex (CGAL Exact_intersections_tag behaviour),
// so the augmented set has NO crossings and every split edge appears in the CDT.
import { constrainedTriangulate, resolveConstraintIntersections, segsCross, orient2d } from '../src/renderer/cdt.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const edgePresent = (tris, i, j) => tris.some(([a, b, c]) =>
  (a === i && b === j) || (b === i && c === j) || (c === i && a === j) ||
  (a === j && b === i) || (b === j && c === i) || (c === j && a === i));
const noCrossings = (pts, cons) => {
  for (let i = 0; i < cons.length; i++) for (let j = i + 1; j < cons.length; j++) {
    const [a, b] = cons[i], [c, d] = cons[j];
    if (a === c || a === d || b === c || b === d) continue;
    if (segsCross(pts[a], pts[b], pts[c], pts[d])) return false;
  }
  return true;
};

// 1) The canonical X: two diagonals of a square cross at the centre.
{
  const pts = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const cons = [[0, 2], [1, 3]];                 // both diagonals — they cross at (5,5)

  // default (no resolve): the crossing is unresolvable, one diagonal is left absent.
  const def = constrainedTriangulate(pts, cons);
  const bothDefault = edgePresent(def.tris, 0, 2) && edgePresent(def.tris, 1, 3);
  !bothDefault ? ok('default mode: crossing constraints cannot both appear (expected)')
              : fail('default mode unexpectedly resolved the crossing');

  // resolve: expect a centre vertex + 4 split sub-constraints, all present, valid.
  const r = resolveConstraintIntersections(pts, cons);
  r.pts.length === 5 ? ok(`resolve: intersection vertex added (${r.pts.length} pts) at [${r.pts[4].map((v) => v.toFixed(1))}]`)
                    : fail(`resolve: expected 5 pts, got ${r.pts.length}`);
  r.constraints.length === 4 ? ok('resolve: 2 crossing constraints → 4 split sub-constraints') : fail(`resolve: expected 4 constraints, got ${r.constraints.length}`);
  noCrossings(r.pts, r.constraints) ? ok('resolve: augmented constraint set has NO crossings') : fail('resolve: crossings remain after resolution');

  const res = constrainedTriangulate(pts, cons, { resolveIntersections: true });
  const vi = 4;   // the inserted centre vertex
  const allSplit = [[0, vi], [vi, 2], [1, vi], [vi, 3]].every(([i, j]) => edgePresent(res.tris, i, j));
  allSplit ? ok('resolve+triangulate: all 4 split edges present in the CDT') : fail('resolve+triangulate: a split edge is missing');
  // validity: all CCW, area == square
  let total = 0, badCcw = 0;
  for (const [i, j, k] of res.tris) { const A = res.pts[i], B = res.pts[j], C = res.pts[k]; if (orient2d(A, B, C) <= 0) badCcw++; total += Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / 2; }
  badCcw === 0 && Math.abs(total - 100) < 1e-6 ? ok(`resolve+triangulate: valid (all CCW, area ${total.toFixed(2)})`) : fail(`resolve+triangulate invalid: ${badCcw} non-CCW, area ${total}`);
}

// 2) Self-intersecting figure-eight boundary loop (the classic case that a naive
//    CDT mis-handles): a bowtie [0,0]→[10,10]→[10,0]→[0,10]→close crosses itself.
{
  const pts = [[0, 0], [10, 10], [10, 0], [0, 10]];
  const cons = [[0, 1], [1, 2], [2, 3], [3, 0]];      // bowtie: edge 0-1 crosses edge 2-3
  const r = resolveConstraintIntersections(pts, cons);
  r.pts.length > 4 ? ok(`bowtie: crossing resolved, ${r.pts.length - 4} vertex/vertices added`) : fail('bowtie: no intersection vertex added');
  noCrossings(r.pts, r.constraints) ? ok('bowtie: no crossings remain') : fail('bowtie: crossings remain');
  const res = constrainedTriangulate(pts, cons, { resolveIntersections: true });
  res && res.tris && res.tris.every(([i, j, k]) => orient2d(res.pts[i], res.pts[j], res.pts[k]) > 0)
    ? ok(`bowtie: triangulates valid (${res.tris.length} CCW tris)`) : fail('bowtie: invalid triangulation');
}

// 3) Non-crossing input is a no-op (default and resolve identical).
{
  const pts = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const cons = [[0, 1], [1, 2], [2, 3], [3, 0]];
  const r = resolveConstraintIntersections(pts, cons);
  r.pts.length === 4 && r.constraints.length === 4 ? ok('non-crossing input: resolution is a no-op') : fail('non-crossing input altered by resolution');
}

console.log(failures ? `\nCDT-INTERSECT-RESOLVE FAIL (${failures})` : `\nCDT-INTERSECT-RESOLVE PASS`);
process.exit(failures ? 1 : 0);

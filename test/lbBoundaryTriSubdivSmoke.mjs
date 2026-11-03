// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBoundaryTriSubdivSmoke.mjs — a corner triangle carrying ≥2 STRAIGHT boundary
// edges must be split into a centroid fan, so every edge owns a sub-triangle and
// the kind-0 inner ramp fires on ALL of them. Without this, a rectangle's earcut
// (2 corner tris, 2 boundary edges each) leaves 2 of its 4 edges solid to the
// boundary — invisible on opaque fills, a bright over-fill ring on TRANSLUCENT
// ones (a translucent UI panel's background, say). Pure-JS (no GL): guards the mesh
// mechanism directly, since swiftshader under-reports straight-edge AA and would
// mask a render failure.
import { subdivideBoundaryTriPoints } from '../src/renderer/lbFastMesh.js';
import { _setKeyOrigin } from '../src/geom/lbContour.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const P = (x, y) => [x, y];
// rect (0,0)-(100,40); earcut → tri1=(0,0)(100,0)(100,40) [top+right],
//                               tri2=(0,0)(100,40)(0,40) [bottom+left].
_setKeyOrigin([[{ p1: P(0, 0) }, { p1: P(100, 0) }, { p1: P(100, 40) }, { p1: P(0, 40) }]]);
const rectTris = [0, 0, 100, 0, 100, 40, 0, 0, 100, 40, 0, 40];
const edges = [
  { p1: P(0, 0), p2: P(100, 0), nx: 0, ny: -1 }, // top
  { p1: P(100, 0), p2: P(100, 40), nx: 1, ny: 0 }, // right
  { p1: P(100, 40), p2: P(0, 40), nx: 0, ny: 1 }, // bottom
  { p1: P(0, 40), p2: P(0, 0), nx: -1, ny: 0 }, // left
];

const sub = subdivideBoundaryTriPoints(rectTris, edges);
// each corner tri (n=2) → 3 sub-tris; 2 tris → 6 sub-tris → 36 floats
if (sub.length === 36) ok('both corner tris split into centroid fans (6 sub-tris)');
else fail('rect corner tris not both split (got ' + sub.length / 6 + ' tris, want 6)');

// every ORIGINAL boundary edge must survive as an edge of some sub-triangle
const key = (x, y) => Math.round(x) + ',' + Math.round(y);
const subEdgeSet = new Set();
for (let t = 0; t + 5 < sub.length; t += 6) {
  const pts = [
    [sub[t], sub[t + 1]],
    [sub[t + 2], sub[t + 3]],
    [sub[t + 4], sub[t + 5]],
  ];
  for (let i = 0; i < 3; i++) {
    const a = pts[i],
      b = pts[(i + 1) % 3];
    subEdgeSet.add(key(a[0], a[1]) + '|' + key(b[0], b[1]));
    subEdgeSet.add(key(b[0], b[1]) + '|' + key(a[0], a[1]));
  }
}
let allPresent = true;
for (const e of edges) {
  const k = key(e.p1[0], e.p1[1]) + '|' + key(e.p2[0], e.p2[1]);
  if (!subEdgeSet.has(k)) {
    allPresent = false;
    fail('boundary edge lost after subdivision: ' + k);
  }
}
if (allPresent) ok('all 4 boundary edges survive as sub-triangle edges (each can ramp)');

// a triangle with ≤1 boundary edge must be LEFT ALONE (no needless fan)
const oneEdgeTri = [0, 0, 100, 0, 50, 40]; // only (0,0)-(100,0) is a boundary edge
const sub1 = subdivideBoundaryTriPoints(oneEdgeTri, edges);
if (sub1.length === 6) ok('a 1-boundary-edge tri is not subdivided');
else fail('a 1-boundary-edge tri was needlessly split (got ' + sub1.length / 6 + ' tris)');

// no edges → passthrough (defensive)
const sub0 = subdivideBoundaryTriPoints(rectTris, []);
if (sub0 === rectTris) ok('no-edges input is returned unchanged');
else fail('no-edges input was altered');

if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nlbBoundaryTriSubdivSmoke: straight corner tris subdivide so every edge ramps');

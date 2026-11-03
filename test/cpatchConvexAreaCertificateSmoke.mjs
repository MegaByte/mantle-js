// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import {
  certifiedWholeQuadraticShape,
  convexQuadraticContour,
  packCPatchShape,
} from '../src/renderer/cpatchPack.js';
const polygon = (pts) => pts.map((p, i) => ({ t: 'line', P: [p, pts[(i + 1) % pts.length]] }));
const source = polygon([
  [0, 0],
  [8, 0],
  [8, 8],
  [0, 8],
]);
const certify = (curves) => [
  { curves: curves.map((c) => ({ ...c, _convexEnd: convexQuadraticContour(curves) })) },
];
assert(certifiedWholeQuadraticShape([source], certify(source)));
const shifted = [...source.slice(2), ...source.slice(0, 2)];
assert(certifiedWholeQuadraticShape([source], certify(shifted)));
const reversed = source
  .slice()
  .reverse()
  .map((c) => ({ ...c, P: c.P.slice().reverse() }));
assert(certifiedWholeQuadraticShape([source], certify(reversed)));
const changed = structuredClone(source);
changed[0].P[0][0] += Number.EPSILON;
assert(!certifiedWholeQuadraticShape([changed], certify(source)));
assert(!certifiedWholeQuadraticShape([source.slice(0, 3)], certify(source)));
assert(!certifiedWholeQuadraticShape([source, source], certify(source)));
assert(!certifiedWholeQuadraticShape([source], [...certify(source), ...certify(source)]));
assert(!certifiedWholeQuadraticShape([source], [{ curves: source }]));
const nonconvex = polygon([
  [0, 0],
  [8, 0],
  [4, 3],
  [8, 8],
  [0, 8],
]);
assert(!certifiedWholeQuadraticShape([nonconvex], certify(nonconvex)));
const crossing = polygon([
  [0, 0],
  [8, 8],
  [0, 8],
  [8, 0],
]);
assert(!certifiedWholeQuadraticShape([crossing], certify(crossing)));
const cut = structuredClone(source);
cut[0].cut = true;
assert(!certifiedWholeQuadraticShape([cut], certify(cut)));
// These are the actual patch objects the packer hands to the coverage guard.
let seen = [];
const packed = packCPatchShape([source], 0, { onPatches: (ps) => seen.push(...ps) });
assert(packed && certifiedWholeQuadraticShape([source], seen));
const open = source.slice(0, 3);
seen = [];
assert(packCPatchShape([open], 0, { onPatches: (ps) => seen.push(...ps) }));
assert(!certifiedWholeQuadraticShape([open], seen));
console.log(
  'PASS exact source/cycle/reversed certificate and changed, missing, holes, duplicate, nonconvex, crossing, cut, open negative controls',
);

const q = [
  {
    t: 'quad',
    P: [
      [0, 0],
      [4, -4],
      [8, 0],
    ],
  },
  {
    t: 'quad',
    P: [
      [8, 0],
      [12, 4],
      [8, 8],
    ],
  },
  {
    t: 'quad',
    P: [
      [8, 8],
      [4, 12],
      [0, 8],
    ],
  },
  {
    t: 'quad',
    P: [
      [0, 8],
      [-4, 4],
      [0, 0],
    ],
  },
];
const cache = new Map();
assert.equal(packCPatchShape([q], 0, { convCache: cache }).hasQuadraticArea, true);
// the complete-paint certificate (cpatchSimpleArea) takes a paint of several DISJOINT simple contours, holes and
// nesting as one paint under the fill rule, with no shared-cache reuse of an area patch by a different shape.
const other = q.map((c) => ({ ...c, P: c.P.map((p) => [p[0] + 24, p[1]]) }));
assert.equal(packCPatchShape([q, other], 0, { convCache: cache }).hasQuadraticArea, true);
const inner = q.map((c) => ({
  ...c,
  P: c.P.map((p) => [4 + (p[0] - 4) * 0.25, 4 + (p[1] - 4) * 0.25]),
}));
assert.equal(
  packCPatchShape([q, inner], 0, { evenOdd: true, convCache: cache }).hasQuadraticArea,
  true,
);
// ...a crossing is not simple, but the cycles the graph extracts from it are: the certificate takes them as ONE complete paint when they
// certify (exact node coordinates after the snap, pairwise separation with shared nodes as joints); the debug switch restores the
// decomposition, and contours that merely touch stay out of both.
assert.equal(packCPatchShape([crossing], 0, { convCache: new Map() }).hasQuadraticArea, true);
{
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_NO_CYCLE_AREA = 1;
  try {
    assert.equal(packCPatchShape([crossing], 0, { convCache: new Map() }).hasQuadraticArea, false);
  } finally {
    delete globalThis.__CP_NO_CYCLE_AREA;
    delete globalThis.__MANTLE_DEBUG__;
  }
}
// two quads sharing two vertices whose bulges overlap are a crossing too: one union boundary, taken as an area
const touching = q.map((c) => ({ ...c, P: c.P.map((p) => [p[0] + 8, p[1]]) }));
assert.equal(packCPatchShape([q, touching], 0, { convCache: new Map() }).hasQuadraticArea, true);
console.log(
  'PASS complete-paint certificate: disjoint islands, holes and nesting are one paint; a crossing is one paint only through its certified extracted cycles',
);

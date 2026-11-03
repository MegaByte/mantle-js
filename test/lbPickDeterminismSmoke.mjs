// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPickDeterminismSmoke -- the per-row Loop-Blinn / cover decision is a function of (bundle, scale bucket, options), never of TIME.
//
// THE TRAP. A per-bundle pick cache throttled in TIME (LB_PICK_MIN_INTERVAL_MS, which is 0) serves an answer computed at ANOTHER scale
// until the interval passes. A bundle whose first pick came from a small or unsized draw then draws that stale answer after its real size
// arrives: the same asset at the same size draws some rows as Loop-Blinn meshes on one page and as cover quads on another, with identical
// route counts.
//
//   (a) pick at a small scale, then immediately at a large one: the large answer equals a fresh bundle's at the large scale
//       (a throttled cache fails here: it returns the small-scale answer);
//   (b) and back: large then small equals fresh at small;
//   (c) the same scale twice returns the same array (a repeat draw rebuilds nothing), and the pick key moves only when the answer does;
//   (d) the answer never reads the clock: with performance.now frozen, and then jumped by an hour, the same (bundle, scale) gives the same answer.
import { lbShapePicks } from '../src/renderer/lbShapePolicy.js';
import { SEG_CUBIC } from '../src/primitives/seg.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

/// A bundle of `n` cubic fill rows, each `w` em wide (so its device extent is w * sqrt(px2 per em2)), curved enough to take a mesh.
const mkBundle = (n, w) => {
  const m = new Float32Array(48 * n);
  for (let i = 0; i < n; i++) {
    m[48 * i + 2] = w;
    m[48 * i + 3] = w;
    m[48 * i + 7] = 1;
  }
  return {
    numShapes: n,
    metaFloats: m,
    metaFloatsPerShape: 48,
    _geomGen: 0,
    segTypeMask: 4,
    globalBBox: [0, 0, w * 4, w * 4],
    curveFloats: Float32Array.from({ length: 16 * n }, (_, k) =>
      k % 16 === 0 ? SEG_CUBIC : k % 16 < 4 ? 0 : (k % 16) * 0.5,
    ),
    curveRangesByShape: Array.from({ length: n }, (_, i) => ({ begin: 16 * i, end: 16 * i + 16 })),
  };
};
const meshesFor = (b) =>
  Array.from({ length: b.numShapes }, () => ({ vertexCount: 3, verts: new Float32Array(3) }));
/// A renderer whose viewport is `px` pixels for the bundle's 4w-em box: device px per em = px / (4 w).
const rendererAt = (b, px) => ({
  opts: { lbMinBundlePx2: 262144, lbMinExtentPx: 0 },
  viewportSize: () => [px, px],
  arScale: () => [1, 1],
  draw: {},
  _preferNoAa: () => false,
  _preferNoAaMixed: () => false,
});
const key = (a) => (a ? Array.from(a).join('') : 'null');

const N = 20,
  W = 10;
const big = 2048,
  small = 16; // 10 em wide at px / 40 per em: 512 px (mesh) and 4 px (under the bundle size term: cover)
const fresh = (px) => {
  const b = mkBundle(N, W);
  return key(lbShapePicks(rendererAt(b, px), b, meshesFor(b)));
};
const freshSmall = fresh(small),
  freshBig = fresh(big);
ok(
  freshSmall !== freshBig,
  `the two scales give different answers (small ${freshSmall.slice(0, 8)}.. vs big ${freshBig.slice(0, 8)}..)`,
);

{
  const b = mkBundle(N, W),
    ms = meshesFor(b);
  lbShapePicks(rendererAt(b, small), b, ms);
  const got = key(lbShapePicks(rendererAt(b, big), b, ms));
  ok(
    got === freshBig,
    "small then IMMEDIATELY large: the large answer equals a fresh bundle's at the large scale",
  );
}
{
  const b = mkBundle(N, W),
    ms = meshesFor(b);
  lbShapePicks(rendererAt(b, big), b, ms);
  const got = key(lbShapePicks(rendererAt(b, small), b, ms));
  ok(
    got === freshSmall,
    "large then IMMEDIATELY small: the small answer equals a fresh bundle's at the small scale",
  );
}
{
  const b = mkBundle(N, W),
    ms = meshesFor(b),
    R1 = rendererAt(b, big);
  const a1 = lbShapePicks(R1, b, ms),
    k1 = b._lbPickKey | 0,
    a2 = lbShapePicks(R1, b, ms);
  ok(
    a1 === a2 && (b._lbPickKey | 0) === k1,
    'the same scale twice: the same array, the pick key does not move',
  );
}
{
  const realNow = performance.now.bind(performance);
  let t = 1000;
  performance.now = () => t;
  const b = mkBundle(N, W),
    ms = meshesFor(b);
  const x = key(lbShapePicks(rendererAt(b, small), b, ms));
  t += 3600 * 1000;
  const y = key(lbShapePicks(rendererAt(b, big), b, ms));
  const b2 = mkBundle(N, W),
    ms2 = meshesFor(b2);
  t = 5;
  const z = key(lbShapePicks(rendererAt(b2, big), b2, ms2));
  performance.now = realNow;
  ok(
    x === freshSmall && y === freshBig && z === freshBig,
    'the answer is the same with the clock frozen, jumped an hour, or reset',
  );
}
console.log(fail ? `lbPickDeterminismSmoke FAIL (${fail})` : 'lbPickDeterminismSmoke ok');
process.exit(fail ? 1 : 0);

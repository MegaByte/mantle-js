// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// streamMeshStalenessSmoke -- the analytic meshes a lightweight update leaves are the ones of the geometry it was given.
//
// 1. The unchanged-shape skip must compare more than a segment's points. An arc's shape is not in them: a new radius or sweep between the same two points must not keep last frame's mesh.
// 2. A full update must release the lightweight meshes' claim. Left claimed, the analytic builder's claim on the new geometry is refused, and the generation stamp makes the stale meshes read as current.
// CPU, on the meshes.
import assert from 'node:assert/strict';
globalThis.__MANTLE_NO_STATIC_CACHE = true;
const warn = console.warn;
console.warn = () => {};
globalThis.window = { addEventListener: () => {} };
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, updateBundleGeometry, buildStreamableSections, mkLine } =
  await import('../src/index.js');
const { arcToNative } = await import('../src/svg/segment.js');
const { gl } = createFakeGl({ width: 256, height: 256 });
const P = [0, 0],
  Q = [20, 0];
const dome = (r, sweep = 1) => [arcToNative(P, r, r, 0, 0, sweep, Q), mkLine(Q, P)];
const light = { lightweight: true };
const b = createBundle(
  gl,
  buildStreamableSections([{ segs: dome(10), fill: [1, 0, 0, 1] }], [0, 0, 100, 100], light),
);
const reach = () => {
  let lo = Infinity,
    hi = -Infinity;
  const v = b._lbMeshes[0].verts;
  for (let i = 0; i < v.length; i += v.length / b._lbMeshes[0].vertexCount) {
    lo = Math.min(lo, v[i + 1]);
    hi = Math.max(hi, v[i + 1]);
  }
  return [lo, hi];
};
assert.equal(updateBundleGeometry(gl, b, [dome(10)], light).ok, true);
const first = b._lbMeshesRaw[0],
  gen = b._geomGen;
assert.ok(first && !first.slug, 'the premise: the arc is served by a mesh');
const up = reach();
assert.equal(updateBundleGeometry(gl, b, [dome(10)], light).ok, true);
assert.equal(b._lbMeshesRaw[0], first, 'an unchanged arc keeps its mesh');
assert.equal(b._geomGen, gen, 'an unchanged arc keeps its generation');
assert.equal(updateBundleGeometry(gl, b, [dome(10, 0)], light).ok, true);
assert.notEqual(
  b._lbMeshesRaw[0],
  first,
  'a flipped sweep between the same points builds a new mesh',
);
const down = reach();
assert.ok(
  Math.sign(up[0] + up[1]) !== Math.sign(down[0] + down[1]),
  `the mesh is on the other side of the chord (${up} and ${down})`,
);
const flipped = b._lbMeshesRaw[0];
assert.equal(updateBundleGeometry(gl, b, [dome(40, 0)], light).ok, true);
assert.notEqual(
  b._lbMeshesRaw[0],
  flipped,
  'a new radius between the same points builds a new mesh',
);

// A full update, then the analytic route.
const R = createRenderer(gl, taggedShaderSources(), {});
if (R.ready) await R.ready;
R.setViewport(256, 256);
R.setLoopBlinnFill('on');
const tri = (x) => [
  mkLine([x, 0], [x + 10, 0]),
  mkLine([x + 10, 0], [x, 10]),
  mkLine([x, 10], [x, 0]),
];
const c = createBundle(
  gl,
  buildStreamableSections([{ segs: tri(0), fill: [1, 0, 0, 1] }], [0, 0, 100, 100]),
);
assert.equal(updateBundleGeometry(gl, c, [tri(5)], light).ok, true);
const old = c._lbMeshes[0];
assert.equal(updateBundleGeometry(gl, c, [tri(50)], { lightweight: false }).ok, true);
R.prepareBundle(c);
assert.ok(
  c._lbMeshes && c._lbMeshes[0] && c._lbMeshes[0] !== old,
  'the analytic meshes were rebuilt for the new geometry',
);
assert.equal(c._lbGen, c._geomGen);
assert.ok(!c._fillMeshStomps, `no claim was refused (${c._fillMeshStompBy})`);
assert.equal(
  c._lbMeshes[0].verts[0] >= 50,
  true,
  `the mesh is at the new geometry (x ${c._lbMeshes[0].verts[0]})`,
);
R.dispose();
console.warn = warn;
console.log('streamMeshStalenessSmoke PASS');
process.exit(0);

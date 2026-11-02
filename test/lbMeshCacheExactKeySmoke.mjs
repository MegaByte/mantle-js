// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbMeshCacheExactKeySmoke — the Loop-Blinn mesh cache serves a mesh only for the curve bytes it
// was built from, at any scale.
//
// `_lbMeshCache` (morphDraw.js) is shared by every bundle in the process and serves the synchronous
// build prepareBundle runs. A key of the curve floats quantized to an ABSOLUTE 1/4096 unit,
// `(x * 4096) | 0`, is wrong at scale:
//   * at 2^-20 of a drawing every coordinate quantizes to 0, so two DIFFERENT shapes with the same
//     float count would share one entry and the second draw the first one's mesh;
//   * at 2^20 the int32 wrap folds coordinates that differ by a multiple of 2^32 / 4096 / 2^20 onto
//     one key -- the same collision from the other end.
// So the key is the float bits, with a copy kept in the entry, so a hit is only ever the same bytes.
//
// Per scale 2^-20, 1 and 2^20, in a fresh cache, a bundle holding shape A, a DIFFERENT shape B with
// the same float count (one control point moved), and A again:
//   NO COLLISION  A's and B's served meshes are each byte-identical to a fresh build of their own
//                 contours, and B does not get A's pack;
//   NO MISS       the second A is served A's cached pack (the same object), so equal shapes share
//                 an entry at every scale.
// Also: a mesh built with the SDF recogniser off is not served once it is back on.
//
// FAILS WITH A QUANTIZED KEY: at 2^-20 and at 2^20 shape B is served shape A's pack.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');
const { clearLbMeshCaches } = await import('../src/renderer/morphDraw.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { setSdfPrimitivesEnabled } = await import('../src/geom/shapeRecognize.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// A FRESH RENDERER per case as well as a cleared mesh cache: the similarity-orbit cache is per
// renderer and scale-invariant, so a shape built at 2^-20 would otherwise be served, transformed, at 1.
let F = null,
  R = null;
async function fresh() {
  clearLbMeshCaches();
  F = createFakeGl({ width: 128, height: 128 });
  R = createRenderer(F.gl, taggedShaderSources(), { staticUnified: true }); // staticUnified: the smoke is about the unified/Loop-Blinn meshes of a static bundle (fillRouteClass.js)
  if (R.ready) await R.ready;
  R.setViewport(128, 128);
}
const sameBytes = (a, b) =>
  !!a &&
  !!b &&
  a.vertexCount === b.vertexCount &&
  Buffer.compare(
    Buffer.from(
      a.verts.buffer,
      a.verts.byteOffset,
      a.vertexCount * (a.verts.length / Math.max(1, a.vertexCount)) * 4,
    ),
    Buffer.from(
      b.verts.buffer,
      b.verts.byteOffset,
      b.vertexCount * (b.verts.length / Math.max(1, b.vertexCount)) * 4,
    ),
  ) === 0;

/// The prepared (main-thread) set, read before the deferred off-thread build can land on it.
async function prepared(svg) {
  const b = createBundle(F.gl, await importSvg(svg));
  R.prepareBundle(b);
  return { b, meshes: b._lbMeshes ? b._lbMeshes.slice() : null };
}
const blob = (k, bow) => {
  const p = (v) => (v * k).toPrecision(9);
  return `<path fill="#000" d="M${p(20)} ${p(50)} C${p(20)} ${p(20)} ${p(80)} ${p(20)} ${p(80)} ${p(50)} C${p(80)} ${p(bow)} ${p(20)} ${p(80)} ${p(20)} ${p(50)} Z"/>`;
};
const doc = (k, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${100 * k} ${100 * k}">${body}</svg>`;

for (const [name, k] of [
  ['2^-20', 2 ** -20],
  ['1', 1],
  ['2^20', 2 ** 20],
]) {
  console.log(`scale ${name}:`);
  await fresh();
  const { b, meshes } = await prepared(doc(k, blob(k, 80) + blob(k, 95) + blob(k, 80)));
  ok(
    !!meshes && meshes.length === 3 && meshes.every((m) => m && !m.slug && m.vertexCount > 0),
    'all three shapes built a mesh',
  );
  if (!meshes) continue;
  const own = [0, 1, 2].map((s) => {
    const r = b.curveRangesByShape[s];
    const built = buildLbShape(curveRangeToContours(b.curveFloats, r.begin, r.end), false, false);
    return built && built.pk;
  });
  ok(
    sameBytes(meshes[0], own[0]) && sameBytes(meshes[1], own[1]),
    'no collision: A and B are each served the mesh their own contours build',
  );
  ok(meshes[1] !== meshes[0], "...and B is not served A's pack");
  ok(meshes[2] === meshes[0], "no miss: the second A is served A's cached pack");
}

// A setting the build reads, but the curve bytes do not carry.
{
  console.log('the SDF recogniser switch:');
  await fresh();
  const circle =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="30" fill="#000"/></svg>';
  setSdfPrimitivesEnabled(false);
  const off = await prepared(circle);
  setSdfPrimitivesEnabled(true);
  const on = await prepared(circle);
  ok(
    off.meshes && off.meshes[0] && !off.meshes[0].prim,
    'recogniser off: the circle builds a Loop-Blinn mesh',
  );
  ok(
    on.meshes && on.meshes[0] && on.meshes[0].prim === true,
    'recogniser back on: the circle is a primitive, not the cached mesh',
  );
}

if (fail) {
  console.log(`FAIL lbMeshCacheExactKeySmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS lbMeshCacheExactKeySmoke');
process.exit(0);

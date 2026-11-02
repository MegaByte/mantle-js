// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPrepareWorkerParitySmoke — prepareBundle builds the mesh the off-thread build builds, and the
// frame keeps it.
//
// createBundle queues every static bundle's Loop-Blinn build off the main thread (buildLbBundle ->
// buildLbShape per shape), and prepareBundle builds the same bundle synchronously (_ensureLbMeshes).
// The prepared set is what the first frames draw, and the two must agree. A synchronous path that
// serves a shape SIMILAR to one it has already built -- a copy moved, rotated or scaled -- by
// transforming that mesh into place (the similarity tier) takes a different float path from
// building it, and when the off-thread result lands over the prepared set those shapes pop from
// one mesh to another and the bundle pays a second adoption for the rest.
//
// So a static bundle's synchronous build is the builder's answer shape for shape (no similarity
// tier, no derived cache entry, no refresh against a previous triangulation), and a complete
// prepared set is the generation's authoritative one: the off-thread result is not published over
// it. Checked here on a blob and the same blob rotated 30 degrees and scaled 1.5x, which the
// similarity tier would serve from the first:
//   * every prepared mesh is byte-identical to buildLbBundle's on the bundle's own input;
//   * after the deferred build lands (node has no Worker, so requestLbBuild takes its synchronous
//     fallback, which calls that same buildLbBundle), the bundle still holds the prepared set.
// And the geometry-changing path keeps its reuse: a bundle whose geometry generation has moved still
// gets the similarity tier (a pose switch is what it is for).
//
// FAILS WITH THE SIMILARITY TIER ON A STATIC BUNDLE: the rotated copy's prepared mesh differs from
// the worker's, and the landed result replaces the prepared set.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');
const { clearLbMeshCaches } = await import('../src/renderer/morphDraw.js');
const { buildLbBundle, packLbMeshForWire } = await import('../src/renderer/lbBuildCore.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

clearLbMeshCaches();
const F = createFakeGl({ width: 128, height: 128 });
const R = createRenderer(F.gl, taggedShaderSources(), { staticUnified: true }); // staticUnified: the smoke is about the unified/Loop-Blinn meshes of a static bundle (fillRouteClass.js)
if (R.ready) await R.ready;
R.setViewport(128, 128);
const bytesOf = (pk) =>
  pk && !pk.slug && pk.vertexCount > 0
    ? Buffer.from(pk.verts.buffer, pk.verts.byteOffset, pk.verts.byteLength).toString('base64')
    : 'slug';

const BLOB = 'M20 50 C20 20 80 20 80 50 C80 95 20 80 20 50 Z';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200">' +
  `<path fill="#335" d="${BLOB}"/>` +
  `<path fill="#335" transform="translate(180 90) rotate(30) scale(1.5) translate(-50 -50)" d="${BLOB}"/>` +
  '</svg>';
const b = createBundle(F.gl, await importSvg(SVG));
R.prepareBundle(b);
const prepared = b._lbMeshes;
ok(
  Array.isArray(prepared) &&
    prepared.length === 2 &&
    prepared.every((m) => m && !m.slug && m.vertexCount > 0),
  'prepareBundle built both shapes',
);
const res = buildLbBundle({
  curveFloats: b.curveFloats,
  metaFloats: b.metaFloats,
  metaFloatsPerShape: b.metaFloatsPerShape,
  ranges: b.curveRangesByShape,
  numShapes: b.numShapes,
});
const worker = res.packed.map(packLbMeshForWire);
if (Array.isArray(prepared)) {
  for (let s = 0; s < 2; s++) {
    ok(
      bytesOf(prepared[s]) === bytesOf(worker[s]) &&
        (prepared[s].kindMask | 0) === (worker[s].kindMask | 0),
      `shape ${s}${s ? ' (the rotated, scaled copy)' : ''}: the prepared mesh is byte-identical to the off-thread build's`,
    );
  }
}
for (let i = 0; i < 20 && b._lbWorkerPendingGen === (b._geomGen | 0); i++)
  await new Promise((r) => setTimeout(r, 0));
ok(b._lbWorkerPendingGen !== (b._geomGen | 0), 'the deferred off-thread build landed');
ok(
  b._lbMeshes === prepared,
  'the bundle still holds the prepared set: the landed result was not published over it',
);

// The geometry-changing path still reuses a similar shape's mesh: on a fresh renderer and cache, a
// bundle whose geometry generation has moved (as a pose switch or setGeometry leaves it) gets the
// rotated copy by transforming the first shape's mesh -- so its bytes are NOT the builder's.
{
  clearLbMeshCaches();
  const F2 = createFakeGl({ width: 128, height: 128 });
  const R2 = createRenderer(F2.gl, taggedShaderSources(), { staticUnified: true });
  if (R2.ready) await R2.ready;
  const b2 = createBundle(F2.gl, await importSvg(SVG));
  b2._geomGen = 1;
  R2.prepareBundle(b2);
  const m2 = b2._lbMeshes;
  ok(
    Array.isArray(m2) &&
      bytesOf(m2[0]) === bytesOf(worker[0]) &&
      bytesOf(m2[1]) !== bytesOf(worker[1]),
    'a bundle whose geometry has changed still takes the similarity tier for the rotated copy',
  );
}

if (fail) {
  console.log(`FAIL lbPrepareWorkerParitySmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS lbPrepareWorkerParitySmoke');
process.exit(0);

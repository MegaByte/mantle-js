// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Check per-shape mesh budgets in bytes across builders, packers, cached meshes and workers.
// Large curve counts remain eligible. Refused builds report the requested bytes, and the
// conservative bound must not reject meshes that fit the configured budget.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PKG_ROOT } from './_assets.mjs';

const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle, buildLbShape, lbMeshCensus, SLUG_WHY } =
  await import('../src/renderer/lbBuildCore.js');
const { attachMorphDraw } = await import('../src/renderer/morphDraw.js');
const LB = await import('../src/renderer/loopBlinn.js');
const {
  setLbShapeMemoryBudget,
  getLbShapeMemoryBudget,
  lbRawMinVertexBytes,
  lbVertexBytes,
  packLoopBlinnMesh,
  curveRangeToContours,
  LB_VERT_BYTES,
} = LB;

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// A 420-segment closed polyline: 5,064 curve floats, comfortably past the removed 4000-float gate,
// and cheap enough to build several times in a node smoke.
const zig = () => {
  let d = 'M0 260';
  for (let i = 1; i <= 420; i++) d += ` L${(i * 0.9).toFixed(2)} ${260 + (i % 2 ? 14 : 0)}`;
  return d + ' Z';
};
const SVG =
  '<svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">' +
  `<path fill="#c33" d="${zig()}"/></svg>`;

// bundle.meta carries a 32-BYTE HEADER; parseMetaBin strips it. Wrapping it whole shifts every meta
// row by eight floats, which changes the fill rule and the stroke flag the build reads.
const sec = await importSvg(SVG, { preserveViewport: true });
const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const input = {
  curveFloats: new Float32Array(sec.curves),
  metaFloats: pm.metaFloats,
  metaFloatsPerShape: pm.floatsPerShape,
  ranges: sec.curveRangesByShape,
  numShapes: sec.numShapes,
};
const floats = sec.curveRangesByShape[0].end - sec.curveRangesByShape[0].begin;
ok(floats > 4000, `the fixture is ${floats} curve floats — past 4000`);

// ── 1. THE DEFAULT IS NO LIMIT ──────────────────────────────────────────────
ok(getLbShapeMemoryBudget() === Infinity, 'the per-shape memory budget defaults to no limit');

// ── 2. THE GATE IS GONE: the shape builds, on the build core ────────────────
const res = buildLbBundle(input);
const census = lbMeshCensus({ numShapes: 1, _lbMeshes: res.packed, _lbSlugWhy: res.why });
ok(
  census.real === 1 && census.tooComplex === 0,
  `a shape past 4000 floats BUILDS (${JSON.stringify(census)})`,
);
const exactBytes = lbVertexBytes(res.packed[0].vertexCount);
ok(
  exactBytes === res.packed[0].verts.byteLength,
  `its packed stream is ${exactBytes} bytes (${res.packed[0].vertexCount} verts x ${LB_VERT_BYTES})`,
);
ok(res.memWants.length === 0, 'and with no budget nothing is refused for memory');

// ── 3. ...and on the MAIN-THREAD path too ───────────────────────────────────
// The two build paths must not disagree about a limit.
const glStub = () =>
  new Proxy(
    {},
    { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
  );
const makeR = () => {
  const R = {
    gl: glStub(),
    opts: {},
    draw: {},
    _lbFillMode: 'on',
    _lbSlugOnly: false,
    _lbSlugFallback: true,
  };
  Object.assign(R, {
    buildLoopBlinnMesh: LB.buildLoopBlinnMesh,
    buildLoopBlinnCDT: LB.buildLoopBlinnCDT,
    refreshLoopBlinnMesh: LB.refreshLoopBlinnMesh,
    packLoopBlinnMesh: LB.packLoopBlinnMesh,
    curveRangeToContours: LB.curveRangeToContours,
    lbCanonicalFrame: LB.lbCanonicalFrame,
    lbCanonicalHash: LB.lbCanonicalHash,
    lbCanonicalHashes: LB.lbCanonicalHashes,
    transformLoopBlinnRaw: LB.transformLoopBlinnRaw,
  });
  attachMorphDraw(R);
  return R;
};
const liveOf = () => ({
  curveFloats: input.curveFloats,
  curveRangesByShape: input.ranges,
  metaFloats: pm.metaFloats,
  metaFloatsPerShape: pm.floatsPerShape,
  numShapes: 1,
  segTypeMask: sec.segTypeMask,
  _geomGen: 0,
});
{
  const R = makeR(),
    live = liveOf();
  R.prepareBundle(live);
  const c = lbMeshCensus(live);
  ok(
    c.real === 1 && c.tooComplex === 0,
    `prepareBundle builds it too, and books no complexity refusal (${JSON.stringify(c)})`,
  );
}

// ── 4. THE PACKER'S QUESTION: the exact count ───────────────────────────────
// A budget one byte under the exact stream refuses it, and says exactly what it wanted.
const contours = curveRangeToContours(
  input.curveFloats,
  input.ranges[0].begin,
  input.ranges[0].end,
);
setLbShapeMemoryBudget(exactBytes - 1);
{
  const built = buildLbShape(contours, false, false);
  ok(
    built && built.pk && built.pk.overMemory === true && built.pk.overBudget === true,
    'a stream one byte over the budget is refused, and reads as over-budget to every existing caller',
  );
  ok(
    built.pk.wantBytes === exactBytes,
    `...and reports the EXACT bytes it wanted (${built.pk.wantBytes})`,
  );
  ok(
    built.pk.verts.length === 0 && built.pk.vertexCount === 0,
    '...and hands back no stream at all',
  );
}
setLbShapeMemoryBudget(exactBytes);
{
  const built = buildLbShape(contours, false, false);
  ok(
    built && built.pk && !built.pk.overMemory && built.pk.verts.byteLength === exactBytes,
    'a budget exactly equal to the stream admits it — the bar is > and not >=',
  );
}

// ── 5. THE BUILDER'S QUESTION: asked against the RAW mesh, before allocating ─
// This is what "not only at draw" means. The draw path's whole-bundle projection cannot stop a
// stream being built and packed; the builder's bound can, and it costs no allocation.
const rawMesh = (() => {
  setLbShapeMemoryBudget(0); // 0 = no limit, so this pack is the real one
  const m = LB.buildLoopBlinnMesh(contours, true, 'nonzero');
  LB.dropDegenerateFaces(m);
  return m;
})();
const floorBytes = lbRawMinVertexBytes(rawMesh);
ok(
  floorBytes > 0 && floorBytes <= exactBytes,
  `the builder's bound (${floorBytes} B) is a LOWER bound on the pack (${exactBytes} B) — ` +
    'so a mesh it refuses could never have fitted',
);
setLbShapeMemoryBudget(floorBytes - 1);
{
  const built = buildLbShape(contours, false, false);
  ok(
    built && built.pk && built.pk.overMemory === true && built.pk.wantBytes === floorBytes,
    `under the bound the BUILDER refuses, reporting its own figure (${built.pk.wantBytes} B), ` +
      'with no vertex stream allocated',
  );
}
// ...and the packer is still the one that answers exactly: between the two figures the builder
// lets it through and the packer refuses, with the larger number.
if (floorBytes < exactBytes) {
  setLbShapeMemoryBudget(floorBytes);
  const built = buildLbShape(contours, false, false);
  ok(
    built && built.pk && built.pk.overMemory === true && built.pk.wantBytes === exactBytes,
    `between the two figures the builder passes and the PACKER refuses, at ${exactBytes} B`,
  );
} else {
  ok(false, 'the bound equals the exact count, so the two questions cannot be told apart here');
}
setLbShapeMemoryBudget(0);

// ── 5b. ...AND THE CACHES ARE A THIRD PLACE TO ASK ─────────────────────────
// There is ONE build path (`_ensureLbMeshes` calls `buildLbShape`), so the
// builder's question and the draw path's question are the same question — EXCEPT on the cache
// paths, which hand back a pack nobody is about to build. A cached pack was produced under
// whatever budget was in force when it was built, so asking only where a mesh is BUILT lets a
// cached monster walk straight through a budget the caller has since lowered: a limit that holds
// until it matters. This drives the exact mesh cache (module-level, keyed on the curve floats) and
// then lowers the budget under it.
{
  const R = makeR();
  R.prepareBundle(liveOf()); // populates the cache at no limit
  R.setLoopBlinnShapeMemoryBudget(4096);
  const live2 = liveOf(); // fresh bundle, same bytes -> cache HIT
  R.prepareBundle(live2);
  ok(
    live2._lbMeshes === null && live2._lbHasSlug === true,
    'a CACHED pack is refused when the budget is lowered under it — the cache is not a way past it',
  );
  ok(
    live2._lbMemWants && live2._lbMemWants.length === 1 && live2._lbMemWants[0].bytes > 4096,
    `...and the refusal says the same thing a built one does: ${JSON.stringify(live2._lbMemWants)}`,
  );
  R.setLoopBlinnShapeMemoryBudget(0);
}

// ── 6. THE REFUSAL IS REPORTED ──────────────────────────────────────────────
// Through the build core...
{
  const r2 = buildLbBundle({ ...input, shapeMemBytes: 4096 });
  const c2 = lbMeshCensus({ numShapes: 1, _lbMeshes: r2.packed, _lbSlugWhy: r2.why });
  ok(
    c2.overMemory === 1 && c2.declined === 0,
    'a memory refusal is its own cause, not a decline and not a vertex-cap over-budget',
  );
  ok(
    r2.why[0] === SLUG_WHY.OVER_MEMORY,
    'the cause crosses the worker boundary in the `why` array',
  );
  ok(
    r2.memWants.length === 1 && r2.memWants[0].shape === 0 && r2.memWants[0].bytes > 4096,
    `and the build names the shape and the size: ${JSON.stringify(r2.memWants)}`,
  );
  ok(
    getLbShapeMemoryBudget() === Infinity,
    'the per-build budget is restored afterwards — a build cannot leak its limit into the next one',
  );
}
// ...and through the main-thread path, onto the bundle and the renderer's own counters.
{
  const R = makeR(),
    live = liveOf();
  R.setLoopBlinnShapeMemoryBudget(4096);
  R.prepareBundle(live);
  // One shape, refused: the bundle has nothing analytic left, so it goes to Slug whole — which is
  // exactly what a per-shape budget is allowed to do, and what it must SAY it did.
  ok(
    live._lbMeshes === null && live._lbHasSlug === true,
    'prepareBundle routes the refused shape to Slug',
  );
  ok(
    live._lbMemWants && live._lbMemWants.length === 1 && live._lbMemWants[0].bytes > 4096,
    `the bundle says which shape wanted what: ${JSON.stringify(live._lbMemWants)}`,
  );
  ok(
    (R._lbShapeMemDeclined | 0) === 1 && (R._lbShapeMemWantedBytes | 0) > 4096,
    `and the renderer counters debugStats reads are set (${R._lbShapeMemDeclined}, ${R._lbShapeMemWantedBytes} B)`,
  );
  R.setLoopBlinnShapeMemoryBudget(0);
  ok(getLbShapeMemoryBudget() === Infinity, '0 clears the budget back to no limit');
}

// ── 7. IT REACHES THE WORKER ────────────────────────────────────────────────
// The budget is a MODULE flag and the worker has its own copy of that module, so it has to ride
// the build input, as preferBezout and the SDF recognizer switch do.
// Checked at the source, because a node smoke has no browser Worker to post to.
const poolSrc = readFileSync(path.join(PKG_ROOT, 'src/renderer/lbWorkerPool.js'), 'utf8');
const wkSrc = readFileSync(path.join(PKG_ROOT, 'src/renderer/lbBuild.worker.js'), 'utf8');
ok(
  /shapeMemBytes:\s*\(?getLbShapeMemoryBudget\(\)/.test(poolSrc),
  'requestLbBuild puts the budget in the input it posts',
);
ok(
  /shapeMemBytes:\s*input\.shapeMemBytes/.test(poolSrc),
  '...and the no-Worker synchronous fallback passes it too',
);
ok(
  /shapeMemBytes,?\s*\}\s*=\s*data/.test(wkSrc) &&
    /shapeMemBytes:\s*shapeMemBytes\s*\|\|\s*0/.test(wkSrc),
  'the worker reads it off the message and hands it to buildLbBundle',
);
ok(/memWants/.test(wkSrc), 'and posts the refusals back');

console.log(fail ? `\nLB-SHAPE-MEM-BUDGET FAIL (${fail})` : '\nLB-SHAPE-MEM-BUDGET PASS');
process.exit(fail ? 1 : 0);

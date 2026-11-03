// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbHookOwnershipSmoke — a renderer's Loop-Blinn build hooks belong to ITS canvas, and a build
// queued on one renderer must not be swallowed by another.
//
// Every renderer registers a builder (the off-thread whole-bundle build) and a preparer (the idle
// drain that finishes partial and morph builds). The registry scopes both to the canvas a hook
// speaks for, because a bundle belongs to exactly one context: createBundle puts its textures
// there. Without that scope, two separate failures follow:
//
//   THE BUILDER ANSWERS FOR ANOTHER CANVAS. A `_runLbBuilders` that walks the whole process, newest
//   first, and takes the first hook that does not decline meets a CPatch renderer's builder, which
//   answers "handled" for every bundle by design (it does not want LB meshes built behind CPatch's
//   back) — so a second canvas running CPatch would silently claim every bundle created on the
//   FIRST canvas, and that canvas's renderer would draw Slug for the rest of the session with
//   nothing reporting a decline. The same crossing hands a bundle's build to the wrong renderer's
//   route mode, memory budget and adopt options even when it does produce meshes.
//
//   THE PREPARER MUST BE A CHAIN, NOT ONE SLOT. With only the LAST-registered preparer called, and
//   the queue entry consumed before it runs, two renderers anywhere in the process would drain
//   every idle build the first one queued into the second, and a second renderer that declines
//   (CPatch, forceSlug, or a plain setLoopBlinnFill('off') peer — which is what the demo creates
//   for AAC/GWN/hard) would drop the work on the floor with nothing to retry it. That is the
//   `enqueueLbPrepare` path that "idle finishes it even without draws" depends on, and the only
//   thing that builds a morph bundle's pair meshes off the draw path.
//
// engineSwitchIndependenceSmoke's lbBuilderOwnership case covers the builder for Slug-only peers in a browser. This drives both
// halves, scoped to a context, from Node against a stub GL: no GPU, no browser.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const B = await import('../src/renderer/bundle.js');
const { attachMorphDraw } = await import('../src/renderer/morphDraw.js');
const LB = await import('../src/renderer/loopBlinn.js');

// The same cubic blob engineSwitchPathsSmoke uses: the per-shape policy gives it a mesh at every
// size, so the build paths below are declined by the hook under test and by nothing else.
const SVG =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 Z"/></svg>';
const sections = await importSvg(SVG, { preserveViewport: true });

// Every GL entry point answers null: attachMorphDraw reads uniform locations at attach time and
// createBundle uploads textures, neither of which needs a real answer, and nothing here draws.
const makeGl = () =>
  new Proxy(
    {},
    { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
  );

function makeRenderer(gl, opts = {}) {
  const R = { gl, opts, draw: {}, _lbFillMode: 'auto', _lbSlugOnly: false, _lbSlugFallback: true };
  // The pure builders the renderer hangs on itself (renderer.js does the same assignment).
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
}
// What renderer.dispose() does with the hooks.
const disposeHooks = (R) => {
  B.removeLbBuilder(R.gl, R._lbBuilderFn);
  B.removeLbPreparer(R.gl, R._lbPreparerFn);
};
// A renderer pinned to Slug — setLoopBlinnFill('off'), which is every non-LB engine in the demo.
const slugOnly = (R) => {
  R._lbSlugOnly = true;
  R._lbFillMode = 'off';
  return R;
};

// `_lbWorkerPendingGen` is set by the builder at the moment it hands the bundle to the worker, so
// it says which renderer's builder actually took the bundle rather than what eventually appeared.
const askedWorker = (b) => b._lbWorkerPendingGen !== undefined;
const builtMeshes = (b) =>
  Array.isArray(b._lbMeshes) && b._lbMeshes.some((m) => m && !m.slug && (m.vertexCount | 0) > 0);

// A bundle-shaped object for the preparer, built from the importer's sections. bundle.meta carries a
// 32-BYTE HEADER; wrapping it whole shifts every meta row by eight floats and the shape stops
// routing, so parseMetaBin does the slicing.
function rawBundle() {
  const pm = B.parseMetaBin(sections.meta, sections.metaFloatsPerShape);
  return {
    curveFloats: new Float32Array(sections.curves),
    curveRangesByShape: sections.curveRangesByShape,
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    numShapes: sections.numShapes,
    segTypeMask: sections.segTypeMask,
    _geomGen: 0,
  };
}
// The idle drain is scheduled through requestIdleCallback, else setTimeout(0).
const drainIdle = () => new Promise((r) => setTimeout(r, 60));

// ─── 1. the builder answers only for its own canvas ─────────────────────────
console.log('\n  builder, two canvases:');
{
  const glA = makeGl(),
    glB = makeGl();
  const RA = makeRenderer(glA); // canvas A wants Loop-Blinn
  const RB = makeRenderer(glB, { cpatchFill: true }); // canvas B runs CPatch, created SECOND
  const bA = B.createBundle(glA, sections);
  ok(askedWorker(bA), "a CPatch renderer on another canvas does not claim canvas A's bundle");
  const bB = B.createBundle(glB, sections);
  ok(
    !askedWorker(bB),
    "...and canvas A's renderer does not build LB for canvas B, which asked for CPatch",
  );
  disposeHooks(RA);
  disposeHooks(RB);
}
{
  // The one crossing that is NOT a matter of opinion: a disposed renderer's hook must leave with it,
  // and a canvas with no renderer left must not borrow one from elsewhere.
  const glA = makeGl(),
    glB = makeGl();
  const RA = makeRenderer(glA);
  const RB = makeRenderer(glB);
  disposeHooks(RA);
  const bA = B.createBundle(glA, sections);
  ok(
    !askedWorker(bA),
    'a bundle on a canvas whose renderer is gone gets no build from a live renderer elsewhere',
  );
  disposeHooks(RB);
}
{
  // ...and the property the lbBuilderOwnership case pins, at Node level: peers SHARING a canvas are a
  // chain, so a Slug-only one declines and the LB renderer beneath it still builds.
  const gl = makeGl();
  const RA = makeRenderer(gl);
  const RB = slugOnly(makeRenderer(gl));
  const b = B.createBundle(gl, sections);
  ok(
    askedWorker(b),
    'a Slug-only peer on the SAME canvas declines and the LB renderer under it builds',
  );
  disposeHooks(RA);
  disposeHooks(RB);
}

// ─── 2. the preparer is a chain, scoped to the canvas ───────────────────────
console.log('\n  idle preparer:');
{
  const gl = makeGl();
  const RA = makeRenderer(gl);
  const b = rawBundle();
  B.enqueueLbPrepare(gl, b);
  await drainIdle();
  // Also the harness's own honesty check: if the meta rows were mis-sliced this control would build
  // nothing and every "not built" result below would be fiction.
  ok(builtMeshes(b), 'CONTROL: one renderer, one canvas — the idle preparer builds');
  disposeHooks(RA);
}
{
  const gl = makeGl();
  const RA = makeRenderer(gl);
  const RB = makeRenderer(gl, { cpatchFill: true }); // newest, and it declines every bundle
  const b = rawBundle();
  B.enqueueLbPrepare(gl, b);
  await drainIdle();
  ok(
    builtMeshes(b),
    'a CPatch peer on the same canvas passes the bundle down instead of dropping it',
  );
  disposeHooks(RA);
  disposeHooks(RB);
}
{
  const gl = makeGl();
  const RA = makeRenderer(gl);
  const RB = slugOnly(makeRenderer(gl)); // newest — what the demo creates for AAC/GWN
  const b = rawBundle();
  B.enqueueLbPrepare(gl, b);
  await drainIdle();
  ok(
    builtMeshes(b),
    'a Slug-only peer on the same canvas passes the bundle down instead of dropping it',
  );
  disposeHooks(RA);
  disposeHooks(RB);
}
{
  const glA = makeGl(),
    glB = makeGl();
  const RA = makeRenderer(glA);
  const RB = makeRenderer(glB, { cpatchFill: true });
  const b = rawBundle();
  B.enqueueLbPrepare(glA, b);
  await drainIdle();
  ok(builtMeshes(b), "a renderer on another canvas never sees canvas A's queued build");
  disposeHooks(RA);
  disposeHooks(RB);
}
{
  // NEUTRALITY, the other way. A lone CPatch renderer must still decline — the chain must not turn
  // "nobody wants this" into "somebody built it".
  const gl = makeGl();
  const RA = makeRenderer(gl, { cpatchFill: true });
  const b = rawBundle();
  B.enqueueLbPrepare(gl, b);
  await drainIdle();
  ok(!builtMeshes(b), 'a lone CPatch renderer still declines the idle build');
  disposeHooks(RA);
}
{
  const glA = makeGl(),
    glB = makeGl();
  const RB = makeRenderer(glB);
  const b = rawBundle();
  B.enqueueLbPrepare(glA, b); // canvas A has no renderer at all
  await drainIdle();
  ok(
    !builtMeshes(b),
    'a build queued for a canvas with no renderer is not run by a renderer elsewhere',
  );
  disposeHooks(RB);
}

{
  const gl = makeGl(),
    peer = makeRenderer(gl),
    b = rawBundle();
  const meshes = [{ cpatch: true, vertexCount: 6 }];
  Object.assign(b, { _fillMeshOwner: 'cpatch', _cpatchBuilt: 1, _lbGen: 0, _lbMeshes: meshes });
  B.enqueueLbPrepare(gl, b);
  await drainIdle();
  ok(
    b._fillMeshOwner === 'cpatch' && b._cpatchBuilt === 1 && b._lbMeshes === meshes,
    'an idle LB peer preserves a live CPatch mesh claim',
  );
  disposeHooks(peer);
}

{
  const gl = makeGl(),
    peer = makeRenderer(gl),
    b = rawBundle();
  peer.setLoopBlinnShapeMemoryBudget(1);
  peer._lbBuilderFn(b);
  const meshes = [{ cpatch: true, vertexCount: 6 }];
  Object.assign(b, { _fillMeshOwner: 'cpatch', _cpatchBuilt: 1, _lbGen: 0, _lbMeshes: meshes });
  await drainIdle();
  peer.setLoopBlinnShapeMemoryBudget(Infinity);
  ok(
    b._fillMeshOwner === 'cpatch' && b._lbMeshes === meshes,
    'a late declined LB build preserves the newer CPatch mesh claim',
  );
  disposeHooks(peer);
}

{
  const gl = makeGl(),
    b = rawBundle(),
    callbacks = [];
  const savedIdle = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = (cb) => {
    callbacks.push(cb);
    return callbacks.length;
  };
  let seen = 0;
  const marker = (candidate) => {
    if (candidate === b) seen++;
    return false;
  };
  B.setLbPreparer(gl, marker);
  try {
    B.enqueueLbPrepare(gl, b);
    callbacks.shift()({ didTimeout: false, timeRemaining: () => 0 });
    ok(seen === 0 && callbacks.length === 1, 'an exhausted idle budget defers preparation');
    callbacks.shift()({ didTimeout: true, timeRemaining: () => 0 });
    ok(seen === 1, 'an expired idle callback makes bounded progress with zero idle time');
  } finally {
    while (callbacks.length) callbacks.shift()({ didTimeout: false, timeRemaining: () => 100 });
    if (savedIdle === undefined) delete globalThis.requestIdleCallback;
    else globalThis.requestIdleCallback = savedIdle;
    B.removeLbPreparer(gl, marker);
  }
}

// ─── 3. the signature is the guard ──────────────────────────────────────────
// Scoping only holds while every caller passes a context. A call site that forgets one would queue
// onto `undefined` and silently never run, which is the quietest possible version of this defect —
// so the arity is asserted, and the source is checked for a bare one-argument call.
console.log('');
ok(
  B.setLbBuilder.length === 2 &&
    B.removeLbBuilder.length === 2 &&
    B.setLbPreparer.length === 2 &&
    B.removeLbPreparer.length === 2 &&
    B.enqueueLbPrepare.length === 2,
  'every LB hook entry point takes the context as its first argument',
);
const callers = [];
for (const rel of [
  'src/renderer/morphDraw.js',
  'src/renderer/renderer.js',
  'src/renderer/bundle.js',
]) {
  const code = readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  // A call whose first argument is not a context: `enqueueLbPrepare(bundle)`, `setLbBuilder(fn)`.
  if (
    /\b(?:set|remove)Lb(?:Builder|Preparer)\(\s*(?!gl\b|R\.gl\b)[A-Za-z_$]/.test(code) ||
    /\benqueueLbPrepare\(\s*(?!gl\b|R\.gl\b)[A-Za-z_$]/.test(code)
  )
    callers.push(rel);
}
ok(
  callers.length === 0,
  `no LB hook call site drops the context${callers.length ? ' (' + callers.join(', ') + ')' : ''}`,
);

console.log(fail ? `\nLB-HOOK-OWNERSHIP FAIL (${fail})` : '\nLB-HOOK-OWNERSHIP PASS');
process.exit(fail ? 1 : 0);

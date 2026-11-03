// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// instancedCompactCacheNodeSmoke -- alternating instanced assets retain their compacted header-free meshes instead of re-uploading every frame, on the driver
// model (test/_pendingGl.mjs with a 20 ms link): a raw renderer, Loop-Blinn off, two bundles of the same sections, the loading call, then
//   fast instancing  a second round of drawBundleInstanced over both bundles uploads nothing, allocates no cover buffer, repeats no vertex-attribute setup and
//                    clears depth/stencil once per frame;
//   normal path      warmed until quiet, six counted alternations of drawBundle upload nothing and allocate nothing;
//   eligibility      the instanced eligibility cache is cull-aware: a stale negative decision is recomputed after the cull generation moves, and the next draw
//                    takes the fast path and issues its instanced draw (the pictures of that path are pinned in the render lane by bundleInstancedSmoke's
//                    instancedBundleRenderDiff case, on this same fixture);
// and the MUTATION PROOF that the normal-path guard catches what it guards against:
//   unmutated                   -> the counted window has no upload and no allocation (PASS)
//   __MANTLE_MUTATE='streamKey' -> a per-draw counter in the unified stream cache identity: every draw misses, the stream is rebuilt and re-uploaded (must FAIL the guard)
//   __MANTLE_MUTATE='coverDirty'-> the cover mesh is re-uploaded each time the other bundle drew in between (must FAIL the guard)
// (the mutations are test-only options of the renderer, live only under __MANTLE_DEBUG__.)
// Then MORE assets than the compact cache's cap of 8 (24 bundles, each drawn instanced in every frame):
//   working set      every frame after the first draws all 24 through the fast path with no upload and no allocation, and neither an asset drawn
//                    between frames nor one joining mid-frame evicts a mesh the scene is drawing;
//   memory           a shrunken scene gives back all but the cap two frames later (the fillStream bytes fall with it), the memory budget evicts idle
//                    meshes between frames ('instancedMeshes' in the eviction order) and the next frame rebuilds them, and without frames the cap alone holds.
import { readFileSync } from 'node:fs';
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
const SVG = readFileSync(
  new URL('../examples/smoke/instancedBundleRenderDiff__SVG.svg', import.meta.url),
  'utf8',
);
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

async function run(mutation) {
  globalThis.__MANTLE_MUTATE = mutation;
  const W = createPendingGl({ linkMs: 20, pipelineMs: 0 }),
    gl = W.gl;
  const R = createRenderer(gl, taggedShaderSources(), { aacPoints: false });
  await R.ready.catch(() => {});
  W.release && W.release();
  R.setViewport(256, 256);
  R.setLoopBlinnFill('off');
  const sections = await importSvg(SVG);
  const first = createBundle(gl, sections),
    second = createBundle(gl, sections);
  let uploads = 0,
    allocs = 0,
    attrSetup = 0,
    resourceClears = 0,
    instancedDraws = 0;
  const bd = gl.bufferData;
  gl.bufferData = (t, d, u, ...r) => {
    if (ArrayBuffer.isView(d)) uploads++;
    return bd(t, d, u, ...r);
  };
  const cb = gl.createBuffer;
  gl.createBuffer = (...a) => {
    allocs++;
    return cb(...a);
  };
  const vap = gl.vertexAttribPointer;
  gl.vertexAttribPointer = (...a) => {
    attrSetup++;
    return vap(...a);
  };
  const clr = gl.clear;
  gl.clear = (mask) => {
    if (mask & (gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)) resourceClears++;
    return clr(mask);
  };
  const dai = gl.drawArraysInstanced;
  gl.drawArraysInstanced = (mode, first, count, n, ...r) => {
    if (count > 0 && n === instances.length) instancedDraws++;
    return dai(mode, first, count, n, ...r);
  };
  const instances = [{}, {}];
  const draw = (b) => {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundleInstanced(b, instances);
    R.endFrame();
  };
  const drawNormal = (b) => {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
  };
  R.prewarmBundle(first);
  R.prewarmBundle(second);
  R.precompileFills();
  draw(first);
  draw(second);
  uploads = 0;
  allocs = 0;
  attrSetup = 0;
  resourceClears = 0;
  draw(first);
  draw(second);
  const fast = { uploads, allocs, attrSetup, resourceClears };
  // the same warm-until-quiet and six counted alternations as the browser smoke
  for (let quiet = 0, i = 0; i < 60 && quiet < 3; i++) {
    uploads = 0;
    allocs = 0;
    drawNormal(first);
    drawNormal(second);
    quiet = uploads || allocs ? 0 : quiet + 1;
  }
  uploads = 0;
  allocs = 0;
  for (let i = 0; i < 6; i++) {
    drawNormal(first);
    drawNormal(second);
  }
  const normal = { uploads, allocs };
  // Eligibility is cached, but occlusion can replace drawList without a geometry change. Seed an intentionally stale negative decision, then advance the cull
  // generation: the next public draw must recompute and take the observable compact fast path.
  first._instSimpleCache = {
    gen: first._geomGen | 0,
    cullGen: first._cullGen | 0,
    hasMask: false,
    ok: false,
  };
  first._cullGen++;
  const fastBefore = R.debugStats.instancedFastCount;
  instancedDraws = 0;
  draw(first);
  const routeCache = { fastDelta: R.debugStats.instancedFastCount - fastBefore, instancedDraws };
  R.dispose();
  globalThis.__MANTLE_MUTATE = undefined;
  return { fast, normal, routeCache };
}
// A scene that draws more instanced assets per frame than the compact cache's entry cap (a forest of tree variants): every frame after the first
// is served from the cache, a working set that shrinks gives its meshes back within two frames, and the memory budget can free idle meshes.
const MANY = 24;
async function manyRig() {
  const W = createPendingGl({ linkMs: 20, pipelineMs: 0 }),
    gl = W.gl;
  const R = createRenderer(gl, taggedShaderSources(), { aacPoints: false });
  await R.ready.catch(() => {});
  W.release && W.release();
  R.setViewport(256, 256);
  R.setLoopBlinnFill('off');
  const sections = await importSvg(SVG);
  const bundles = Array.from({ length: MANY }, () => createBundle(gl, sections));
  for (const b of bundles) R.prewarmBundle(b);
  R.precompileFills();
  const n = { uploads: 0, allocs: 0, deletes: 0 };
  const bd = gl.bufferData;
  gl.bufferData = (t, d, u, ...r) => {
    if (ArrayBuffer.isView(d)) n.uploads++;
    return bd(t, d, u, ...r);
  };
  const cb = gl.createBuffer;
  gl.createBuffer = (...a) => {
    n.allocs++;
    return cb(...a);
  };
  const dlb = gl.deleteBuffer;
  gl.deleteBuffer = (...a) => {
    n.deletes++;
    return dlb(...a);
  };
  const instances = [{}, {}];
  // One pass over `list`, inside a frame or (framed false) outside any; returns what it uploaded, allocated, deleted and drew fast.
  const pass = (list, framed = true) => {
    const fast0 = R.debugStats.instancedFastCount;
    n.uploads = n.allocs = n.deletes = 0;
    if (framed) R.beginFrame([1, 1, 1, 1]);
    for (const b of list) R.drawBundleInstanced(b, instances);
    if (framed) R.endFrame();
    return { ...n, fast: R.debugStats.instancedFastCount - fast0 };
  };
  const meshBytes = () => R.getMemoryStats({ bundles: false }).gpu.byCategory.fillStream.bytes;
  const done = () => {
    for (const b of bundles) b.dispose();
    R.dispose();
  };
  return { R, gl, sections, bundles, pass, meshBytes, done };
}
async function runMany() {
  const { R, gl, sections, bundles, pass, meshBytes, done } = await manyRig();
  const out = { first: pass(bundles), steady: [] };
  for (let i = 0; i < 3; i++) out.steady.push(pass(bundles));
  // A new asset is drawn between frames (outside any frame), then joins the scene in the middle of a frame: neither evicts a mesh the
  // scene is drawing.
  const joined = createBundle(gl, sections);
  R.prewarmBundle(joined);
  out.between = pass([joined], false);
  out.joined = pass([...bundles.slice(0, MANY / 2), joined, ...bundles.slice(MANY / 2)]);
  const wide = meshBytes();
  // The scene shrinks to 4 assets: the other meshes stay one more frame (the last frame's working set), then the cache is back to its cap.
  out.shrink = [];
  for (let i = 0; i < 3; i++) out.shrink.push(pass(bundles.slice(0, 4)));
  out.meshBytes = { wide, narrow: meshBytes() };
  out.narrowAgain = pass(bundles.slice(0, 4));
  // The memory budget: between frames nothing is in use, so a budget below the total frees idle meshes, least recently used first.
  pass(bundles);
  const total0 = R.getMemoryStats({ bundles: false }).gpu.totalBytes;
  R.setMemoryBudget(total0 - 1);
  const s = R.getMemoryStats({ bundles: false });
  out.budget = {
    evicted: s.policy.evictions.instancedMeshes || null,
    total: s.gpu.totalBytes,
    budget: total0 - 1,
    order: s.policy.order,
  };
  R.setMemoryBudget(null);
  out.afterBudget = pass(bundles);
  joined.dispose();
  done();
  return out;
}
// Without frames (beginFrame never called) there is no working set to protect: the cache holds the cap and no more.
async function runFrameless() {
  const { bundles, pass, meshBytes, done } = await manyRig();
  pass(bundles.slice(0, 8), false);
  const atCap = meshBytes();
  const wide = pass(bundles, false);
  const out = { atCap, after: meshBytes(), deletes: wide.deletes };
  done();
  return out;
}

const base = await run(undefined);
ok(
  base.fast.uploads === 0,
  `fast instancing re-uploads no normal cover mesh (${base.fast.uploads} uploads)`,
);
ok(
  base.fast.allocs === 0,
  `fast instancing allocates no normal cover buffer (${base.fast.allocs} allocations)`,
);
ok(
  base.fast.attrSetup === 0,
  `fast instancing repeats no vertex-attribute setup (${base.fast.attrSetup})`,
);
ok(
  base.fast.resourceClears === 2,
  `fast instancing clears depth/stencil once per frame (${base.fast.resourceClears} for 2 frames)`,
);
ok(
  base.routeCache.fastDelta === 1,
  `the cull-aware eligibility cache recomputes a stale decision and takes the fast path (${JSON.stringify(base.routeCache)})`,
);
ok(
  base.routeCache.instancedDraws > 0,
  `...and that draw issues its instanced draw of both instances (${base.routeCache.instancedDraws})`,
);
ok(
  base.normal.uploads === 0 && base.normal.allocs === 0,
  `unmutated: the six counted alternations upload nothing and allocate nothing (${JSON.stringify(base.normal)})`,
);
for (const m of ['streamKey', 'coverDirty']) {
  const r = await run(m);
  ok(
    r.normal.uploads > 0 || r.normal.allocs > 0,
    `mutation ${m}: the guard FAILS (${JSON.stringify(r.normal)} in the counted window)`,
  );
}
const many = await runMany();
const frameless = await runFrameless();
ok(
  many.first.fast === MANY,
  `${MANY} instanced assets per frame: the first frame draws each through the fast path (${JSON.stringify(many.first)})`,
);
ok(
  many.steady.every((f) => f.fast === MANY && f.uploads === 0 && f.allocs === 0),
  `...and every later frame re-uploads no compact mesh and allocates no buffer (per frame: ${JSON.stringify(many.steady)})`,
);
ok(
  many.between.uploads === 2 && many.between.deletes === 0,
  `a new asset drawn between frames builds its mesh and evicts none of the scene's (${JSON.stringify(many.between)})`,
);
ok(
  many.joined.fast === MANY + 1 && many.joined.uploads === 0 && many.joined.deletes === 0,
  `...and joining mid-frame it draws from that mesh while the assets not yet drawn this frame keep theirs (${JSON.stringify(many.joined)})`,
);
ok(
  many.shrink[0].deletes === 0 &&
    many.shrink[1].deletes > 0 &&
    many.shrink[2].deletes === 0 &&
    many.narrowAgain.uploads === 0,
  `a shrunken scene keeps the last frame's meshes one frame, then gives back all but the cap, and redraws what it kept without an upload (${JSON.stringify({ shrink: many.shrink, again: many.narrowAgain })})`,
);
ok(
  many.meshBytes.narrow < many.meshBytes.wide,
  `...and the cache's fillStream bytes fall with it (${JSON.stringify(many.meshBytes)})`,
);
ok(
  !!many.budget.evicted &&
    many.budget.evicted.bytes > 0 &&
    many.budget.total <= many.budget.budget &&
    many.budget.order.includes('instancedMeshes'),
  `the memory budget evicts idle instanced meshes between frames and the total fits (${JSON.stringify(many.budget)})`,
);
ok(
  many.afterBudget.fast === MANY,
  `...and the next frame rebuilds them and still takes the fast path (${JSON.stringify(many.afterBudget)})`,
);
ok(
  frameless.after === frameless.atCap && frameless.deletes === 2 * (MANY - 8),
  `without frames the cache holds its cap of 8 meshes and no more (${JSON.stringify(frameless)})`,
);
console.log(
  fail ? `instancedCompactCacheNodeSmoke FAIL (${fail})` : 'instancedCompactCacheNodeSmoke PASS',
);
process.exit(fail ? 1 : 0);

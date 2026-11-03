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
console.log(
  fail ? `instancedCompactCacheNodeSmoke FAIL (${fail})` : 'instancedCompactCacheNodeSmoke PASS',
);
process.exit(fail ? 1 : 0);

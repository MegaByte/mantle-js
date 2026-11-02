// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// instancedCompactCacheNodeSmoke -- the driver-model twin of instancedCompactCacheSmoke (the browser one): the same flow (raw renderer, Loop-Blinn off, two bundles of the same
// sections, the loading call, a fast-instanced warm, then the normal path warmed until quiet and six counted alternations) on test/_pendingGl.mjs with a 20 ms link, and the
// MUTATION PROOF that the guard catches what it guards against:
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
    allocs = 0;
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
  draw(first);
  draw(second);
  const fast = { uploads, allocs };
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
  R.dispose();
  globalThis.__MANTLE_MUTATE = undefined;
  return { fast, normal };
}
const base = await run(undefined);
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

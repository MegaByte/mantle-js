// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verify serialization of loading calls, readiness after incomplete warms, and
// isolation of awaitBundleReady(). Scoped warms preserve viewport classes;
// subsequent full warms enumerate all live bundles. Uses test/_pendingGl.mjs.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
globalThis.window = { addEventListener: () => {} };
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const M = await import('../src/index.js');
const { createRenderer, createBundle, importSvg } = M;
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const doc = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const fill = (i) => doc(`<path d="M${10 + i} 10 C60 0 90 40 80 90 L20 70Z" fill="#a48"/>`);
const LATE = (i) =>
  doc(
    `<circle cx="50" cy="50" r="${40 - i}" fill="none" stroke="#fff" stroke-width="5" stroke-dasharray="14 10" stroke-linecap="round"/>`,
  );
const OPTS = { asyncShaderCompile: true, nonBlocking: true, strictPlay: true, aacFill: 'auto' };
async function mk(link, pipe) {
  const W = createPendingGl({ linkMs: link, pipelineMs: pipe });
  const R = createRenderer(W.gl, taggedShaderSources(), OPTS);
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 10);
  await R.ready;
  R.setViewport(512, 512);
  const scene = [];
  for (let i = 0; i < 4; i++)
    scene.push(createBundle(W.gl, await importSvg(fill(i), { preserveViewport: true })));
  return { W, R, scene };
}
const late = async (W, i) =>
  createBundle(W.gl, await importSvg(LATE(i), { preserveViewport: true }));
const fresh = (key) => key.charAt(0) !== '\u0000';

console.log('(overlap) a late bundle whose keys another warm has only listed waits for that warm');
{
  const { W, R } = await mk(5, 40);
  await R.precompileFillsAsync({});
  const a = await late(W, 0),
    b = await late(W, 1);
  let aDone = false,
    bDone = false;
  const pa = R.awaitBundleReady(a).then(() => {
    aDone = true;
  });
  // until the warm has listed b's keys
  for (
    let i = 0;
    i < 60000 &&
    !aDone &&
    !R._policy
      .image(b)
      .filter((e) => fresh(e.key))
      .every((e) => R._policy.warmSet().has(e.key));
    i++
  )
    await sleep(1);
  ok(!aDone, 'the premise: the first warm is still running');
  const pb = R.awaitBundleReady(b).then(() => {
    bDone = true;
  });
  await sleep(0);
  ok(!bDone, 'the second call did not resolve on keys the first has only listed');
  await pb;
  ok(aDone, 'it resolved after the warm that builds them');
  await pa;
  const p0 = W.model.pipelines,
    ds = { ...R.debugStats };
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(a);
  R.drawBundle(b);
  R.endFrame();
  ok(
    W.model.pipelines === p0 && (R.debugStats.deferredFillDraws | 0) === (ds.deferredFillDraws | 0),
    `both first draws build and defer nothing (${W.model.pipelines - p0} pipelines)`,
  );
  R.dispose();
}
console.log("(one at a time) a second call does not move the running call's state");
{
  const { W, R } = await mk(5, 20);
  const first = R.precompileFillsAsync({});
  const load = R.debugStats.coopLoad;
  await sleep(5);
  const second = R.precompileFillsAsync({});
  await sleep(5);
  ok(R.debugStats.coopLoad === load, 'the running call keeps the load record');
  await first;
  ok(load.phase === 'done', 'the first ran to its own end');
  await sleep(0);
  ok(R.debugStats.coopLoad !== load, 'then the second started');
  await second;
  ok(R.debugStats.coopLoad.phase === 'done', 'and it ends');
  R.dispose();
}
console.log(
  '(instancing) shared programs retain per-bundle geometry and deduplicate cover-set draws',
);
for (const [coverSet, count] of [
  [false, 6],
  [true, 6],
  [false, 12],
]) {
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  const gl = W.gl;
  const R = createRenderer(gl, taggedShaderSources(), {
    ...OPTS,
    coverSet,
    aacPoints: false,
    opaquePrepass: false,
  });
  await R.ready;
  R.setViewport(512, 512);
  R.setLoopBlinnFill('off');
  if (!coverSet) R.setFillEngine({ route: 'none', kernel: 'slug', primitives: 'off' });
  const shaders = new Set(),
    programs = new Set();
  const shaderSource = gl.shaderSource,
    attachShader = gl.attachShader;
  gl.shaderSource = (shader, source) => {
    if (source.includes('MANTLE_INSTANCED')) shaders.add(shader);
    return shaderSource(shader, source);
  };
  gl.attachShader = (program, shader) => {
    if (shaders.has(shader)) programs.add(program);
    return attachShader(program, shader);
  };
  let compactUploads = 0;
  const loadBufferData = gl.bufferData;
  gl.bufferData = (target, data, ...args) => {
    // One triangle's compact cover vertices occupy 144 bytes.
    if ((typeof data === 'number' ? data : data.byteLength) === 144) compactUploads++;
    return loadBufferData(target, data, ...args);
  };
  const paths = [
    'M10 10 L65 15 L40 80Z',
    'M10 10 C60 0 90 40 80 90 L20 70Z',
    'M10 10 C90 90 10 90 90 10 C50 100 50 0 10 10Z',
  ];
  const scene = [];
  for (let i = 0; i < count; i++) {
    const path = paths[coverSet ? i % paths.length : 0];
    const svg = doc(`<path d="${path}" fill="#c33"/>`);
    scene.push(createBundle(gl, await importSvg(svg, { preserveViewport: true })));
  }
  await R.precompileFillsAsync({});
  if (!coverSet)
    ok(
      compactUploads > 0 && compactUploads <= count * 3,
      `${count} bundles: loading bounds compact uploads across targets (${compactUploads})`,
    );
  const counts = new Map();
  for (const event of W.F.log)
    if (event.op === 'draw' && programs.has(event.prog)) {
      const key = event.prog.id + '@' + (event.fbo?.id || 'canvas');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  ok(
    counts.size > 0 && [...counts.values()].every((n) => n === 1),
    `${count} bundles, coverSet=${coverSet}: each actual instanced program/target draws once (${[...counts.values()]})`,
  );
  let buffers = 0,
    bytes = 0;
  const createBuffer = gl.createBuffer,
    bufferData = gl.bufferData;
  gl.createBuffer = (...args) => {
    buffers++;
    return createBuffer(...args);
  };
  gl.bufferData = (target, data, ...args) => {
    bytes += typeof data === 'number' ? data : data.byteLength;
    return bufferData(target, data, ...args);
  };
  const p0 = W.model.pipelines,
    f0 = R.debugStats.instancedFastCount;
  for (const worldMatrix of [null, [0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]]) {
    R.beginFrame([1, 1, 1, 1]);
    for (const bundle of scene) R.drawBundleInstanced(bundle, [{ worldMatrix }, { worldMatrix }]);
    R.endFrame();
  }
  if (count <= 8)
    ok(
      buffers === 0 && bytes === 0,
      `coverSet=${coverSet}: play allocates no buffers or geometry (${buffers} buffers, ${bytes} bytes)`,
    );
  ok(
    W.model.pipelines === p0 && R.debugStats.instancedFastCount - f0 === count * 2,
    `${count} bundles, coverSet=${coverSet}: all play draws use prepared instanced pipelines`,
  );
  R.dispose();
  for (const bundle of scene) bundle.dispose();
}
console.log(
  '(deadline) a warm stopped at its deadline left keys listed, not built: the next ask warms them',
);
{
  // An unsignaled batch fence forces the deadline to expire after key enumeration.
  let done = false;
  const RICH = [
    doc(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><path d="M10 10 C60 0 90 40 80 90 L20 70Z" fill="url(#g)"/>',
    ),
    doc(
      '<path d="M10 50 C30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6" stroke-linecap="round"/>',
    ),
    doc(
      '<defs><clipPath id="c"><circle cx="50" cy="50" r="30"/></clipPath></defs><path d="M10 10 Q60 0 80 90 L20 70Z" fill="#a40" clip-path="url(#c)"/>',
    ),
    doc('<path d="M10 10 L90 10 L50 90Z" fill="#0a3"/>'),
  ];
  for (let warmTimeoutMs = 1000; !done && warmTimeoutMs <= 64000; warmTimeoutMs *= 2) {
    const { W, R, scene } = await mk(1, 1);
    for (const x of RICH)
      scene.push(createBundle(W.gl, await importSvg(x, { preserveViewport: true })));
    const sync = W.gl.getSyncParameter;
    W.gl.getSyncParameter = (f, p) => (R._policy.warmSet().size ? -1 : sync.call(W.gl, f, p));
    await R.precompileFillsAsync({ warmTimeoutMs, timeoutMs: 20 });
    W.gl.getSyncParameter = sync;
    if (!R._policy.warmSet().size) {
      R.dispose();
      continue;
    }
    done = true;
    ok(R.debugStats.coopLoad.incomplete === true, 'the premise: the call stopped at its deadline');
    ok(
      scene.some((b) => R._policy.needsWarm(b)),
      'a key listed and not built reads as missing',
    );
    for (const b of scene) await R.awaitBundleReady(b);
    ok(!scene.some((b) => R._policy.needsWarm(b)), 'asked again, the image is built');
    const p0 = W.model.pipelines,
      d0 = R.debugStats.deferredFillDraws | 0,
      wm = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
    R.beginFrame([1, 1, 1, 1]);
    for (const b of scene) {
      R.drawBundle(b);
      R.drawBundle(b, { worldMatrix: wm });
    }
    R.endFrame();
    ok(
      W.model.pipelines === p0 && (R.debugStats.deferredFillDraws | 0) === d0,
      `a draw as drawn and rotated then builds and defers nothing (${W.model.pipelines - p0} pipelines, ${(R.debugStats.deferredFillDraws | 0) - d0} deferred)`,
    );
    R.dispose();
  }
  ok(done, 'the premise: the deadline fell after the pass listed its keys');
}
console.log(
  "(scope) a warm of one late bundle keeps the app's range, and claims no size class for the scene",
);
{
  const { W, R } = await mk(1, 1);
  await R.precompileFillsAsync({ maxViewportPx: 4096 });
  const range0 = R.debugStats.viewportWarm.derived.range;
  const a = await late(W, 0);
  ok(R._policy.needsWarm(a), 'the premise: the late bundle needs a warm');
  R.setViewport(8192, 8192); // past the range: a class only the background warm covers
  R.beginFrame([1, 1, 1, 1]);
  R.endFrame();
  await R.awaitBundleReady(a);
  ok(
    R.debugStats.viewportWarm.derived.range.maxW === range0.maxW,
    `the derived range stays the app's (${R.debugStats.viewportWarm.derived.range.maxW})`,
  );
  // (a hidden tab counts as idle: the background class warm runs without the settled static screen it otherwise waits for)
  globalThis.document = { hidden: true };
  const ev0 = R.debugStats.viewportWarm.events.length;
  for (let i = 0; i < 6000 && R.debugStats.viewportWarm.events.length === ev0; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.endFrame();
    await sleep(10);
  }
  delete globalThis.document;
  ok(
    R.debugStats.viewportWarm.events.length > ev0,
    `the scene's background warm for that class still runs (${R.debugStats.viewportWarm.events.length - ev0} new)`,
  );
  R.dispose();
}
console.log('(scope) a late bundle warms alone, not the whole scene');
{
  // Warm a late dashed ring after a 24-bundle scene.
  const { W, R, scene } = await mk(1, 2);
  for (let i = scene.length; i < 24; i++)
    scene.push(createBundle(W.gl, await importSvg(fill(i), { preserveViewport: true })));
  await R.precompileFillsAsync({});
  for (const b of scene) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
  }
  const ring = await late(W, -4);
  ok(R._policy.needsWarm(ring), 'the late bundle needs a program the scene did not');
  await R.awaitBundleReady(ring);
  const scopedCount = R.debugStats.coopLoad.bindSetEnumBundles;
  ok(scopedCount === 1, `the late warm enumerates only its bundle (${scopedCount} visited)`);
  ok(!R._policy.needsWarm(ring), 'and is ready afterward');
  const p0 = W.model.pipelines;
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(ring);
  R.endFrame();
  ok(W.model.pipelines === p0, `its first draw builds nothing (${W.model.pipelines - p0})`);
  // The late warm's scope is gone once it ends: a full loading call afterward warms art outside it (a gradient no bundle had), and every bundle then draws
  // and builds nothing.
  const graded = createBundle(
    W.gl,
    await importSvg(
      doc(
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect x="10" y="10" width="80" height="80" fill="url(#g)"/>',
      ),
      { preserveViewport: true },
    ),
  );
  ok(R._policy.needsWarm(graded), 'the premise: the gradient needs a program the scene did not');
  await R.precompileFillsAsync({});
  const p1 = W.model.pipelines;
  R.beginFrame([1, 1, 1, 1]);
  for (const b of [...scene, ring, graded]) R.drawBundle(b);
  R.endFrame();
  ok(
    W.model.pipelines === p1,
    `a full loading call afterward warmed outside the late scope: every bundle draws and builds nothing (${W.model.pipelines - p1})`,
  );
  R.dispose();
}
console.log('(instancing) loading prepares axis-aligned and rotated draws');
{
  // Shared instanced variants must be ready before axis-aligned and rotated draws.
  const { W, R, scene } = await mk(2, 2);
  const tri = (i) => doc(`<path d="M${10 + i} 10 L${60 + i} 15 L40 ${70 + i} Z" fill="#c33"/>`);
  for (let i = 0; i < 6; i++)
    scene.push(createBundle(W.gl, await importSvg(tri(i), { preserveViewport: true })));
  const d0 = W.model.draws;
  await R.precompileFillsAsync({});
  const warmDraws = W.model.draws - d0;
  const p0 = W.model.pipelines;
  const ROT = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
  const ID = new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0, 0, 1]);
  for (const m of [ID, ROT]) {
    R.beginFrame([1, 1, 1, 1]);
    for (const b of scene) R.drawBundleInstanced(b, [{ worldMatrix: m }, { worldMatrix: m }]);
    R.endFrame();
  }
  ok(
    W.model.pipelines === p0,
    `instanced draws in play build nothing (${W.model.pipelines - p0}; ${warmDraws} warm draws)`,
  );
  R.dispose();
}
console.log(
  '(late link) an instanced program whose link outlasts the warm passes is drawn once it links',
);
{
  // Slow links outlast the warm passes and must finish before play.
  const { W, R, scene } = await mk(400, 2);
  const tri = (i) => doc(`<path d="M${10 + i} 10 L${60 + i} 15 L40 ${70 + i} Z" fill="#c33"/>`);
  for (let i = 0; i < 6; i++)
    scene.push(createBundle(W.gl, await importSvg(tri(i), { preserveViewport: true })));
  await R.precompileFillsAsync({});
  const ROT = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
  const p0 = W.model.pipelines;
  for (let f = 0; f < 6; f++) {
    R.beginFrame([1, 1, 1, 1]);
    for (const b of scene) R.drawBundleInstanced(b, [{ worldMatrix: ROT }, { worldMatrix: ROT }]);
    R.endFrame();
    await sleep(200);
  }
  ok(
    W.model.pipelines === p0,
    `rotated instanced draws in play build nothing (${W.model.pipelines - p0})`,
  );
  R.dispose();
}
console.log('(late mesh) rotated-only manifest draws prepare their geometry before play');
{
  const W = createPendingGl({ linkMs: 400, pipelineMs: 2 });
  const gl = W.gl;
  const R = createRenderer(gl, taggedShaderSources(), {
    ...OPTS,
    aacPoints: false,
    opaquePrepass: false,
  });
  await R.ready;
  R.setViewport(512, 512);
  R.setFillEngine({ route: 'none', kernel: 'slug', primitives: 'off' });
  const svg = doc(
    Array.from({ length: 128 }, (_, i) => {
      const x = (i % 16) * 6,
        y = Math.floor(i / 16) * 6;
      return `<path d="M${x} ${y} L${x + 5} ${y + 1} L${x + 2} ${y + 5}Z" fill="#a48"/>`;
    }).join(''),
  );
  const sections = await importSvg(svg, { preserveViewport: true });
  const bundles = Array.from({ length: 6 }, () => createBundle(gl, sections));
  const key = R._policy.wmKeyOf(bundles[0]);
  const manifest = {
    version: 2,
    entries: { [key]: [{ w: [0.8, 0.6, -0.6, 0.8, 0, 0], cm: null, i: 1, ov: 0 }] },
  };
  await R.precompileFillsAsync({ manifest, classes: false });
  ok(!R.debugStats.coopLoad.incomplete, 'the rotated-only manifest finishes loading');
  let buffers = 0,
    bytes = 0;
  const createBuffer = gl.createBuffer,
    bufferData = gl.bufferData;
  gl.createBuffer = (...args) => {
    buffers++;
    return createBuffer(...args);
  };
  gl.bufferData = (target, data, ...args) => {
    bytes += typeof data === 'number' ? data : data.byteLength;
    return bufferData(target, data, ...args);
  };
  const p0 = W.model.pipelines,
    f0 = R.debugStats.instancedFastCount;
  const worldMatrix = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
  R.beginFrame([1, 1, 1, 1]);
  for (const bundle of bundles) R.drawBundleInstanced(bundle, [{ worldMatrix }, { worldMatrix }]);
  R.endFrame();
  ok(
    buffers === 0 && bytes === 0,
    `the first play frame allocates no buffers or geometry (${buffers} buffers, ${bytes} bytes)`,
  );
  ok(
    W.model.pipelines === p0 && R.debugStats.instancedFastCount - f0 === bundles.length,
    'every bundle uses its prepared instanced pipeline',
  );
  R.dispose();
  for (const bundle of bundles) bundle.dispose();
}
console.log('(replay mesh) reloads prepare new and evicted meshes and reuse resident meshes');
{
  const W = createPendingGl({ linkMs: 20, pipelineMs: 2 });
  const gl = W.gl;
  const R = createRenderer(gl, taggedShaderSources(), {
    ...OPTS,
    aacPoints: false,
    opaquePrepass: false,
  });
  await R.ready;
  R.setViewport(512, 512);
  R.setFillEngine({ route: 'none', kernel: 'slug', primitives: 'off' });
  const svg = doc(
    Array.from({ length: 128 }, (_, i) => {
      const x = (i % 16) * 6,
        y = Math.floor(i / 16) * 6;
      return `<path d="M${x} ${y} L${x + 5} ${y + 1} L${x + 2} ${y + 5}Z" fill="#a48"/>`;
    }).join(''),
  );
  const sections = await importSvg(svg, { preserveViewport: true });
  const worldMatrix = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
  const playOnce = (bundles) => {
    R.beginFrame([1, 1, 1, 1]);
    for (const bundle of bundles) R.drawBundleInstanced(bundle, [{ worldMatrix }, { worldMatrix }]);
    R.endFrame();
  };
  let bundles = Array.from({ length: 6 }, () => createBundle(gl, sections));
  await R.precompileFillsAsync({});
  playOnce(bundles);
  let buffers = 0,
    bytes = 0;
  const createBuffer = gl.createBuffer,
    bufferData = gl.bufferData;
  gl.createBuffer = (...args) => {
    buffers++;
    return createBuffer(...args);
  };
  gl.bufferData = (target, data, ...args) => {
    bytes += typeof data === 'number' ? data : data.byteLength;
    return bufferData(target, data, ...args);
  };
  for (const state of ['resident', 'evicted', 'new']) {
    if (state === 'evicted') {
      R.setMemoryBudget(1);
      const evicted = R.getMemoryStats({ bundles: false }).policy.evictions.instancedMeshes;
      ok(evicted?.bytes > 0, 'the memory budget evicted the instanced meshes');
      R.setMemoryBudget(null);
    } else if (state === 'new') {
      for (const bundle of bundles) bundle.dispose();
      bundles = Array.from({ length: 6 }, () => createBundle(gl, sections));
      const d0 = W.model.draws;
      await R.precompileFillsAsync({ draw: false });
      ok(W.model.draws === d0, `draw:false issues no replay draws (${W.model.draws - d0})`);
    }
    buffers = bytes = 0;
    const d0 = W.model.draws;
    await R.precompileFillsAsync({});
    const rows = R.debugStats.viewportWarm.loadClasses || [];
    ok(rows.length > 0 && rows.every((r) => r.covered), `${state}: the replay warms no size`);
    if (state === 'resident')
      ok(
        W.model.draws === d0 && buffers === 0 && bytes === 0,
        'resident meshes need no replay draws or uploads',
      );
    buffers = bytes = 0;
    const p0 = W.model.pipelines,
      f0 = R.debugStats.instancedFastCount;
    playOnce(bundles);
    ok(
      buffers === 0 && bytes === 0,
      `${state}: the first play frame allocates no buffers or geometry (${buffers} buffers, ${bytes} bytes)`,
    );
    ok(
      W.model.pipelines === p0 && R.debugStats.instancedFastCount - f0 === bundles.length,
      `${state}: every bundle uses its prepared instanced pipeline`,
    );
  }
  R.dispose();
  for (const bundle of bundles) bundle.dispose();
}
console.log(
  '(throw) a loading call that throws is over: no phase left behind, and the next call runs',
);
{
  const { W, R, scene } = await mk(1, 1);
  await R.precompileFillsAsync({});
  const bbox = scene[0].globalBBox;
  Object.defineProperty(scene[0], 'globalBBox', {
    get() {
      throw new Error('boom');
    },
    configurable: true,
  });
  let threw = false;
  await R.precompileFillsAsync({}).catch(() => {
    threw = true;
  });
  ok(threw, 'the premise: it threw');
  ok(
    R.debugStats.coopLoad.phase === 'done' && R.debugStats.coopLoad.incomplete === true,
    `its record reads done, incomplete (${R.debugStats.coopLoad.phase})`,
  );
  Object.defineProperty(scene[0], 'globalBBox', {
    value: bbox,
    writable: true,
    configurable: true,
  });
  await R.precompileFillsAsync({ classes: false });
  ok(R.debugStats.coopLoad.phase === 'done', 'the next call ran');
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);

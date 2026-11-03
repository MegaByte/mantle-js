// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// transientHandleWorkingSetSmoke -- the transient handles of bare draws (the handle drawBundle, drawInstance and the per-instance loop of
// drawBundleInstanced keep for a bundle: its cover VAO, cover buffers and mask table) stay resident for the frame's working set, on the driver
// model (test/_pendingGl.mjs with a 20 ms link): a raw renderer with its default engines, 24 bundles of one fixture, the loading call, then
//   working set   with more distinct bundles per frame than the bound of 8 idle handles, once the first frames are quiet every frame makes no
//                 handle, uploads nothing and allocates no buffer, through each of the three entries; a bundle drawn between frames, or
//                 joining mid-frame, evicts none of the scene's handles;
//   memory        a scene of 8 bundles holds 8 handles, as before; a shrunken scene keeps the last frame's handles one frame and then gives
//                 back all but 8 (the coverGeometry bytes fall with them); without frames the bound alone holds, for drawBundle and drawInstance;
//   budget        between frames the memory budget evicts idle transient handles ('transientHandles' in the eviction order) but not the bound
//                 one, which render() then draws without making a handle; inside a frame it evicts none the frame has drawn; it keeps a handle
//                 holding a static cache; the next frame makes the evicted handles again.
// Unmodified, the 24-bundle scene made 24 handles and uploaded 48 buffers in every frame.
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

const MANY = 24,
  CAP = 8;
// A non-diagonal color matrix: drawBundleInstanced takes its per-instance loop, which draws through the bundle's transient handle.
const CM = [0.393, 0.349, 0.272, 0, 0.769, 0.686, 0.534, 0, 0.189, 0.168, 0.131, 0, 0, 0, 0, 1];
const LOOP = [{ colorMatrix: CM }, { colorMatrix: CM, worldMatrix: [1, 0, 0, 0, 1, 0, 9, 9, 1] }];
const ENTRIES = {
  drawBundle: (R, b) => R.drawBundle(b),
  drawInstance: (R, b) => R.drawInstance(b),
  instancedLoop: (R, b) => R.drawBundleInstanced(b, LOOP),
};

async function rig() {
  const W = createPendingGl({ linkMs: 20, pipelineMs: 0 }),
    gl = W.gl;
  const R = createRenderer(gl, taggedShaderSources(), { aacPoints: false });
  await R.ready.catch(() => {});
  W.release && W.release();
  R.setViewport(256, 256);
  const sections = await importSvg(SVG);
  const bundles = Array.from({ length: MANY }, () => createBundle(gl, sections));
  for (const b of bundles) R.prewarmBundle(b);
  R.precompileFills();
  const n = { vaos: 0, vaoDeletes: 0, uploads: 0, allocs: 0, draws: 0 };
  const wrap = (name, count) => {
    const f = gl[name];
    gl[name] = (...a) => {
      count(...a);
      return f.apply(gl, a);
    };
  };
  wrap('createVertexArray', () => n.vaos++);
  wrap('deleteVertexArray', () => n.vaoDeletes++);
  wrap('bufferData', (t, d) => ArrayBuffer.isView(d) && n.uploads++);
  wrap('createBuffer', () => n.allocs++);
  wrap('drawArrays', (m, f, c) => c > 0 && n.draws++);
  // One pass of `entry` over `list`, inside a frame or (framed false) outside any; what it made, deleted, uploaded and allocated.
  const pass = (list, entry = 'drawBundle', framed = true) => {
    for (const k in n) n[k] = 0;
    if (framed) R.beginFrame([1, 1, 1, 1]);
    for (const b of list) ENTRIES[entry](R, b);
    if (framed) R.endFrame();
    return { ...n };
  };
  const stats = () => R.getMemoryStats({ bundles: false });
  // Each transient handle that drew a cover holds two coverGeometry buffers (its cover mesh and shape-index plane); nothing else does.
  const handles = () => {
    const c = stats().gpu.byCategory.coverGeometry;
    return c ? c.resources / 2 : 0;
  };
  const coverBytes = () => {
    const c = stats().gpu.byCategory.coverGeometry;
    return c ? c.bytes : 0;
  };
  const done = () => {
    for (const b of bundles) b.dispose();
    R.dispose();
  };
  return { R, gl, sections, bundles, pass, stats, handles, coverBytes, n, done };
}

// The working set, through each entry.
const scene = {};
for (const entry of Object.keys(ENTRIES)) {
  const { bundles, pass, handles, done } = await rig();
  const first = pass(bundles, entry);
  // until a frame makes no handle and uploads nothing (the warm tick builds one bundle's pipeline per frame meanwhile), at most 60
  for (let quiet = 0, i = 0; i < 60 && quiet < 2; i++) {
    const f = pass(bundles, entry);
    quiet = f.vaos || f.uploads || f.allocs ? 0 : quiet + 1;
  }
  const steady = [];
  for (let i = 0; i < 3; i++) steady.push(pass(bundles, entry));
  scene[entry] = { first, steady, handles: handles() };
  done();
}
// Joining, shrinking, frameless draws and the budget, on drawBundle.
const life = {};
{
  const { R, gl, sections, bundles, pass, stats, handles, coverBytes, n, done } = await rig();
  pass(bundles);
  pass(bundles);
  const joined = createBundle(gl, sections);
  R.prewarmBundle(joined);
  life.between = pass([joined], 'drawBundle', false);
  life.joined = pass([...bundles.slice(0, MANY / 2), joined, ...bundles.slice(MANY / 2)]);
  life.wide = { handles: handles(), bytes: coverBytes() };
  life.shrink = [];
  for (let i = 0; i < 3; i++)
    life.shrink.push({ ...pass(bundles.slice(0, 4)), handles: handles() });
  life.narrow = { handles: handles(), bytes: coverBytes() };
  life.narrowAgain = pass(bundles.slice(0, 4));
  joined.dispose();

  // A scene of 8 bundles: 8 handles, the old bound, and a 9th bundle drawn in frames of its own ages the least recently drawn one out.
  for (let i = 0; i < 3; i++) pass(bundles.slice(0, CAP));
  life.eight = { handles: handles(), steady: pass(bundles.slice(0, CAP)) };
  const ninth1 = pass([bundles[CAP]]);
  const ninth2 = pass([bundles[CAP]]);
  life.ninth = { handles: handles(), first: ninth1, second: ninth2 };

  // The budget between frames: idle handles go, least recently bound first; the bound one stays and render() draws it as it was.
  pass(bundles);
  const s0 = stats();
  const need = Math.ceil(coverBytes() / 2);
  R.setMemoryBudget(s0.gpu.totalBytes - need);
  const s1 = stats();
  for (const k in n) n[k] = 0;
  R.render();
  life.budget = {
    evicted: s1.policy.evictions.transientHandles || null,
    total: s1.gpu.totalBytes,
    budget: s0.gpu.totalBytes - need,
    order: s1.policy.order,
    handles: handles(),
    renderBound: { vaos: n.vaos, uploads: n.uploads, draws: n.draws },
  };
  R.setMemoryBudget(null);
  life.afterBudget = pass(bundles);
  life.afterBudget2 = pass(bundles);

  // The budget inside a frame: a frame that has drawn half the scene keeps those handles; the other half (drawn last frame) may go.
  R.beginFrame([1, 1, 1, 1]);
  for (const b of bundles.slice(0, MANY / 2)) R.drawBundle(b);
  R.setMemoryBudget(0);
  const s2 = stats();
  R.setMemoryBudget(null);
  for (const k in n) n[k] = 0;
  for (const b of bundles.slice(0, MANY / 2)) R.drawBundle(b);
  const redraw = { ...n };
  R.endFrame();
  life.inFrame = {
    evicted: s2.policy.evictions.transientHandles || null,
    handlesThen: s2.gpu.byCategory.coverGeometry.resources / 2,
    redraw,
  };

  // A transient handle holding a static cache (setBundle + enableStaticCache) is not evicted by the budget.
  R.setBundle(bundles[0]);
  R.enableStaticCache();
  const cached = R.staticCache;
  pass(bundles.slice(1));
  R.setMemoryBudget(0);
  R.setMemoryBudget(null);
  R.setBundle(bundles[0]);
  life.staticCache = { enabled: !!cached, kept: !!cached && R.staticCache === cached };
  done();
}
// Without frames there is no working set to keep: the bound alone holds, for drawBundle and for drawInstance.
const frameless = {};
for (const entry of ['drawBundle', 'drawInstance']) {
  const { bundles, pass, handles, done } = await rig();
  pass(bundles.slice(0, CAP), entry, false);
  const atCap = handles();
  const wide = pass(bundles, entry, false);
  frameless[entry] = { atCap, after: handles(), vaoDeletes: wide.vaoDeletes };
  done();
}

for (const [entry, r] of Object.entries(scene)) {
  ok(
    r.steady.every((f) => f.vaos === 0 && f.uploads === 0 && f.allocs === 0 && f.vaoDeletes === 0),
    `${entry}: ${MANY} bundles per frame, every frame makes no handle, uploads nothing and allocates nothing (first ${JSON.stringify(r.first)}, then ${JSON.stringify(r.steady)})`,
  );
  ok(
    r.handles === MANY && r.steady.every((f) => f.draws > 0),
    `${entry}: ...and draws from ${MANY} resident handles (${r.handles})`,
  );
}
ok(
  life.between.vaos === 1 && life.between.vaoDeletes === 0,
  `a bundle drawn between frames makes its handle and evicts none of the scene's (${JSON.stringify(life.between)})`,
);
ok(
  life.joined.vaos === 0 && life.joined.uploads === 0 && life.joined.vaoDeletes === 0,
  `...and joining mid-frame it draws from that handle while the bundles not yet drawn this frame keep theirs (${JSON.stringify(life.joined)})`,
);
ok(
  life.shrink[0].vaoDeletes === 0 &&
    life.shrink[1].vaoDeletes === MANY + 1 - CAP &&
    life.shrink[1].handles === CAP &&
    life.shrink[2].vaoDeletes === 0 &&
    life.narrowAgain.uploads === 0 &&
    life.narrowAgain.vaos === 0,
  `a shrunken scene keeps the last frame's handles one frame, then gives back all but ${CAP}, and redraws what it kept without an upload (${JSON.stringify({ shrink: life.shrink, again: life.narrowAgain })})`,
);
ok(
  life.narrow.bytes < life.wide.bytes && life.wide.handles === MANY + 1,
  `...and the coverGeometry bytes fall with them (${JSON.stringify({ wide: life.wide, narrow: life.narrow })})`,
);
ok(
  life.eight.handles === CAP &&
    life.eight.steady.vaos === 0 &&
    life.eight.steady.uploads === 0 &&
    life.ninth.handles === CAP,
  `a scene of ${CAP} bundles holds ${CAP} handles and a ninth bundle keeps the total at ${CAP} (${JSON.stringify({ eight: life.eight, ninth: life.ninth.handles })})`,
);
ok(
  life.ninth.first.vaos === 1 &&
    life.ninth.first.vaoDeletes === 0 &&
    life.ninth.second.vaoDeletes === 1,
  `...by aging out the least recently drawn handle once it has been idle for two frames (${JSON.stringify({ first: life.ninth.first, second: life.ninth.second })})`,
);
ok(
  !!life.budget.evicted &&
    life.budget.evicted.bytes > 0 &&
    life.budget.total <= life.budget.budget &&
    life.budget.order.includes('transientHandles') &&
    life.budget.handles < MANY,
  `the memory budget evicts idle transient handles between frames and the total fits (${JSON.stringify(life.budget)})`,
);
ok(
  life.budget.renderBound.vaos === 0 &&
    life.budget.renderBound.uploads === 0 &&
    life.budget.renderBound.draws > 0,
  `...but not the bound one: render() draws it without making a handle (${JSON.stringify(life.budget.renderBound)})`,
);
ok(
  life.afterBudget.vaos === MANY - life.budget.handles &&
    life.afterBudget2.vaos === 0 &&
    life.afterBudget2.uploads === 0,
  `...and the next frame makes the evicted handles again, the one after makes none (${JSON.stringify({ a: life.afterBudget, b: life.afterBudget2 })})`,
);
ok(
  !!life.inFrame.evicted &&
    life.inFrame.handlesThen >= MANY / 2 &&
    life.inFrame.redraw.vaos === 0 &&
    life.inFrame.redraw.uploads === 0,
  `inside a frame the budget evicts handles the frame has not drawn and none it has (${JSON.stringify(life.inFrame)})`,
);
ok(
  life.staticCache.enabled && life.staticCache.kept,
  `a transient handle holding a static cache survives the budget (${JSON.stringify(life.staticCache)})`,
);
for (const [entry, r] of Object.entries(frameless))
  ok(
    r.atCap === CAP && r.after === CAP && r.vaoDeletes === MANY - CAP,
    `${entry} without frames: the bound alone holds ${CAP} handles (${JSON.stringify(r)})`,
  );
console.log(
  fail ? `transientHandleWorkingSetSmoke FAIL (${fail})` : 'transientHandleWorkingSetSmoke PASS',
);
process.exit(fail ? 1 : 0);

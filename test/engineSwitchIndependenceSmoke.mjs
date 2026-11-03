// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// engineSwitchIndependenceSmoke — what an engine draws does not depend on what was drawn before,
// or on which renderer was created last:
//   engineSwitchIndependence   switching engines and back draws the same picture every time
//   lbBuilderOwnership         a second (Slug-only) renderer does not stop the first building LB
// Each case runs on its own page (its own context and renderers) in one browser; see
// _caseHost.mjs.

import path from 'path';
import { fileURLToPath } from 'url';
import { emitFixture } from './_fixtures.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// engineSwitchIndependence — what an engine draws must not depend on WHAT YOU DREW BEFORE.
//
// The general form of a real defect class: an off-thread LB builder registered through a
// module-level singleton is owned by the LAST renderer created — and the moment that renderer is
// Slug-only (which is every non-LB engine: AAC, GWN, hard), no bundle created afterwards ever gets
// Loop-Blinn meshes. In the demo: pick LB, it works; pick AAC; pick LB again — declined, for the
// rest of the session.
//
// Greping for singletons only finds the ones you already know about. So assert the INVARIANT
// instead: render every engine in one order, then in another, and require identical pixels. Any
// state that leaks between renderers — a hook one of them stole, a cache another poisoned, a global
// the last writer won — shows up here as a mismatch, whatever its mechanism.
async function engineSwitchIndependence(host) {
  const N = 200;

  // A ring (even-odd hole: LB meshes it, GWN needs its tree) plus a straight-edged shape.
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path fill="#3366cc" fill-rule="evenodd" d="M 150 90 C 150 56.86 123.14 30 90 30 C 56.86 30 30 56.86 30 90 C 30 123.14 56.86 150 90 150 C 123.14 150 150 123.14 150 90 Z M 120 90 C 120 73.43 106.57 60 90 60 C 73.43 60 60 73.43 60 90 C 60 106.57 73.43 120 90 120 C 106.57 120 120 106.57 120 90 Z"/>
  <path fill="#cc3333" d="M 140 160 L 190 160 L 165 195 Z"/>
</svg>`;
  emitFixture('engineSwitchIndependence__SVG', SVG);

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SVG = ${JSON.stringify(SVG)};

// Each engine as an app would build it: its own renderer, its own bundle (an engine can need
// different IMPORT options — GWN's run tree is baked by the importer, not the shader).
const ENGINES = {
  slug: [{},                                                   {},                 'off'],
  lb:   [{},                                                   {},                 'on'],
  aac:  [{ aacFill: true },                                    {},                 'off'],
  gwn:  [{ fillDefines: ['MANTLE_GWN','MANTLE_GWN_SDF'] },     { gwnTree: true },  'off'],
  hard: [{ fillDefines: ['MANTLE_HARD','MANTLE_GWN'] },        {},                 'off'],
};
// Renderers are CACHED per engine and kept alive, which is what an app (and this repo's demo) does
// — a renderer is expensive, so you build one per engine and switch between them. That is also what
// makes the defect reachable: the second renderer only steals a module-level LB hook if it is still
// alive when the next bundle is created. Disposing each renderer after drawing would leave only one
// alive, the singleton would always be the current one, and the test would measure nothing.
const _cache = {};
async function draw(eng) {
  const [rOpts, impOpts, lbMode] = ENGINES[eng];
  const r = _cache[eng] || (_cache[eng] = createRenderer(gl, shaders, rOpts));
  r.setLoopBlinnFill(lbMode);
  const b = createBundle(gl, await importSvg(SVG, impOpts));
  if (lbMode !== 'off' && r.awaitLbReady) await r.awaitLbReady(b);   // NB: no prepareBundle — apps rely on the auto-build
  r.prewarmBundle(b); r.precompileFills();   // the loading call: the first frames draw the programs a game has after loading
  const frame = () => { r.setViewport(N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame(); };
  // WARM FIRST for the LB engine. While the LB-hosting fill variant is still
  // linking, a bundle falls to the best non-LB engine (the ordinary fill pass
  // re-runs its own selection) rather than into the classic coverage-RT routes —
  // so frame 1 routes nothing to LB by design, and a one-frame measurement would
  // report the ownership bug this smoke exists to catch even on a healthy build.
  // Each bundle is fresh and its kind mask picks its own variant, so this warms
  // per bundle rather than once.
  if (lbMode !== 'off') {
    for (let i = 0; i < 12; i++) {
      const c = r.debugStats.loopBlinnRouteCount;
      frame();
      if (r.debugStats.loopBlinnRouteCount - c > 0) break;
      if (r.precompileFills) { try { r.precompileFills(); } catch {} }
      // rAF ALONE NEVER SETTLES in a headless page with no visible work. Timeout wins if rAF stalls.
      await new Promise((res) => { const _t = setTimeout(res, 100); requestAnimationFrame(() => { clearTimeout(_t); res(); }); });
    }
  }
  const c0 = r.debugStats.loopBlinnRouteCount;
  frame();
  const routed = r.debugStats.loopBlinnRouteCount - c0;
  const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink = 0, h = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i+3] > 8 && (px[i] < 245 || px[i+1] < 245 || px[i+2] < 245)) ink++;
    h = (h * 31 + px[i]) >>> 0;
  }
  b.dispose();                                  // the RENDERER stays alive — see above
  return { ink, hash: h, routed, px: Array.from(px) };
}
const ORDER_A = ['slug','lb','aac','gwn','hard','lb'];   // LB, then others, then LB AGAIN
const ORDER_B = ['gwn','hard','aac','lb','slug','lb'];   // a different history entirely
const runA = {}, runB = {};
for (const e of ORDER_A) runA[e] = await draw(e);         // later visits overwrite: the LAST LB is what we keep
for (const e of ORDER_B) runB[e] = await draw(e);
window.__out = { runA, runB };
window.__ready = true;
</script></body></html>`;

  const br = host.browser;
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(host.page(HTML), { waitUntil: 'load', timeout: 90000 });
  // Interval polling: the default raf-based poll can stall in headless runs
  // (the page finishes but rAF never fires), timing out a passing test.
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 250 });
  const { runA, runB } = await pg.evaluate(() => window.__out);
  await pg.close();

  let fail = 0;
  const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

  console.log('  engine   order A (ink/routed)   order B (ink/routed)');
  for (const e of Object.keys(runA))
    console.log(
      `  ${e.padEnd(8)} ${String(runA[e].ink).padStart(7)} / ${runA[e].routed}          ${String(runB[e].ink).padStart(7)} / ${runB[e].routed}`,
    );

  for (const e of Object.keys(runA)) {
    const A = runA[e].px,
      B = runB[e].px;
    let nd = 0,
      mx = 0;
    for (let i = 0; i < A.length; i++) {
      const d = Math.abs(A[i] - B[i]);
      if (d > 0) nd++;
      if (d > mx) mx = d;
    }
    console.log(
      `  ${e}: ${nd} of ${A.length} bytes differ between the two orders (max delta ${mx})`,
    );
    ok(runA[e].ink > 0, `${e} renders something (ink=${runA[e].ink})`);
    // THE INVARIANT: same engine, same asset, different history ⇒ the same PICTURE.
    //
    // Not bit-equality. AAC and GWN come back with ~20 bytes off by exactly 1 (of 160,000): the two
    // runs compile their own program objects, and the driver is free to reassociate float maths
    // differently between them. That is a single LSB and it is not a state leak. A leak — a hook one
    // renderer stole, a cache another poisoned — changes which ENGINE drew a shape, and that moves
    // whole edges, not one bit. So bound the delta, and bound how much of the image may move at all.
    ok(
      mx <= 1,
      `${e} draws the same regardless of which engines ran before it (max delta ${mx}, LSB noise only)`,
    );
    ok(
      nd < A.length * 0.001,
      `${e}: at most a trace of the image differs across orders (${nd} bytes)`,
    );
  }
  // The specific casualty of the singleton bug: LB visited AFTER a Slug-only renderer must still route.
  ok(
    runA.lb.routed > 0,
    'LB still ROUTES when visited after AAC/GWN/hard (the builder-ownership bug)',
  );
  ok(runB.lb.routed > 0, 'LB still ROUTES when other engines ran first (reverse order)');

  console.log(
    fail ? `\nENGINE-SWITCH-INDEPENDENCE FAIL (${fail})` : '\nENGINE-SWITCH-INDEPENDENCE PASS',
  );
  return fail;
}

// lbBuilderOwnership — creating a SECOND renderer must not stop the first one building LB.
//
// The off-thread LB builder is registered per renderer (setLbBuilder). Behind a module-level
// singleton the LAST renderer created would own it, and its first line is `if (R._lbSlugOnly)
// return;` — so the moment anything created a Slug-only renderer (which is every non-LB engine:
// AAC, GWN, hard, and any app that keeps a second renderer around), NO bundle created afterwards
// would get LB meshes built, and LB would silently decline for the rest of the session: pick LB, it
// works; pick AAC; pick LB again — declined, permanently.
//
// The bundle is shared, so this is not about which renderer draws: it is that nobody BUILT the
// meshes. Build if ANY registered builder wants them.
async function lbBuilderOwnership(host) {
  const N = 220;

  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path fill="#3366cc" fill-rule="evenodd" d="M 170 100 C 170 61.34 138.66 30 100 30 C 61.34 30 30 61.34 30 100 C 30 138.66 61.34 170 100 170 C 138.66 170 170 138.66 170 100 Z M 135 100 C 135 80.67 119.33 65 100 65 C 80.67 65 65 80.67 65 100 C 65 119.33 80.67 135 100 135 C 119.33 135 135 119.33 135 100 Z"/>
</svg>`;
  const LINE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path fill="#3366cc" d="M 25 25 L 175 25 L 175 175 L 25 175 Z"/>
</svg>`;
  emitFixture('lbBuilderOwnership__RING', SVG);

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SVG = ${JSON.stringify(SVG)}, LINE_SVG = ${JSON.stringify(LINE_SVG)};

// 1. the LB renderer, created FIRST — exactly as an app would
const rLb = createRenderer(gl, shaders);
rLb.setLoopBlinnFill('on');

// NB: no prepareBundle(). That builds explicitly and would mask the bug. An app (and this repo's
// demo) relies on the AUTO-BUILD that createBundle kicks off — which is the path that goes through
// the singleton, and the path that a second renderer disarms.
const lbMeshes = async () => {
  const b = createBundle(gl, await importSvg(SVG));
  await rLb.awaitLbReady(b);
  const m = b._lbMeshes || [];
  const real = m.filter(x => x && x.vertexCount).length;
  const c0 = rLb.debugStats.loopBlinnRouteCount;
  rLb.setViewport(N,N); rLb.beginFrame([1,1,1,1]); rLb.drawBundle(b, {}); rLb.endFrame();
  const routed = rLb.debugStats.loopBlinnRouteCount - c0;
  b.dispose();
  return { meshes: m.length, real, routed };
};

const before = await lbMeshes();

// 2. now create a SECOND, Slug-only renderer — what the demo does for AAC/GWN/hard, and what any
//    app with a second renderer does. It must not disarm the first one.
const rAac = createRenderer(gl, shaders, { aacFill: true });
rAac.setLoopBlinnFill('off');

// 3. back to LB, with a FRESH bundle (the demo rebuilds on every engine switch)
const after = await lbMeshes();

// 4. DISPOSE the second renderer. Its hook must come back OUT of the registry — a disposed
//    renderer's closure captures a dead GL context, and leaving it registered would hand the next
//    bundle's build to a renderer that does not exist. (A registry is what makes this hazard
//    possible; a single slot would instead be overwritten by the next renderer.)
rAac.dispose();
const afterDispose = await lbMeshes();

// 5. dispose the LB renderer's PEER while LB is still live, then build again — the surviving
//    renderer must still be the one that builds.
const rGwn = createRenderer(gl, shaders, { fillDefines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'] });
rGwn.setLoopBlinnFill('off');
rGwn.dispose();
const afterPeerGone = await lbMeshes();

// 6. With every analytic renderer gone, an explicitly Slug-only renderer must
// not rebuild LB through the legacy idle-preparer fallback.
rLb.dispose();
const rOff = createRenderer(gl, shaders); rOff.setLoopBlinnFill('off');
const bOff = createBundle(gl, await importSvg(SVG));
// KEPT A FIXED WINDOW ON PURPOSE: this asserts that NOTHING happens -- a Slug-only renderer must not rebuild LB through the
// idle preparer. There is no completion signal for work that must not occur, so the claim is "not within 100 ms of the idle
// preparer's first chance"; waiting for a flag would wait forever on the passing path.
await new Promise(q => setTimeout(q, 100));
const slugOnly = { decided: bOff._lbMeshes !== undefined, memory: rOff.getLoopBlinnMemoryUse() };
bOff.dispose(); rOff.dispose();

// 7. Auto mode should not spend worker time or memory on straight-only geometry,
// but changing that same renderer to forced LB must build it on demand.
const rAuto = createRenderer(gl, shaders);
const bAuto = createBundle(gl, await importSvg(LINE_SVG));
// (awaitLbReady below is the readiness signal for this bundle's build decision; no delay needed first.)
const autoWaitStart = performance.now();
const autoReady = await rAuto.awaitLbReady(bAuto);
const autoSkipped = {
  decided: bAuto._lbMeshes !== undefined,
  memory: rAuto.getLoopBlinnMemoryUse(),
  ready: autoReady,
  waitMs: performance.now() - autoWaitStart,
};
rAuto.setLoopBlinnFill('on');
const forcedReady = await rAuto.awaitLbReady(bAuto);
const forcedStart = rAuto.debugStats.loopBlinnRouteCount;
rAuto.setViewport(N,N); rAuto.beginFrame([1,1,1,1]); rAuto.drawBundle(bAuto, {}); rAuto.endFrame();
const forced = {
  ready: forcedReady,
  routed: rAuto.debugStats.loopBlinnRouteCount - forcedStart,
  memory: rAuto.getLoopBlinnMemoryUse(),
};
bAuto.dispose(); rAuto.dispose();

window.__out = { before, after, afterDispose, afterPeerGone, slugOnly, autoSkipped, forced };
window.__ready = true;
</script></body></html>`;

  const br = host.browser;
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(host.page(HTML), { waitUntil: 'load', timeout: 90000 });
  // Interval polling: the default raf-based poll can stall in headless runs
  // (the page finishes but rAF never fires), timing out a passing test.
  await pg.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 250 });
  const o = await pg.evaluate(() => window.__out);
  await pg.close();

  let fail = 0;
  const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

  console.log(
    `  before a 2nd renderer exists: ${o.before.real}/${o.before.meshes} meshes built, LB routed ${o.before.routed}`,
  );
  console.log(
    `  after  a Slug-only renderer : ${o.after.real}/${o.after.meshes} meshes built, LB routed ${o.after.routed}`,
  );
  console.log(
    `  after  disposing it         : ${o.afterDispose.real}/${o.afterDispose.meshes} meshes built, LB routed ${o.afterDispose.routed}`,
  );
  console.log(
    `  after  a disposed peer      : ${o.afterPeerGone.real}/${o.afterPeerGone.meshes} meshes built, LB routed ${o.afterPeerGone.routed}`,
  );

  ok(
    o.before.real > 0 && o.before.routed > 0,
    'LB builds and routes before any other renderer exists',
  );
  ok(
    o.after.real > 0,
    `LB still BUILDS meshes after a Slug-only renderer is created (${o.after.real} real)`,
  );
  ok(o.after.routed > 0, 'LB still ROUTES after a Slug-only renderer is created');
  ok(
    o.afterDispose.real > 0 && o.afterDispose.routed > 0,
    `LB survives that renderer being DISPOSED (${o.afterDispose.real} meshes, routed ${o.afterDispose.routed})`,
  );
  ok(
    o.afterPeerGone.real > 0 && o.afterPeerGone.routed > 0,
    `LB survives a create-then-dispose peer (${o.afterPeerGone.real} meshes, routed ${o.afterPeerGone.routed})`,
  );
  ok(
    !o.slugOnly.decided && o.slugOnly.memory === 0,
    'Slug-only renderers do not enqueue an LB idle build',
  );
  ok(
    !o.autoSkipped.decided && o.autoSkipped.memory === 0,
    'auto mode skips LB construction for straight-only bundles',
  );
  ok(
    !o.autoSkipped.ready && o.autoSkipped.waitMs < 250,
    `awaitLbReady resolves false immediately for an auto-skipped bundle (${o.autoSkipped.waitMs.toFixed(1)} ms)`,
  );
  ok(
    o.forced.ready && o.forced.routed > 0 && o.forced.memory > 0,
    'switching an auto-skipped bundle to forced LB builds and routes it on demand',
  );

  console.log(fail ? `\nLB-BUILDER-OWNERSHIP FAIL (${fail})` : '\nLB-BUILDER-OWNERSHIP PASS');
  return fail;
}

const host = await openCaseHost(ROOT, { headless: 'new', args: ['--no-sandbox'] });
const failures = await runCases(host, [
  ['engineSwitchIndependence', engineSwitchIndependence],
  ['lbBuilderOwnership', lbBuilderOwnership],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nengineSwitchIndependenceSmoke: engine choice is independent of history and renderer order',
);

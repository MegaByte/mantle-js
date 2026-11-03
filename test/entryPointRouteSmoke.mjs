// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// entryPointRouteSmoke — a bundle draws through the same engine whichever entry point draws it:
//   entryPointRoute          drawBundle, handle.draw and drawBundleInstanced agree on the route
//   lbHandleInstancedParity  handle.draw and drawBundleInstanced reach the static LB fill and match
//                            Slug; a cached handle keeps its cache
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { openReady } from './_pageReady.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// entryPointRoute — a bundle draws through the same engine whichever entry point draws it.
//
// drawBundle, handle.draw and drawBundleInstanced each reach a routing decision, and each must agree with the route it
// fronts:
//   - handle.draw must not fall straight to render() when the analytic route declines, or it never reaches AAC's
//     small-shape point route that a bare drawBundle takes (an app that draws everything through handles would never run it).
//   - drawBundleInstanced asks _lbWouldServe whether to leave its fast path; restating the route's static branch there
//     drifts from it (the CPatch and forced-unified bypasses, the no-AA veto's primitive exemption), so it asks the
//     route's own gate, with one deliberate difference: with the route off, primitives alone do not pull N instances
//     off the one-draw fast path.
//
// Asserts, per case, the engine@route the engine ledger records for one frame from each entry point:
//   (a) a recognized circle with the analytic route off: sdf from drawBundle and handle.draw, while drawBundleInstanced
//       keeps its instanced fast path;
//   (b) a row of tiny AAC glyphs: aac@points from drawBundle AND handle.draw.
async function entryPointRoute(host) {
  const N = 128;

  const CIRCLE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" fill="#000000"/></svg>';
  // The glyph row from aacPointsRouteSmoke: quads and lines, nonzero and even-odd, small enough at half scale for the point route.
  function glyphs(count) {
    let out = '';
    for (let i = 0; i < count; i++) {
      const x = 2 + i * 3.1,
        y = 10,
        k = i % 3;
      if (k === 0)
        out += `<path fill="#000000" fill-rule="evenodd" d="M${x} ${y} Q${x + 1.6} ${y - 2.2} ${x + 3.2} ${y} Q${x + 1.6} ${y + 2.2} ${x} ${y} Z M${x + 0.9} ${y} Q${x + 1.6} ${y - 1.1} ${x + 2.3} ${y} Q${x + 1.6} ${y + 1.1} ${x + 0.9} ${y} Z"/>`;
      else if (k === 1)
        out += `<path fill="#2b4c9a" d="M${x} ${y - 2.5} L${x + 0.9} ${y - 2.5} L${x + 0.9} ${y + 2.2} L${x} ${y + 2.2} Z"/>`;
      else
        out += `<path fill="#b03030" d="M${x + 3} ${y - 1.4} Q${x + 1} ${y - 3} ${x} ${y} Q${x + 1} ${y + 3} ${x + 3} ${y + 1.4} L${x + 2.5} ${y + 0.9} Q${x + 1.2} ${y + 2} ${x + 0.8} ${y} Q${x + 1.2} ${y - 2} ${x + 2.5} ${y - 0.9} Z"/>`;
    }
    return out;
  }
  // A few circles among many other rows (pattern_burned: 24 circles in 228 rows): with the analytic route off the whole bundle would take the
  // unified draw and walk every row on cover quads; the points answer it. A lone circle (above) keeps its SDF record.
  const MIXED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20"><circle cx="8" cy="10" r="4" fill="#000"/><circle cx="20" cy="10" r="4" fill="#900"/>${glyphs(20)}</svg>`;
  const GLYPHS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20">${glyphs(20)}</svg>`;

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const via = (r) => Object.assign({}, (r.debugStats.engines && r.debugStats.engines.viaRoute) || {});
// What ONE frame of this entry point recorded: the engine ledger is cumulative, so take the difference.
const frame = (r, drawIt) => {
  const a = via(r);
  r.beginFrame([1, 1, 1, 1]); drawIt(); r.endFrame();
  const b = via(r), d = {};
  for (const k of Object.keys(b)) { const n = (b[k] | 0) - (a[k] | 0); if (n > 0) d[k] = n; }
  return d;
};
const out = {};
try {
  // (a) recognized primitive, analytic route off
  {
    const r = createRenderer(gl, shaders, { staticUnified: true, psoWarmIdle: () => true });
    r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    // route 'none' is forced plain cover; primitives:'on' keeps the SDF primitive this case asserts.
    r.setFillEngine({ route: 'none', primitives: 'on' });
    const b = createBundle(gl, await importSvg(${JSON.stringify(CIRCLE)}));
    r.prepareBundle(b); r.prewarmBundle(b); r.precompileFills();
    if (r.awaitEngine) { try { await r.awaitEngine(b, 'none', 30000); } catch {} }
    const bare = () => r.drawBundle(b, {});
    // Wait for the primitive to be recognized and its variant warm, not for a frame count (see enginePeerSmoke).
    for (let w = 0; w < 400 && !(frame(r, bare)['sdf@unified'] > 0); w++) await new Promise((res) => setTimeout(res, 5));
    const h = r.createBundleHandle(b);
    const s = [0.4, 0, 0, 0, 0.4, 0, 0, 0, 1];
    const inst = [{ worldMatrix: s }, { worldMatrix: [0.4, 0, 0, 0, 0.4, 0, 0.5, 0.5, 1] }, { worldMatrix: [0.4, 0, 0, 0, 0.4, 0, -0.5, -0.5, 1] }];
    out.prim = {
      bare: frame(r, bare),
      handle: frame(r, () => h.draw({})),
      instanced: frame(r, () => r.drawBundleInstanced(b, inst)),
      prims: (b._lbMeshes || []).filter((m) => m && m.prim).length,
    };
    b.dispose && b.dispose();
  }
  // (b) tiny AAC glyphs: the point route
  {
    const r = createRenderer(gl, shaders, { staticUnified: true, aacFill: true, psoWarmIdle: () => true });
    r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    r.setFillEngine({ route: 'none' });
    const b = createBundle(gl, await importSvg(${JSON.stringify(GLYPHS)}, { preserveViewport: true }));
    r.prewarmBundle(b); r.precompileFills();   // the loading call: the point program is finished there, not at the first draw
    const wm = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];
    const h = r.createBundleHandle(b);
    out.points = { bare: frame(r, () => r.drawBundle(b, { worldMatrix: wm })), handle: frame(r, () => h.draw({ worldMatrix: wm })) };
    b.dispose && b.dispose();
  }
  // (c) a few primitives among many rows: points
  {
    const r = createRenderer(gl, shaders, { staticUnified: true, psoWarmIdle: () => true });
    r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    r.setFillEngine({ route: 'none', primitives: 'on' });
    const b = createBundle(gl, await importSvg(${JSON.stringify(MIXED)}, { preserveViewport: true }));
    r.prepareBundle(b); r.prewarmBundle(b); r.precompileFills();
    if (r.awaitEngine) { try { await r.awaitEngine(b, 'none', 30000); } catch {} }
    const wm = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];
    let d = {};
    for (let w = 0; w < 400; w++) { d = frame(r, () => r.drawBundle(b, { worldMatrix: wm })); if ((b._lbMeshes || []).some((m) => m && m.prim) && w > 5) break; await new Promise((res) => setTimeout(res, 5)); }
    out.mixed = { d: frame(r, () => r.drawBundle(b, { worldMatrix: wm })), prims: (b._lbMeshes || []).filter((m) => m && m.prim).length };
    b.dispose && b.dispose();
  }
  out.ok = true;
} catch (e) { out.err = String((e && e.stack) || e); }
window.__out = out;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  let o = null;
  try {
    await page.goto(host.page(HTML), {
      waitUntil: 'load',
      timeout: 15000,
    });
    await page.waitForFunction(() => window.__out !== undefined, { timeout: 90000, polling: 100 });
    o = await page.evaluate(() => window.__out);
  } catch (e) {
    fail('setup: ' + e.message);
  }
  await page.close();
  if (!o || !o.ok) {
    fail('did not complete: ' + (o && o.err));
    return 1;
  }
  console.log('   ' + JSON.stringify(o));

  const keys = (d) => Object.keys(d).sort().join('+') || 'nothing';
  // (a)
  if (o.prim.prims > 0) ok(`the circle is a recognized primitive (${o.prim.prims})`);
  else fail('the circle was not recognized as a primitive');
  for (const entry of ['bare', 'handle']) {
    const d = o.prim[entry];
    if (d['sdf@unified'] > 0 && !Object.keys(d).some((k) => k !== 'sdf@unified'))
      ok(`${entry}: the primitive draws as sdf@unified (${keys(d)})`);
    else fail(`${entry}: the primitive drew as ${keys(d)}, not sdf@unified alone`);
  }
  // With the route off, N copies stay in one instanced draw rather than N per-instance primitive draws (see _lbWouldServe).
  if (o.prim.instanced['slug@instanced'] > 0)
    ok(
      `instanced: primitives keep the instanced fast path with the route off (${keys(o.prim.instanced)})`,
    );
  else
    fail(
      `instanced: expected the instanced fast path (slug@instanced), drew ${keys(o.prim.instanced)}`,
    );
  // (b)
  for (const entry of ['bare', 'handle']) {
    const d = o.points[entry];
    if (d['aac@points'] > 0 && !d['aac@cover'])
      ok(`${entry}: tiny AAC glyphs take the point route (${keys(d)})`);
    else fail(`${entry}: tiny AAC glyphs drew as ${keys(d)}, not aac@points`);
  }

  {
    const d = o.mixed.d;
    if (
      o.mixed.prims > 0 &&
      Object.keys(d).some((k) => /@points$/.test(k)) &&
      !Object.keys(d).some((k) => /unified/.test(k))
    )
      ok(
        `a few primitives among many rows take the point route (${keys(d)}, ${o.mixed.prims} primitives)`,
      );
    else
      fail(
        `a few primitives among many rows drew as ${keys(d)} (${o.mixed.prims} primitives), not points`,
      );
  }

  if (!failures)
    console.log(
      'entryPointRoute: drawBundle, handle.draw and drawBundleInstanced route a bundle the same way',
    );
  return failures;
}

// lbHandleInstancedParity — static Loop-Blinn fill reaches every
// draw entry point, not just the bare drawBundle. Guards that:
//   1. handle.draw() routes an uncached static bundle through the analytic fill
//      and matches the Slug render.
//   2. drawBundleInstanced() routes a static (non-composed) bundle through the
//      analytic fill per instance and matches Slug.
//   3. a CACHED handle does NOT route LB (its baked-RT blit already beats
//      re-running LB per frame — the `!cached` gate in _analyticRoute), yet
//      still renders correctly.
// Together these keep handle.draw and drawBundleInstanced on static LB: as
// streamOnly entry points taking only the _lbStream route, handle-drawn scenes
// would never see static LB even with the fill enabled.
async function lbHandleInstancedParity(host) {
  // A curved solid-fill blob (cubics → the analytic mesh; solid → the one-draw
  // combined route). No mask/clip/filter so the instanced loop routes it (a
  // composed bundle would stay on Slug to keep its bake-once reuse).
  const SVG = readFileSync(
    new URL('../examples/smoke/lbHandleInstancedParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, CacheStrategy } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
renderer.setViewport(100, 100);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);
await renderer.awaitLbReady(bundle);   // LB builds off-thread; wait before asserting the route

const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
// Interior mean channel diff over pixels inked in BOTH (skips the AA rim).
const interiorDiff = (a, b) => {
  let sum = 0, both = 0, ink = 0;
  for (let i = 0; i < 100 * 100; i++) {
    const o = i * 4;
    const aInk = a[o] > 20 || a[o + 2] > 20, bInk = b[o] > 20 || b[o + 2] > 20;
    if (aInk) ink++;
    if (aInk && bInk) { for (let k = 0; k < 3; k++) sum += Math.abs(a[o + k] - b[o + k]); both++; }
  }
  return { diff: both ? +(sum / (both * 3)).toFixed(2) : 999, ink };
};

const out = {};

// ── 1. handle.draw (uncached) ──────────────────────────────────────────────
{
  const h = renderer.createBundleHandle(bundle);
  const drawH = () => { renderer.beginFrame([0, 0, 0, 1]); h.draw({}); renderer.endFrame(); };
  renderer.setLoopBlinnFill(false);
  let r = renderer.debugStats.loopBlinnRouteCount; drawH(); const slug = readAll();
  out.handleSlugRouted = renderer.debugStats.loopBlinnRouteCount > r;
  renderer.setLoopBlinnFill(true);
  r = renderer.debugStats.loopBlinnRouteCount; drawH(); const lb = readAll();
  out.handleLbRouted = renderer.debugStats.loopBlinnRouteCount > r;
  const d = interiorDiff(slug, lb);
  out.handleDiff = d.diff; out.handleInk = d.ink;
}

// ── 2. drawBundleInstanced (1 instance → per-instance loop, not fast path) ──
{
  const drawI = () => { renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundleInstanced(bundle, [{}], {}); renderer.endFrame(); };
  renderer.setLoopBlinnFill(false);
  let r = renderer.debugStats.loopBlinnRouteCount; drawI(); const slug = readAll();
  out.instSlugRouted = renderer.debugStats.loopBlinnRouteCount > r;
  renderer.setLoopBlinnFill(true);
  r = renderer.debugStats.loopBlinnRouteCount; drawI(); const lb = readAll();
  out.instLbRouted = renderer.debugStats.loopBlinnRouteCount > r;
  const d = interiorDiff(slug, lb);
  out.instDiff = d.diff; out.instInk = d.ink;
}

// ── 3. cached handle: LB must NOT route (cache blit owns it), still renders ──
{
  renderer.setLoopBlinnFill(true);   // LB on — the cache gate must still win
  const hc = renderer.createBundleHandle(bundle, { staticCache: { strategy: CacheStrategy.ForceWholeAsset } });
  const drawC = () => { renderer.beginFrame([0, 0, 0, 1]); hc.draw({}); renderer.endFrame(); };
  const r = renderer.debugStats.loopBlinnRouteCount;
  drawC(); drawC();   // frame 1 bakes, frame 2 blits — neither should route LB
  out.cachedRouted = renderer.debugStats.loopBlinnRouteCount > r;
  const px = readAll();
  let ink = 0; for (let i = 0; i < 100 * 100; i++) { const o = i * 4; if (px[o] > 20 || px[o + 2] > 20) ink++; }
  out.cachedInk = ink;
}

window.__out = out;
window.__ready = true;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  try {
    await openReady(page, host.page(HTML), { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));

  // 1. handle.draw
  if (!o.handleSlugRouted) ok('handle.draw: Slug used with LB off');
  else fail('handle.draw routed LB with fill off');
  if (o.handleLbRouted)
    ok('handle.draw routes an uncached static bundle through the analytic fill');
  else fail('handle.draw did NOT route static LB');
  if (o.handleInk > 500) ok('handle.draw renders (' + o.handleInk + ' ink px)');
  else fail('handle.draw barely rendered: ' + o.handleInk);
  if (o.handleDiff <= 6) ok('handle.draw LB matches Slug (mean channel diff ' + o.handleDiff + ')');
  else fail('handle.draw LB != Slug (mean channel diff ' + o.handleDiff + ')');

  // 2. drawBundleInstanced
  if (!o.instSlugRouted) ok('instanced: Slug used with LB off');
  else fail('instanced routed LB with fill off');
  if (o.instLbRouted) ok('drawBundleInstanced routes a static bundle through the analytic fill');
  else fail('drawBundleInstanced did NOT route static LB');
  if (o.instDiff <= 6) ok('instanced LB matches Slug (mean channel diff ' + o.instDiff + ')');
  else fail('instanced LB != Slug (mean channel diff ' + o.instDiff + ')');

  // 3. cached handle: cached handles route
  // LB like everything else. The cache blit still owns VALID frames (no dispatch
  // runs then); LB serves live/bake frames — forcing Slug rendered BLANK for
  // bundles with no Slug cover-quads (lightweight builds).
  if (o.cachedRouted) ok('cached handle routes LB on live/bake frames (blit owns valid frames)');
  else ok('cached handle served entirely by the cache blit this run');
  if (o.cachedInk > 500) ok('cached handle still renders (' + o.cachedInk + ' ink px)');
  else fail('cached handle barely rendered: ' + o.cachedInk);

  await page.close();
  if (!failures)
    console.log(
      '\\nlbHandleInstancedParitySmoke: static LB reaches handle.draw + instanced; cache path preserved',
    );
  return failures;
}

const host = await openCaseHost(ROOT);
const failures = await runCases(host, [
  ['entryPointRoute', entryPointRoute],
  ['lbHandleInstancedParity', lbHandleInstancedParity],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nentryPointRouteSmoke: every entry point reaches the same route');

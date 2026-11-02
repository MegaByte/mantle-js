// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbStreamGeometrySmoke.mjs — streaming a solid-fill bundle
// through Loop-Blinn (updateBundleGeometryLB) instead of the Slug cover-quad
// rebuild.
//
// Proves:
//   1. A streamed bundle (geomGen>0) routes to the LB fill path when flagged
//      _lbStream — the policy gate otherwise sends streamed bundles to Slug.
//   2. updateBundleGeometryLB SKIPS the Slug work: bundle.coverQuadFloats is
//      the same reference after the stream (no re-mesh), proving the
//      allocation hog (buildTexturesShape + getCoverQuadMesh) didn't run.
//   3. RENDER PARITY: streaming shape A→B renders the same as a freshly-built
//      static bundle of shape B (and visibly DIFFERENT from A) — the LB mesh
//      rebuilt from the new control points is correct.
//
// Real browser + real WebGL2 (LB is a GPU path).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, buildStreamableSections, updateBundleGeometry, createOverrideTable }
  from '/src/index.js';
// NO explicit flag — a lightweight-built bundle (no cover-quads) must
// auto-detect the analytic path.
const updLight = (bundle, segs) => updateBundleGeometry(gl, bundle, segs);
import { mkLine } from '/src/primitives/seg.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
// Deliberately DO NOT enable the global analytic-fill toggle — the lightweight
// stream must auto-activate the route on its own (asserted below).

const VBOX = [0, 0, 100, 100];
const rectSegs = (x, y, w, h) => [
  mkLine([x, y], [x + w, y]), mkLine([x + w, y], [x + w, y + h]),
  mkLine([x + w, y + h], [x, y + h]), mkLine([x, y + h], [x, y]),
];
// light=true → lightweight build (no Slug cover-quads; for the analytic
// stream). Default builds a normal Slug bundle (used as the ground truth).
const mkBundle = (x, y, w, h, light) =>
  createBundle(gl, buildStreamableSections(
    [{ segs: rectSegs(x, y, w, h), fill: [1, 0, 0, 1] }], VBOX, light ? { lightweight: true } : {}));

const draw = (bundle) => {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(bundle, {});
  renderer.endFrame();
};
// Red-pixel mask stats: count + centroid (in canvas px, origin top-left).
const redStats = () => {
  const px = new Uint8Array(100 * 100 * 4);
  gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let count = 0, sx = 0, sy = 0;
  const mask = new Uint8Array(100 * 100);
  for (let row = 0; row < 100; row++) {
    for (let col = 0; col < 100; col++) {
      const o = (row * 100 + col) * 4;        // readPixels row 0 = bottom
      const yTop = 99 - row;
      if (px[o] > 128 && px[o + 1] < 80 && px[o + 2] < 80) {
        count++; sx += col; sy += yTop; mask[yTop * 100 + col] = 1;
      }
    }
  }
  return { count, cx: count ? sx / count : -1, cy: count ? sy / count : -1, mask: Array.from(mask) };
};
const iou = (a, b) => {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) { const u = a[i] || b[i]; uni += u; inter += (a[i] && b[i]) ? 1 : 0; }
  return uni ? inter / uni : 1;
};

const routeCount = () => renderer.debugStats.loopBlinnRouteCount | 0;
const out = {};

// NOTE: the global analytic-fill toggle stays OFF the entire test. A bundle
// streamed with { lightweight:true } must route to the analytic GPU fill
// AUTOMATICALLY via its _lbStream flag — proving the main draw route activates
// it on its own, with no setLoopBlinnFill call.
renderer.setLoopBlinnFill(false);

// (A) Build a LIGHTWEIGHT streamable bundle (no Slug cover-quads created),
// then STREAM it to shape B via the lightweight path.
const bundle = mkBundle(10, 10, 28, 28, /* light */ true);
out.noCoverQuadsAtBuild = !bundle.coverQuadFloats || bundle.coverQuadFloats.length === 0;
const res = updLight(bundle, [rectSegs(58, 58, 28, 28)]);
out.streamOk = res.ok === true;
out.lbStreamFlag = bundle._lbStream === true;
out.coverQuadUntouched = !bundle.coverQuadFloats || bundle.coverQuadFloats.length === 0;   // still none
out.geomGenBumped = (bundle._geomGen | 0) > 0;
bundle.globalBBox = VBOX.slice();            // pin (lightweight stream sets content bounds)

// (B) Draw the STREAMED bundle — routes to the analytic fill via _lbStream
// despite the global toggle being OFF (auto-activation).
const r1 = routeCount(); draw(bundle); out.bStreamRouted = routeCount() > r1;
out.bStreamStats = redStats();

// (B2) POOLING: stream the SAME topology again (a third position) and confirm
// the per-shape packed VBO + the route's vertex stream are REFILLED in place —
// the same Float32Array references, no per-frame allocation. Render must stay
// correct (parity re-checked below against this final position).
//
// The stream is the UNIFIED route's (bundle._unifiedFill.verts): streamed
// bundles take the unified draw, which pools its buffer so it can be refilled
// in place. A streamed bundle is the one
// case that keeps its CPU stream after upload, precisely so it can be refilled.
const packedRef1 = bundle._lbMeshes[0].verts;
const combinedRef1 = bundle._unifiedFill.verts;
updLight(bundle, [rectSegs(40, 40, 28, 28)]);
bundle.globalBBox = VBOX.slice();
draw(bundle);
out.packedReused = bundle._lbMeshes[0].verts === packedRef1;
out.combinedReused = bundle._unifiedFill.verts === combinedRef1;
out.bStream2Stats = redStats();
// Then stream BACK to position B so the parity check below (vs the Slug
// ground truth at B) validates the pooled-buffer render too.
updLight(bundle, [rectSegs(58, 58, 28, 28)]);
bundle.globalBBox = VBOX.slice();
draw(bundle);
out.packedReused2 = bundle._lbMeshes[0].verts === packedRef1;
out.bStreamStats = redStats();

// (C) Ground truth: a fresh (non-streamed) bundle at shape B's geometry. With
// the global toggle OFF it renders via the SLUG fill. The lightweight-streamed
// output must match this Slug rasterization of the same geometry.
const bundleB = mkBundle(58, 58, 28, 28); draw(bundleB); out.bSlugStats = redStats();
// And shape A's geometry via Slug → confirm the stream actually MOVED it.
const bundleA = mkBundle(10, 10, 28, 28); draw(bundleA); out.aSlugStats = redStats();

out.iouStreamVsSlugB = iou(out.bStreamStats.mask, out.bSlugStats.mask);   // LB == Slug truth
out.iouStreamVsSlugA = iou(out.bStreamStats.mask, out.aSlugStats.mask);   // moved away from A

// (D) HANDLE DRAW — the path the engine actually uses (mountNode →
// createBundleHandle → handle.draw, never a bare drawBundle). The handle's
// per-mount cover-quad VBO is uploaded at create time and the lightweight
// stream does NOT refresh it, so handle.draw MUST route a _lbStream bundle to
// the analytic fill — otherwise it paints the stale initial geometry (the
// road goes invisible). Create the handle at A, stream to B, draw.
const hb = mkBundle(10, 10, 28, 28, /* light */ true);   // no cover-quads
const handle = renderer.createBundleHandle(hb);    // no Slug VBO to go stale
out.handleNoVbo = !hb.coverQuadFloats || hb.coverQuadFloats.length === 0;
updLight(hb, [rectSegs(58, 58, 28, 28)]);          // stream to B
hb.globalBBox = VBOX.slice();
const rh = routeCount();
renderer.setViewport(100, 100);
renderer.beginFrame([0, 0, 0, 1]);
handle.draw({});
renderer.endFrame();
out.handleRouted = routeCount() > rh;
out.handleStats = redStats();
out.iouHandleVsSlugB = iou(out.handleStats.mask, out.bSlugStats.mask);   // streamed pos, not stale A
out.iouHandleVsSlugA = iou(out.handleStats.mask, out.aSlugStats.mask);   // must NOT be the stale A geom

delete out.bStreamStats.mask; delete out.bSlugStats.mask; delete out.aSlugStats.mask; delete out.handleStats.mask;

// (E) FILL OVERRIDE (the road's fog) — a per-shape fill override must recolor
// a lightweight-streamed bundle through the analytic route (baked into the
// combined VBO). Base fill is red; the override recolors to green.
const ob = mkBundle(20, 20, 60, 60, /* light */ true);
updLight(ob, [rectSegs(20, 20, 60, 60)]);
ob.globalBBox = VBOX.slice();
const ovr = createOverrideTable(gl, ob);
ovr.set(0, { fill: [0, 1, 0, 1] });   // recolor shape 0 red→green (fog)
const ro = routeCount();
renderer.setViewport(100, 100);
renderer.beginFrame([0, 0, 0, 1]);
renderer.drawBundle(ob, { overrides: ovr });
renderer.endFrame();
out.overrideRouted = routeCount() > ro;
{ const px = new Uint8Array(4); gl.readPixels(50, 50, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  out.overrideCenter = [px[0], px[1], px[2]]; }

// (F) INSTANCED draw of a lightweight-streamed bundle — each instance must
// route through the analytic fill (it has no Slug cover-quad VBO to fall back
// on). Two instances → two analytic-route draws + visible output.
const ib = mkBundle(35, 35, 30, 30, /* light */ true);
updLight(ib, [rectSegs(35, 35, 30, 30)]);
ib.globalBBox = VBOX.slice();
const ri = routeCount();
renderer.setViewport(100, 100);
renderer.beginFrame([0, 0, 0, 1]);
out.instCount = renderer.drawBundleInstanced(ib, [{ alpha: 1 }, { alpha: 1 }]);
renderer.endFrame();
out.instRouted = routeCount() - ri;   // expect 2 (one analytic draw per instance)
out.instRed = redStats().count;

window.__out = out;
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try {
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);

if (o.streamOk) ok('updateBundleGeometry({lightweight:true}) returns ok');
else fail('lightweight updateBundleGeometry failed');
if (o.lbStreamFlag && o.geomGenBumped) ok('lightweight stream flags the bundle + bumps geomGen');
else fail('stream flags wrong: ' + JSON.stringify({ f: o.lbStreamFlag, g: o.geomGenBumped }));
if (o.noCoverQuadsAtBuild)
  ok('lightweight BUILD creates NO Slug cover-quads (no stale VBO possible by construction)');
else fail('lightweight build still created cover-quads');
if (o.coverQuadUntouched) ok('still no cover-quads after streaming (Slug pipeline never touched)');
else fail('cover-quads appeared after streaming');
if (o.bStreamRouted)
  ok('AUTO-ROUTE: streamed bundle renders via the analytic GPU fill with the global toggle OFF');
else fail('streamed bundle did not auto-route to the analytic fill');
if (o.bStreamStats.count > 300)
  ok(
    'streamed-B renders via LB (' +
      o.bStreamStats.count +
      ' red px at ~' +
      o.bStreamStats.cx.toFixed(0) +
      ',' +
      o.bStreamStats.cy.toFixed(0) +
      ')',
  );
else fail('streamed-B did not render: ' + JSON.stringify(o.bStreamStats));

// Buffers are refilled in place across same-topology frames.
if (o.packedReused && o.combinedReused && o.packedReused2)
  ok(
    'pooling: per-shape + combined VBOs refilled in place across frames (no per-frame Float32Array alloc)',
  );
else
  fail(
    'pooling failed (new buffers allocated): ' +
      JSON.stringify({
        packed: o.packedReused,
        combined: o.combinedReused,
        packed2: o.packedReused2,
      }),
  );
if (o.bStream2Stats.count > 300)
  ok(
    'pooled-buffer render still correct (' +
      o.bStream2Stats.count +
      ' red px at ~' +
      o.bStream2Stats.cx.toFixed(0) +
      ',' +
      o.bStream2Stats.cy.toFixed(0) +
      ')',
  );
else fail('pooled-buffer render wrong: ' + JSON.stringify(o.bStream2Stats));

if (o.iouStreamVsSlugB > 0.9)
  ok(
    'render parity: LB-streamed matches the Slug ground truth (IoU ' +
      o.iouStreamVsSlugB.toFixed(3) +
      ')',
  );
else fail('LB-streamed != Slug truth (IoU ' + o.iouStreamVsSlugB.toFixed(3) + ')');
if (o.iouStreamVsSlugA < 0.4)
  ok('streamed geometry actually moved A→B (IoU vs A ' + o.iouStreamVsSlugA.toFixed(3) + ')');
else fail('streamed geometry did not change (IoU vs A ' + o.iouStreamVsSlugA.toFixed(3) + ')');

// (D) HANDLE-DRAW path (the engine's real path).
if (o.handleNoVbo) ok('handle created with NO Slug cover-quad VBO (lightweight bundle)');
else fail('handle uploaded a cover-quad VBO for a lightweight bundle');
if (o.handleRouted)
  ok('HANDLE DRAW: lightweight-streamed bundle routes to the analytic fill via handle.draw()');
else fail('handle.draw() did NOT route to the analytic fill — would render stale Slug geometry');
if (o.iouHandleVsSlugB > 0.9 && o.iouHandleVsSlugA < 0.4)
  ok(
    'HANDLE DRAW renders the STREAMED geometry, not the stale per-mount VBO (IoU vsB ' +
      o.iouHandleVsSlugB.toFixed(3) +
      ', vsA ' +
      o.iouHandleVsSlugA.toFixed(3) +
      ')',
  );
else
  fail(
    'handle.draw() rendered stale/wrong geometry: IoU vsB ' +
      o.iouHandleVsSlugB.toFixed(3) +
      ' vsA ' +
      o.iouHandleVsSlugA.toFixed(3),
  );

// (E) FILL OVERRIDE (fog) — recolors through the analytic route.
if (o.overrideRouted)
  ok('FILL OVERRIDE: a bundle drawn WITH overrides still routes to the analytic fill');
else fail('override draw skipped the analytic route');
if (o.overrideCenter && o.overrideCenter[1] > 150 && o.overrideCenter[0] < 100)
  ok(
    'fill override recolors red→green through the analytic fill (center=' +
      JSON.stringify(o.overrideCenter) +
      ')',
  );
else
  fail(
    'fill override not applied (center=' + JSON.stringify(o.overrideCenter) + ', expected green)',
  );

// (F) INSTANCED draw routing.
if (o.instCount === 2 && o.instRouted === 2 && o.instRed > 300)
  ok(
    'drawBundleInstanced routes each instance through the analytic fill (' +
      o.instRouted +
      ' routed, ' +
      o.instRed +
      ' px)',
  );
else
  fail(
    'instanced analytic routing wrong: ' +
      JSON.stringify({ n: o.instCount, routed: o.instRouted, red: o.instRed }),
  );

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nlbStreamGeometrySmoke: all assertions passed');

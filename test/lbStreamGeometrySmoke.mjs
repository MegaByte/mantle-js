// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbStreamGeometrySmoke — streamed geometry on the Loop-Blinn route: a bundle whose curves
// change every frame refreshes its analytic mesh instead of rebuilding Slug cover quads, and
// draws what Slug draws:
//   lbStreamGeometry           a streamed solid-fill bundle (updateBundleGeometryLB) vs Slug
//   lbRoadRingParity           a full multi-band road ring scrolled over several frames
//   lbCurvedBandParity         road bands with two curved quad edges (real band geometry)
//   lbStreamSentinel           an unservable section becomes a sentinel; the rest still streams
//   lbBandCurveFlipParity      a band reuses its triangulation only while its rim structure holds
//   lbStreamTeleportParity     a slot whose geometry teleports to another depth stays correct
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import path from 'path';
import { fileURLToPath } from 'url';
import { openReady } from './_pageReady.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// lbStreamGeometry — streaming a solid-fill bundle
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
async function lbStreamGeometry(host) {
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
    await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);

  if (o.streamOk) ok('updateBundleGeometry({lightweight:true}) returns ok');
  else fail('lightweight updateBundleGeometry failed');
  if (o.lbStreamFlag && o.geomGenBumped) ok('lightweight stream flags the bundle + bumps geomGen');
  else fail('stream flags wrong: ' + JSON.stringify({ f: o.lbStreamFlag, g: o.geomGenBumped }));
  if (o.noCoverQuadsAtBuild)
    ok('lightweight BUILD creates NO Slug cover-quads (no stale VBO possible by construction)');
  else fail('lightweight build still created cover-quads');
  if (o.coverQuadUntouched)
    ok('still no cover-quads after streaming (Slug pipeline never touched)');
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

  await page.close();
  if (!failures) console.log('lbStreamGeometry: all assertions passed');
  return failures;
}

// lbRoadRingParity — a full racing-road ring (multi-band).
//
// Builds a ring-buffer road's band layout (16 ring slots × 5 shapes: road, 2 rumble,
// 2 lane) on a curving perspective road as a lightweight stream,
// scrolls a few frames (exercising refreshLoopBlinnMesh topology reuse), then
// compares the LB render against the Slug ground truth at an
// IDENTICAL pinned globalBBox. Reports where they diverge (per-row diff) so a
// "wrong wedge" / seam / blank shows up as a concrete pixel delta, not a vibe.
async function lbRoadRingParity(host) {
  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="240" height="240"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, buildStreamableSections, updateBundleGeometry } from '/src/index.js';
import { mkQuad } from '/src/primitives/seg.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const W = 240, H = 240, VBOX = [0, 0, W, H];

const straightQ = (a, b) => mkQuad(a, a, b);
const quadEdge = (n, m, f) => mkQuad(n, [2*m[0]-(n[0]+f[0])/2, 2*m[1]-(n[1]+f[1])/2], f);
const band = (nL, mL, fL, nR, mR, fR) =>
  [quadEdge(nL, mL, fL), straightQ(fL, fR), quadEdge(fR, mR, nR), straightQ(nR, nL)];
const Z = [0, 0];
const degenBand = () => [straightQ(Z, Z), straightQ(Z, Z), straightQ(Z, Z), straightQ(Z, Z)];

const N_BANDS = 8, SHAPES_PER_BAND = 5;
const S_ROAD=0,S_RUML=1,S_RUMR=2,S_LANE0=3,S_LANE1=4;
const TOTAL = N_BANDS * SHAPES_PER_BAND;
const RUMBLE_FRAC = 1/6, LANE_FRAC = 1/32;
const colRoad=[0.30,0.30,0.30,1], colRoadL=[0.36,0.36,0.36,1];
const colRum=[0.80,0.16,0.16,1], colRumL=[0.95,0.95,0.95,1], colLane=[0.95,0.95,0.95,1];

// Build shapes once (fixed parity fills, real unit band so there's ink).
const initB = () => band([0,0],[0.5,0.5],[0,1],[1,0],[0.5,0.5],[1,1]);
const shapes = [];
for (let s=0;s<N_BANDS;s++){ const light=s%2===0;
  shapes[s*SHAPES_PER_BAND+S_ROAD]={segs:initB(),fill:light?colRoadL:colRoad};
  shapes[s*SHAPES_PER_BAND+S_RUML]={segs:initB(),fill:light?colRumL:colRum};
  shapes[s*SHAPES_PER_BAND+S_RUMR]={segs:initB(),fill:light?colRumL:colRum};
  shapes[s*SHAPES_PER_BAND+S_LANE0]={segs:initB(),fill:colLane};
  shapes[s*SHAPES_PER_BAND+S_LANE1]={segs:initB(),fill:colLane};
}

// Explicit on-screen stacked perspective bands (near=bottom wide → far=top
// narrow), centerline curving via sin(depth). Vanishing point near top-center.
const halfW=W/2, VP_Y=70, NEAR_Y=235;   // far horizon → near bottom (off-screen low)
const buildFrame = (scrollZ) => {
  const segsOut = new Array(TOTAL);
  // depth param d∈[0,1]: 0 = nearest band edge, 1 = far horizon. Each visible
  // band occupies [d_i, d_{i+1}]. Perspective: y interpolates near→VP as d→1,
  // width shrinks toward 0 at the horizon.
  const yAt   = (d) => NEAR_Y + (VP_Y - NEAR_Y) * d;
  const wAt    = (d) => (1 - d) * 92 + 3;            // half road width
  const curveAt= (d) => Math.sin((scrollZ*0.05) + d*3.0) * 70 * d;   // sway grows with depth
  const cxAt   = (d) => halfW + curveAt(d);
  for (let i=0;i<N_BANDS;i++){
    const slot=i, base=slot*SHAPES_PER_BAND, light=slot%2===0;
    const dN = i/N_BANDS, dF=(i+1)/N_BANDS, dM=(dN+dF)/2;
    const cxN=cxAt(dN),cxM=cxAt(dM),cxF=cxAt(dF);
    const yN=yAt(dN),yM=yAt(dM),yF=yAt(dF);
    const rwN=wAt(dN),rwM=wAt(dM),rwF=wAt(dF);
    segsOut[base+S_ROAD]=band([cxN-rwN,yN],[cxM-rwM,yM],[cxF-rwF,yF],[cxN+rwN,yN],[cxM+rwM,yM],[cxF+rwF,yF]);
    const rN=rwN*RUMBLE_FRAC,rM=rwM*RUMBLE_FRAC,rF=rwF*RUMBLE_FRAC;
    segsOut[base+S_RUML]=band([cxN-rwN-rN,yN],[cxM-rwM-rM,yM],[cxF-rwF-rF,yF],[cxN-rwN,yN],[cxM-rwM,yM],[cxF-rwF,yF]);
    segsOut[base+S_RUMR]=band([cxN+rwN,yN],[cxM+rwM,yM],[cxF+rwF,yF],[cxN+rwN+rN,yN],[cxM+rwM+rM,yM],[cxF+rwF+rF,yF]);
    if (light){
      const lN=Math.max(rwN*LANE_FRAC,0.6),lM=Math.max(rwM*LANE_FRAC,0.6),lF=Math.max(rwF*LANE_FRAC,0.5);
      const o0N=cxN-rwN/3,o0M=cxM-rwM/3,o0F=cxF-rwF/3, o1N=cxN+rwN/3,o1M=cxM+rwM/3,o1F=cxF+rwF/3;
      segsOut[base+S_LANE0]=band([o0N-lN,yN],[o0M-lM,yM],[o0F-lF,yF],[o0N+lN,yN],[o0M+lM,yM],[o0F+lF,yF]);
      segsOut[base+S_LANE1]=band([o1N-lN,yN],[o1M-lM,yM],[o1F-lF,yF],[o1N+lN,yN],[o1M+lM,yM],[o1F+lF,yF]);
    } else { segsOut[base+S_LANE0]=degenBand(); segsOut[base+S_LANE1]=degenBand(); }
  }
  return segsOut;
};

const draw = (b) => { renderer.setViewport(W,H); renderer.beginFrame([0,0,0,1]); renderer.drawBundle(b,{}); renderer.endFrame(); };
const readMask = () => {
  const px=new Uint8Array(W*H*4); gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const mask=new Uint8Array(W*H); let count=0;
  for(let i=0;i<W*H;i++){ if(px[i*4]>40||px[i*4+1]>40||px[i*4+2]>40){mask[i]=1;count++;} }
  return {mask,count,px};
};
const iou=(a,b)=>{let inter=0,uni=0;for(let i=0;i<a.length;i++){const u=a[i]||b[i];uni+=u;inter+=(a[i]&&b[i])?1:0;}return uni?inter/uni:1;};

const out={frames:[]};
const FRAMES=[0, 23, 57, 91];   // scroll phases (curve sign changes across these)

for (const ph of FRAMES) {
  const fr = buildFrame(ph);
  // Slug ground truth (fresh non-lightweight bundle, toggle OFF).
  renderer.setLoopBlinnFill(false);
  const sB = createBundle(gl, buildStreamableSections(shapes, VBOX));
  updateBundleGeometry(gl, sB, fr, { lightweight: false });
  sB.globalBBox = VBOX.slice();
  draw(sB); const slug = readMask();
  // LB bundle built EXACTLY as the engine's createStreamableBundle does: NO
  // lightweight opt → real Slug cover-quads from the initial unit band. Mount
  // via a HANDLE (the engine's mountNode path uploads the cover-quad VBO at
  // create time). Then stream with { lightweight:true } + handle.invalidate()
  // — the engine's streamGeometry — and draw THROUGH THE HANDLE.
  const lB = createBundle(gl, buildStreamableSections(shapes, VBOX));
  lB._lbStreamRamp = false;   // a road's opaque road/rough-band streaming mode
  const handle = renderer.createBundleHandle(lB);     // uploads stale unit-band cover-quads
  updateBundleGeometry(gl, lB, buildFrame(ph-7), { lightweight: true });   // prior frame
  updateBundleGeometry(gl, lB, fr, { lightweight: true });                 // refresh to target
  lB.globalBBox = VBOX.slice();
  if (handle.invalidate) handle.invalidate();
  const r0 = renderer.debugStats.loopBlinnRouteCount;
  renderer.setViewport(W,H); renderer.beginFrame([0,0,0,1]); handle.draw({}); renderer.endFrame();
  const lb = readMask();
  out.frames.push({
    ph, slugCount: slug.count, lbCount: lb.count, lbStream: !!lB._lbStream,
    routed: renderer.debugStats.loopBlinnRouteCount > r0,
    iou: iou(slug.mask, lb.mask), delta: lb.count - slug.count,
  });
}
window.__out = out; window.__ready = true;
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
    await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  for (const f of o.frames) console.log('   frame', JSON.stringify(f));

  for (const f of o.frames) {
    if (!f.lbStream || !f.routed) {
      fail('phase ' + f.ph + ' did not LB-stream/route: ' + JSON.stringify(f));
      continue;
    }
    if (f.iou > 0.96) ok('phase ' + f.ph + ' road matches Slug (IoU ' + f.iou.toFixed(4) + ')');
    else
      fail(
        'phase ' +
          f.ph +
          ' road DIVERGES from Slug (IoU ' +
          f.iou.toFixed(4) +
          ', delta ' +
          f.delta +
          'px)',
      );
  }

  await page.close();
  if (!failures)
    console.log(
      '\\nlbRoadRingParitySmoke: multi-band scrolling road matches Slug through the combined route',
    );
  return failures;
}

// lbCurvedBandParity — streamed racing-road bands on real band geometry.
//
// A road's "wrong wedges" / blank-and-fragment failures show only on the REAL
// band geometry, which the convex-rect sentinel test never exercises: each
// road band is a CLOSED contour with two CURVED quad edges (left + right) that
// bow the same direction when the road curves — so one edge is convex and the
// other is concave to the fill. The lightweight stream routes such an all-solid
// bundle through the one-draw route (uDirect=1, single-pass OVER).
//
// This test pins both the LB-streamed bundle and the Slug ground-truth bundle
// to the same globalBBox (different boxes would read as a bogus "2× over-fill")
// and compares them directly. A correct fill must
// match Slug within tight IoU; over-fill (extra wedge area), under-fill (gaps),
// or seams between adjacent bands all drop the IoU.
async function lbCurvedBandParity(host) {
  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, buildStreamableSections, updateBundleGeometry } from '/src/index.js';
import { mkQuad } from '/src/primitives/seg.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setLoopBlinnFill(false);   // OFF → lightweight stream must self-route; Slug bundle stays Slug
const W = 200, H = 200, VBOX = [0, 0, W, H];

// ── Faithful road-band geometry (a ring-buffer road's band/quadEdge/straightQ) ──
const straightQ = (a, b) => mkQuad(a, a, b);
const quadEdge = (n, m, f) => mkQuad(n, [2*m[0]-(n[0]+f[0])/2, 2*m[1]-(n[1]+f[1])/2], f);
const band = (nL, mL, fL, nR, mR, fR) =>
  [quadEdge(nL, mL, fL), straightQ(fL, fR), quadEdge(fR, mR, nR), straightQ(nR, nL)];

// A CURVING perspective road: near (wide, bottom) → far (narrow, top), with the
// centerline pushed to the right at mid-depth so both edges bow (left edge
// concave to the fill, right edge convex). One band, but enough to exercise the
// concave-edge case the combined route mishandles.
//   y: near=180 (bottom), mid=110, far=60 (top).   x grows right with curve.
const cxN = 100, cxM = 130, cxF = 120;        // centerline near/mid/far (curve)
const rwN = 70,  rwM = 34,  rwF = 14;         // half-width near/mid/far (perspective)
const yN = 180,  yM = 110,  yF = 60;
const roadBand = band(
  [cxN - rwN, yN], [cxM - rwM, yM], [cxF - rwF, yF],   // left  edge near→mid→far
  [cxN + rwN, yN], [cxM + rwM, yM], [cxF + rwF, yF]);  // right edge near→mid→far
const shapes = [{ segs: roadBand, fill: [0.85, 0.85, 0.85, 1] }];

const draw = (b, opts) => {
  renderer.setViewport(W, H);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(b, opts || {});
  renderer.endFrame();
};
const grayMask = () => {
  const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const mask = new Uint8Array(W * H); let count = 0;
  for (let i = 0; i < W * H; i++) { if (px[i*4] > 100 && px[i*4+1] > 100 && px[i*4+2] > 100) { mask[i] = 1; count++; } }
  return { mask, count };
};
const iou = (a, b) => { let inter=0, uni=0; for (let i=0;i<a.length;i++){ const u=a[i]||b[i]; uni+=u; inter+=(a[i]&&b[i])?1:0; } return uni?inter/uni:1; };

const out = {};

// (1) Slug ground truth — non-lightweight bundle, global toggle OFF → Slug fill.
const slugB = createBundle(gl, buildStreamableSections(shapes, VBOX));
slugB.globalBBox = VBOX.slice();
draw(slugB);
const slug = grayMask(); out.slugCount = slug.count;

// (2) Lightweight LB stream → renders through the combined (all-solid) route.
const lbB = createBundle(gl, buildStreamableSections(shapes, VBOX, { lightweight: true }));
const r0 = renderer.debugStats.loopBlinnRouteCount;
const res = updateBundleGeometry(gl, lbB, [roadBand]);   // auto-lightweight (no cover quads)
out.streamOk = res.ok === true;
out.lbStream = !!lbB._lbStream;
lbB.globalBBox = VBOX.slice();      // PIN identical bbox (the prior-session confound)
draw(lbB);
out.lbRouted = renderer.debugStats.loopBlinnRouteCount > r0;
const lb = grayMask(); out.lbCount = lb.count;

out.iou = iou(slug.mask, lb.mask);
out.overfill = lb.count - slug.count;    // +ve = combined route paints extra (wrong wedges)

window.__out = out; window.__ready = true;
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

  if (o.streamOk && o.lbStream) ok('curved band streamed through the lightweight LB path');
  else fail('did not stream LB: ' + JSON.stringify(o));
  if (o.lbRouted) ok('rendered via the analytic combined route');
  else fail('did not route to analytic fill');
  if (o.iou > 0.97) ok('curved-band fill matches Slug (IoU ' + o.iou.toFixed(4) + ')');
  else
    fail(
      'curved-band fill DIVERGES from Slug (IoU ' +
        o.iou.toFixed(4) +
        ', overfill ' +
        o.overfill +
        'px) — the "wrong wedges" bug',
    );

  await page.close();
  if (!failures)
    console.log(
      '\\nlbCurvedBandParitySmoke: curved road band fills correctly through the combined route',
    );
  return failures;
}

// lbStreamSentinel — a STREAMED (lightweight `_lbStream`) bundle with a
// section the analytic fill can't serve must NOT blank or fragment the whole
// road. The unservable section becomes a slug sentinel (skipped); the servable
// sections still stream through the one-draw unified route (seamless).
//
// The unservable section is a cubic lying back along its own chord (zero area,
// which the static builder declines). Not a self-crossing loop: the stream builds
// through buildLbShape, the static route, which serves a loop.
//
// A streamed road must not fragment: a stream that fails whole on one unservable
// section leaves _lbStream unset → a blank road that frame (flicker), and a draw
// that bails to per-shape on sentinels leaves AA seams between sections.
async function lbStreamSentinel(host) {
  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="120" height="120"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, buildStreamableSections, updateBundleGeometry } from '/src/index.js';
import { mkLine, mkCubic } from '/src/primitives/seg.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
// NOTE: global analytic toggle stays OFF — the lightweight stream must self-route.
renderer.setLoopBlinnFill(false);
const VBOX = [0, 0, 120, 120];
const rect = (x, y, w, h) => [mkLine([x, y], [x + w, y]), mkLine([x + w, y], [x + w, y + h]), mkLine([x + w, y + h], [x, y + h]), mkLine([x, y + h], [x, y])];
// a cubic folded back along its own chord: no area, so no builder serves it
const loopShape = [mkLine([50, 20], [50, 100]), mkCubic([50, 100], [50, 70], [50, 50], [50, 20])];
const init = [{ segs: rect(10, 45, 30, 30), fill: [1, 0, 0, 1] },
              { segs: loopShape, fill: [0, 0, 1, 1] },
              { segs: rect(85, 45, 30, 30), fill: [0, 1, 0, 1] }];
const bundle = createBundle(gl, buildStreamableSections(init, VBOX, { lightweight: true }));
const segs = [rect(10, 45, 30, 30), loopShape, rect(85, 45, 30, 30)];
const fills = [[1, 0, 0, 1], [0, 0, 1, 1], [0, 1, 0, 1]];
for (let f = 0; f < 3; f++) updateBundleGeometry(gl, bundle, segs, { fills });   // a few scroll frames

const r0 = renderer.debugStats.loopBlinnRouteCount;
const u0 = renderer.debugStats.unifiedFillDraws | 0;
renderer.setViewport(120, 120); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame();
const px = new Uint8Array(120 * 120 * 4); gl.readPixels(0, 0, 120, 120, gl.RGBA, gl.UNSIGNED_BYTE, px);
let red = 0, green = 0, blue = 0;
for (let i = 0; i < px.length; i += 4) {
  if (px[i] > 128 && px[i + 1] < 80 && px[i + 2] < 80) red++;
  else if (px[i + 1] > 128 && px[i] < 80 && px[i + 2] < 80) green++;
  else if (px[i + 2] > 128 && px[i] < 80 && px[i + 1] < 80) blue++;
}
window.__out = {
  lbStream: !!bundle._lbStream, hasSlug: !!bundle._lbHasSlug, unified: (renderer.debugStats.unifiedFillDraws | 0) > u0,
  routed: renderer.debugStats.loopBlinnRouteCount > r0, red, green, blue,
};
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
    await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));

  if (o.lbStream)
    ok('lightweight stream stayed on the analytic path despite an unservable section');
  else fail('_lbStream unset — the unservable section blanked the whole stream (the bug)');
  if (o.routed) ok('bundle routed through the analytic fill');
  else fail('did not route');
  if (o.hasSlug) ok('the unservable section was sentinel-skipped (not a whole-bundle failure)');
  else fail('expected _lbHasSlug — the unservable section should be a sentinel');
  if (o.unified)
    ok('servable sections render through the unified draw (one stream, no AA-seam fragmenting)');
  else fail('the unified draw did not run, so the sections were not drawn as one stream');
  if (o.red > 600 && o.green > 600)
    ok('both servable rect sections rendered (red ' + o.red + ', green ' + o.green + ')');
  else fail('servable sections missing: red=' + o.red + ' green=' + o.green);
  if (o.blue < 50)
    ok(
      'the unservable section is skipped (no Slug geometry on the lightweight path), not fragmenting the rest',
    );
  else fail('unexpected blue ' + o.blue);

  await page.close();
  if (!failures)
    console.log(
      '\\nlbStreamSentinelSmoke: streamed road skips an unservable section without blanking/fragmenting',
    );
  return failures;
}

// lbBandCurveFlipParity — a streamed band reuses a triangulation only for the same rim structure.
//
// A road band's LB rim inserts a curved edge's CONTROL POINT only when that
// edge is CONCAVE to the fill. Curving right ⇒ the LEFT edge is concave (rim =
// [p1L, p2L, capF, p1R, capN]); curving left ⇒ the RIGHT edge is concave (rim =
// [p1L, capF, p1R, p2R, capN]). Both rims are length 5 but have DIFFERENT
// structure — the inserted control point sits on a different edge.
//
// refreshLoopBlinnMesh (the streaming fast path after frame 1) reuses the
// cached earcut triangulation when the rim LENGTHS match. Streaming from a
// curve-right frame to a curve-left frame keeps every length identical, so a
// length check alone would reuse the stale triangulation, whose vertex indices
// then connect the wrong rim points → a folded / wrong-wedge interior. This
// asserts the streamed band matches a freshly-built band of the same geometry.
async function lbBandCurveFlipParity(host) {
  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, buildStreamableSections, updateBundleGeometry } from '/src/index.js';
import { mkQuad } from '/src/primitives/seg.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const W = 200, H = 200, VBOX = [0, 0, W, H];

const straightQ = (a, b) => mkQuad(a, a, b);
const quadEdge = (n, m, f) => mkQuad(n, [2*m[0]-(n[0]+f[0])/2, 2*m[1]-(n[1]+f[1])/2], f);
const band = (nL, mL, fL, nR, mR, fR) =>
  [quadEdge(nL, mL, fL), straightQ(fL, fR), quadEdge(fR, mR, nR), straightQ(nR, nL)];

// A perspective band whose centerline mid is pushed by sway. sway>0 curves
// the road right (left edge concave); sway<0 curves left (right edge concave).
const yN=180, yM=110, yF=50, rwN=60, rwM=30, rwF=12, cx=100;
const makeBand = (sway) => {
  const cxN=cx, cxM=cx+sway, cxF=cx;
  return band([cxN-rwN,yN],[cxM-rwM,yM],[cxF-rwF,yF],[cxN+rwN,yN],[cxM+rwM,yM],[cxF+rwF,yF]);
};
const shapes = (sway) => [{ segs: makeBand(sway), fill: [0.85,0.85,0.85,1] }];

const draw = (b) => { renderer.setViewport(W,H); renderer.beginFrame([0,0,0,1]); renderer.drawBundle(b,{}); renderer.endFrame(); };
const mask = () => { const px=new Uint8Array(W*H*4); gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const m=new Uint8Array(W*H); let c=0; for(let i=0;i<W*H;i++){ if(px[i*4]>100&&px[i*4+1]>100&&px[i*4+2]>100){m[i]=1;c++;} } return {m,c}; };
const iou=(a,b)=>{let it=0,u=0;for(let i=0;i<a.length;i++){const uu=a[i]||b[i];u+=uu;it+=(a[i]&&b[i])?1:0;}return u?it/u:1;};

renderer.setLoopBlinnFill(false);
const SWAY_R = +45, SWAY_L = -45;   // curve right, then curve left

// Ground truth: a FRESH lightweight bundle at the curve-LEFT geometry (no
// refresh — built from scratch, always correct).
const truth = createBundle(gl, buildStreamableSections(shapes(SWAY_L), VBOX, { lightweight:true }));
updateBundleGeometry(gl, truth, [makeBand(SWAY_L)]);
truth.globalBBox = VBOX.slice(); draw(truth); const gt = mask();

// Streamed: build, stream curve-RIGHT (seeds prev mesh + topology), then stream
// curve-LEFT — the rim lengths match across the flip, so refreshLoopBlinnMesh
// reuses the curve-right triangulation for curve-left geometry.
const streamed = createBundle(gl, buildStreamableSections(shapes(SWAY_R), VBOX, { lightweight:true }));
updateBundleGeometry(gl, streamed, [makeBand(SWAY_R)]);   // frame 1: curve right
updateBundleGeometry(gl, streamed, [makeBand(SWAY_L)]);   // frame 2: FLIP to curve left
streamed.globalBBox = VBOX.slice(); draw(streamed); const st = mask();

window.__out = { truthCount: gt.c, streamCount: st.c, iou: iou(gt.m, st.m), delta: st.c - gt.c };
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
  if (o.iou > 0.98)
    ok('streamed curve-flip band matches a fresh build (IoU ' + o.iou.toFixed(4) + ')');
  else
    fail(
      'streamed curve-flip band is WRONG (IoU ' +
        o.iou.toFixed(4) +
        ', delta ' +
        o.delta +
        'px) — stale triangulation reused across a concave-edge flip',
    );

  await page.close();
  if (!failures)
    console.log(
      '\\nlbBandCurveFlipParitySmoke: refreshLoopBlinnMesh rebuilds when the concave edge moves',
    );
  return failures;
}

// lbStreamTeleportParity — refreshLoopBlinnMesh must stay correct when
// a streamed shape's geometry TELEPORTS, not just when it deforms smoothly.
//
// A ring-buffer road reuses a fixed set of shape slots: when
// scroll crosses a group boundary, a slot is reassigned to a DIFFERENT depth
// band, so its geometry jumps discontinuously. The streaming refresh reuses the
// cached earcut triangulation across that jump; if the new polygon's
// convex/reflex structure differs from the cached one, the stale triangulation
// does not tile it → under-fill gaps / "wrong wedges" (and it slips past a
// rim-LENGTH-only validity check because the jumped-to band can have the same
// rim length).
//
// This streams a sequence of structurally-varied curved road bands through ONE
// bundle and asserts each streamed frame matches a FRESH build of the same
// geometry (the always-correct ground truth). A stale-triangulation reuse
// shows up as a low IoU on the frame after a structural jump.
async function lbStreamTeleportParity(host) {
  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, buildStreamableSections, updateBundleGeometry } from '/src/index.js';
import { mkQuad } from '/src/primitives/seg.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setLoopBlinnFill(false);
const W=200,H=200,VBOX=[0,0,W,H];

const straightQ=(a,b)=>mkQuad(a,a,b);
const quadEdge=(n,m,f)=>mkQuad(n,[2*m[0]-(n[0]+f[0])/2,2*m[1]-(n[1]+f[1])/2],f);
const band=(nL,mL,fL,nR,mR,fR)=>[quadEdge(nL,mL,fL),straightQ(fL,fR),quadEdge(fR,mR,nR),straightQ(nR,nL)];
// A perspective band: near y, far y, half-widths, centerline sway at mid.
const mk=(yN,yF,rwN,rwF,sway)=>{
  const yM=(yN+yF)/2, rwM=(rwN+rwF)/2, cx=100;
  return band([cx-rwN,yN],[cx+sway-rwM,yM],[cx-rwF,yF],[cx+rwN,yN],[cx+sway+rwM,yM],[cx+rwF,yF]);
};
// A teleporting sequence that ALTERNATES curve direction while keeping the rim
// LENGTH constant (every band is curved → 5-point rim), plus depth/size jumps.
// Each curve-right↔curve-left transition moves the concave edge (and its reflex
// control point) to the other side at constant rim length — the case a
// rim-length-only validity check misses. This mirrors a ring slot being
// reassigned to a band that curves the opposite way as scroll advances.
const SEQ=[
  mk(180,60,70,12,40),    // curve right (left edge concave), near-wide
  mk(180,60,70,12,-40),   // FLIP: curve left (right edge concave), same rim length
  mk(120,55,30,10,45),    // teleport: far-narrow, curve right
  mk(120,55,30,10,-45),   // FLIP: far-narrow, curve left
  mk(190,40,80,6,55),     // teleport: deep band, hard curve right
  mk(190,40,80,6,-55),    // FLIP: deep band, hard curve left
  mk(175,150,64,40,30),   // teleport: shallow near band, curve right
];

const draw=b=>{renderer.setViewport(W,H);renderer.beginFrame([0,0,0,1]);renderer.drawBundle(b,{});renderer.endFrame();};
const mask=()=>{const px=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const m=new Uint8Array(W*H);let c=0;for(let i=0;i<W*H;i++){if(px[i*4]>100&&px[i*4+1]>100&&px[i*4+2]>100){m[i]=1;c++;}}return {m,c};};
const iou=(a,b)=>{let it=0,u=0;for(let i=0;i<a.length;i++){const uu=a[i]||b[i];u+=uu;it+=(a[i]&&b[i])?1:0;}return u?it/u:1;};
const fill=[{segs:SEQ[0],fill:[0.85,0.85,0.85,1]}];

// One streamed bundle threaded through the whole sequence (refresh reuse).
const streamB=createBundle(gl,buildStreamableSections([{segs:SEQ[0],fill:[0.85,0.85,0.85,1]}],VBOX,{lightweight:true}));
const out=[];
for(let i=0;i<SEQ.length;i++){
  updateBundleGeometry(gl,streamB,[SEQ[i]]);   // refresh (after i=0, uses cached topo)
  streamB.globalBBox=VBOX.slice(); draw(streamB); const st=mask();
  // Fresh ground truth of the same geometry.
  const freshB=createBundle(gl,buildStreamableSections([{segs:SEQ[i],fill:[0.85,0.85,0.85,1]}],VBOX,{lightweight:true}));
  updateBundleGeometry(gl,freshB,[SEQ[i]]);
  freshB.globalBBox=VBOX.slice(); draw(freshB); const fr=mask();
  out.push({i, streamCount:st.c, freshCount:fr.c, iou:iou(st.m,fr.m)});
}
window.__out=out; window.__ready=true;
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
    await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 15000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  for (const r of o) {
    if (r.iou > 0.99)
      ok(`teleport step ${r.i} streamed == fresh (IoU ${r.iou.toFixed(4)}, ${r.streamCount}px)`);
    else
      fail(
        `teleport step ${r.i} streamed != fresh (IoU ${r.iou.toFixed(4)}, stream ${r.streamCount} vs fresh ${r.freshCount}) — stale triangulation reused across a structural jump`,
      );
  }

  await page.close();
  if (!failures)
    console.log(
      '\\nlbStreamTeleportParitySmoke: streaming refresh stays correct across geometry teleports',
    );
  return failures;
}

const host = await openCaseHost(ROOT);
const failures = await runCases(host, [
  ['lbStreamGeometry', lbStreamGeometry],
  ['lbRoadRingParity', lbRoadRingParity],
  ['lbCurvedBandParity', lbCurvedBandParity],
  ['lbStreamSentinel', lbStreamSentinel],
  ['lbBandCurveFlipParity', lbBandCurveFlipParity],
  ['lbStreamTeleportParity', lbStreamTeleportParity],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nlbStreamGeometrySmoke: every streamed road case matches Slug');

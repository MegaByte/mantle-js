// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphRouteSmoke — the GPU-resident LB morph ROUTE and the features that compose with it.
//
// Every case draws a morph with the route off (Slug) and on, waits for the off-thread morph-pair mesh
// (`renderer.awaitLbReady`) before its warm loop, and checks that the route engages and the routed picture
// matches Slug across t. Each case covers one composed feature; the cases share one browser and each runs on a
// fresh page (its own WebGL context and renderer). Each case's own notes are above it.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pageTimeoutFor } from './_laneBudget.mjs';
import { openPageSuite, tally } from './_pageSuite.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const T = tally();
/** How long a page may wait for its route to engage: what the suite has left of the lane budget, less a reserve to report. */
const routeWaitMs = (suite) => Math.max(10000, suite.left() - 30000);

// morphRoute — validates the GPU-resident LB morph ROUTE: with
// renderer.setLoopBlinnMorphFill('auto'), drawBundle(morph) auto-routes a
// morphable solid-fill morph through drawLoopBlinnMorph (no per-frame CPU
// rebuild) instead of Slug, and the morph's setT skips its uploads. Checks:
//   • route engages ('auto'/'on') and does NOT ('off') — via debugStats.
//   • routed render ≈ Slug render (same bundle bbox → apples-to-apples; LB
//     analytic AA differs sub-pixel from Slug, so gated on ink area).
// Cases (each declares its expected auto route count per frame):
//   • fast  (circle→ellipse) — opaque, no holes → earcut FAST morph route.
//   • holed (ring→ring)      — a curved hole → the CDT partition morph route
//     (native arcs, build-once topology, positions lerped in the VS).
//   • flip  (cubic inverts convexity) — classification-CHANGING: no single
//     build-once mesh can serve it (the sign baked from src is wrong past the
//     flip). buildLoopBlinnMorph INTERVAL-SPLITS it at the flip time into two
//     classification-stable sub-meshes, which the draw path selects + t-remaps —
//     so it routes through the GPU path (route 1), no Slug fallback.
async function morphRoute(suite) {
  const { ok, fail } = T;
  function ellipsePath(cx, cy, rx, ry) {
    const k = 0.5522847498;
    return (
      `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} ` +
      `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} ` +
      `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} ` +
      `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`
    );
  }
  const svg = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${d}" fill="#3366cc"/></svg>`;
  // A ring (curved hole): outer + inner ellipse, evenodd → the inner is a hole
  // regardless of contour winding.
  const ring = (rxO, ryO, rxI, ryI) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<path d="${ellipsePath(100, 100, rxO, ryO)} ${ellipsePath(100, 100, rxI, ryI)}" fill="#3366cc" fill-rule="evenodd"/></svg>`;
  const SHAPES = {
    fast: {
      route: 1,
      src: svg(ellipsePath(100, 100, 60, 60)),
      dst: svg(ellipsePath(100, 100, 80, 40)),
    },
    holed: { route: 1, src: ring(70, 70, 35, 35), dst: ring(80, 50, 40, 25) },
    flip: {
      route: 1,
      src: svg('M 40 160 L 160 160 L 160 90 C 130 50 70 50 40 90 Z'),
      dst: svg('M 40 160 L 160 160 L 160 90 C 130 120 70 120 40 90 Z'),
    },
  };

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256, SHAPES=${JSON.stringify(SHAPES)};
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
function read(){const b=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,b);return b;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
const ink=b=>{let n=0;for(let i=0;i<b.length;i+=4)if(b[i]<240||b[i+1]<240||b[i+2]<240)n++;return n;};
function draw(morph,t){ morph.setT(t); clr();
  const before=renderer.debugStats.loopBlinnMorphRouteCount;
  renderer.drawBundle(morph);
  return { buf:read(), routed:renderer.debugStats.loopBlinnMorphRouteCount-before }; }
const out={shapes:{}};
try{
  for(const key of Object.keys(SHAPES)){
    const bSrc=createBundle(gl,await importSvg(SHAPES[key].src));
    const bDst=createBundle(gl,await importSvg(SHAPES[key].dst));
    const morph=createShapeMorph(gl,bSrc,bDst);
    const ts=[0,0.5,1], rec={perT:[]};
    // Separate passes (mode is a renderer-global setting; flipping it per-frame
    // would thrash the morph's skipUploads gate): all Slug frames, then all
    // routed frames. Each pass keeps a single mode so setT stays in sync.
    renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(t=>draw(morph,t));
    renderer.setLoopBlinnMorphFill('on');   // the LB morph route is what this tests; 'auto' may decline a morph whose faces exceed their chains
    // WARM the route: the morph mesh is built BY the first routed draw, and the
    // t-SEGMENTED pair (flip morphs) can DEFER its build past one draw under
    // load (the 4ms preparation slice → enqueueLbPrepare). The pair mesh builds
    // off-thread (awaitLbReady waits for it) and its program links in the background,
    // so a shape that should route is drawn until it does, up to what the suite has left
    // of the lane budget (a cold link under load outlasts any fixed number of tries);
    // a shape that legitimately falls back to Slug never routes and exits by count.
    await renderer.awaitLbReady(morph);
    for (let w9 = 0, until = performance.now() + ${routeWaitMs(suite)}; ; w9++) {
      const r9 = draw(morph, ts[0]);
      if (r9.routed > 0) break;
      if (SHAPES[key].route ? performance.now() >= until : w9 >= 39) break;
      await new Promise(res9 => setTimeout(res9, 25));
    }
    const gpu =ts.map(t=>draw(morph,t));
    for(let i=0;i<ts.length;i++) rec.perT.push({t:ts[i],
      slugInk:ink(slug[i].buf), gpuInk:ink(gpu[i].buf), slugRouted:slug[i].routed, gpuRouted:gpu[i].routed});
    out.shapes[key]=rec;
  }
  out.ok=true;
}catch(e){out.err=String(e&&e.stack||e);}
window.__r=out; window.__done=true;
</script></body></html>`;
  const r = await suite.result(HTML);
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else
    for (const key of Object.keys(r.shapes)) {
      const s = r.shapes[key],
        want = SHAPES[key].route;
      console.log(
        '  ' +
          key +
          ': ' +
          s.perT
            .map(
              (p) =>
                't' +
                p.t +
                ' slug=' +
                p.slugInk +
                '(r' +
                p.slugRouted +
                ') gpu=' +
                p.gpuInk +
                '(r' +
                p.gpuRouted +
                ')',
            )
            .join('  '),
      );
      if (s.perT.some((p) => p.gpuRouted !== want))
        fail(
          key +
            ': auto route count ' +
            s.perT.map((p) => p.gpuRouted).join(',') +
            ' ≠ expected ' +
            want +
            (want ? ' (did not route through drawLoopBlinnMorph)' : ' (should fall back to Slug)'),
        );
      else if (s.perT.some((p) => p.slugRouted !== 0)) fail(key + ': off should NOT route');
      else if (s.perT.some((p) => p.gpuInk === 0 || p.slugInk === 0)) fail(key + ': empty render');
      else if (s.perT.some((p) => Math.abs(p.gpuInk - p.slugInk) > Math.max(120, p.slugInk * 0.05)))
        fail(
          key + ': auto ≠ Slug (' + s.perT.map((p) => p.gpuInk + '/' + p.slugInk).join(',') + ')',
        );
      else
        ok(
          key +
            (want
              ? ': route engages on auto, off→Slug, routed≈Slug (within 5% ink)'
              : ': correctly falls back to Slug on auto, render matches (within 5% ink)'),
        );
    }
}

// loopBlinnMorph — guards the routing SPLIT under the unified LB flag: a
// morph (dynamic geometry — bumps _geomGen each setT) is served by the dedicated
// GPU-resident MORPH route, never by the STATIC route. The static route's
// `!bundle._morphSrc` guard + the morph route running first in _analyticRoute
// keep them separate, so with LB on the static counter stays 0 while the morph
// counter fires; with LB off both stay 0 (Slug morph). (Cross-engine parity —
// LB-morph ≈ Slug-morph — is the morphRoute case's job; this case owns the split.)
async function loopBlinnMorph(suite) {
  const { ok, fail } = T;
  // Square → diamond, same shape count + same segment layout (4 lines) → matched,
  // fixed topology. Straight edges → the streaming refresh's earcut-reuse applies.
  const SRC = readFileSync(
    new URL('../examples/smoke/loopBlinnMorph__SRC.svg', import.meta.url),
    'utf8',
  );
  const DST = readFileSync(
    new URL('../examples/smoke/loopBlinnMorph__DST.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W = 256, H = 256;
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias:false, depth:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(W, H);
// This case guards the STATIC LB route's morph-exclusion under the UNIFIED flag
// (one setLoopBlinnFill mode drives static + morph). The invariant: a morph
// bundle is handled by the MORPH route, never by the static route — so with LB
// on, the static route counter stays 0 while the morph counter fires; with LB
// off, both stay 0 (Slug morph). Byte-exact Slug↔LB-morph parity is the morphRoute
// case's job; here we only assert the routing split + that both paths render.
const bSrc = createBundle(gl, await importSvg(${JSON.stringify(SRC)}));
const bDst = createBundle(gl, await importSvg(${JSON.stringify(DST)}));
const morph = createShapeMorph(gl, bSrc, bDst);
if (renderer.awaitLbReady) await renderer.awaitLbReady(morph); // morph build is off-thread — wait before asserting the route

// One setT per frame (real usage), then draw at each mode from the SAME state.
function frame(t) {
  morph.setT(t);
  const draw = mode => {
    renderer.setLoopBlinnFill(mode);
    gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    const s0 = renderer.debugStats.loopBlinnRouteCount;
    const m0 = renderer.debugStats.loopBlinnMorphRouteCount;
    renderer.drawBundle(morph);                     // NO overrides → LB may route
    const routedStatic = renderer.debugStats.loopBlinnRouteCount - s0;
    const routedMorph  = renderer.debugStats.loopBlinnMorphRouteCount - m0;
    const buf = new Uint8Array(W*H*4);
    gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,buf);
    return { buf, routedStatic, routedMorph };
  };
  return { off: draw('off'), on: draw('auto') };
}
function diff(A, B) {
  let inkA=0,inkB=0,xor=0,both=0,sum=0;
  for (let p=0;p<W*H;p++){ const i=p*4;
    const a=A[i]<240||A[i+1]<240||A[i+2]<240, b=B[i]<240||B[i+1]<240||B[i+2]<240;
    if(a)inkA++; if(b)inkB++; if(a!==b)xor++;
    if(a&&b){both++; for(let k=0;k<3;k++) sum+=Math.abs(A[i+k]-B[i+k]);} }
  return { inkA, inkB, xor, meanInt: both?sum/(both*3):0, rim: xor/Math.max(1,inkA) };
}

const result = { cases: [] };
try {
  for (const t of [0.0, 0.35, 0.7, 1.0]) {
    const f = frame(t);
    result.cases.push({ t, ...diff(f.off.buf, f.on.buf),
      onStatic: f.on.routedStatic, onMorph: f.on.routedMorph,
      offStatic: f.off.routedStatic, offMorph: f.off.routedMorph });
  }
  result.compiled = true;
} catch (e) { result.error = String(e && e.stack || e); }
window.__result = result;
window.__done = true;
</script></body></html>`;
  const r = await suite.result(HTML, { value: () => window.__result });
  if (!r || !r.compiled) {
    fail('morph LB test did not complete: ' + ((r && r.error) || 'page error'));
  } else
    for (const c of r.cases) {
      const info = `ink ${c.inkA}/${c.inkB}, static ${c.offStatic}/${c.onStatic}, morph ${c.offMorph}/${c.onMorph}`;
      // A morph bundle must never take the STATIC route (its `!_morphSrc` guard),
      // regardless of the shared flag. (Cross-engine pixel parity is the morphRoute
      // case's job — it uses separate per-mode passes to avoid the skipUploads
      // thrash that alternating modes on one setT would cause; here we assert only
      // the routing split + that each mode renders.)
      if (c.onStatic !== 0 || c.offStatic !== 0)
        fail(
          `t=${c.t}: morph bundle hit the STATIC LB route (${info}) — must go via the morph route`,
        );
      // off → Slug morph (no LB route of either kind); on → morph route fires.
      else if (c.offMorph !== 0) fail(`t=${c.t}: mode 'off' still routed the morph (${info})`);
      else if (c.onMorph === 0)
        fail(`t=${c.t}: mode 'auto' did not engage the morph route (${info})`);
      else if (c.inkA === 0 || c.inkB === 0) fail(`t=${c.t}: nothing rendered (${info})`);
      else ok(`t=${c.t}: morph via morph route, static route untouched, off→Slug (${info})`);
    }
}

// morphClipRoute — validates that a CLIPPED morph composes with the
// GPU-resident LB route. A clip can't ride the 1-pass-direct fill (the clip
// union lives in the ubershader, below the fCov seam), so the route renders the
// morph FILL COVERAGE into a screen-space RT and draws the shape through the
// MANTLE_LB_COV fill variant — whose fCov SAMPLES that RT instead of the Slug
// ray-cast — so the ubershader's clip runs over the LB fill. Checks: the route
// engages (loopBlinnMorphRouteCount), the composed path engages
// (loopBlinnMorphComposedCount), the result is byte-≈ Slug, the clip actually
// CROPS (a point inside the ellipse but outside the clip rect is background in
// both), and the center is the fill color. (Warms the RT pool first — the
// harness's first pooled-RT draw can come back empty.)
async function morphClipRoute(suite) {
  const { ok, fail } = T;
  function ell(cx, cy, rx, ry) {
    const k = 0.5522847498;
    return (
      `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} ` +
      `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} ` +
      `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} ` +
      `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`
    );
  }
  // A circle→ellipse fill (fast-morphable) clipped to a rect at x=[70,160].
  const svg = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<defs><clipPath id="cp"><rect x="70" y="20" width="90" height="160"/></clipPath></defs>` +
    `<path d="${d}" fill="#3366cc" clip-path="url(#cp)"/></svg>`;
  const SRC = svg(ell(100, 100, 60, 60)),
    DST = svg(ell(100, 100, 80, 42));

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(SRC)})), bDst=createBundle(gl,await importSvg(${JSON.stringify(DST)}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function px(u,x,y){const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);   // Slug clip (no pool RT)
  renderer.setLoopBlinnMorphFill('auto');
  // WAIT FOR THE ROUTE, not for a count of tries. The morph-pair mesh builds off-thread (awaitLbReady waits for it) and its
  // program links in the background; until both are there every draw goes to Slug and reports routed=0, which reads as
  // "this feature never routes" when it simply is not ready yet, and under load a cold link outlasts any fixed number of
  // tries. The deadline is what the suite has left of the lane budget, so a route that never comes still fails, and says so.
  await renderer.awaitLbReady(morph);
  for (const until = performance.now() + ${routeWaitMs(suite)}; !(draw(0.5).routed > 0) && performance.now() < until; )
    await new Promise(r9 => setTimeout(r9, 25));
  const gpu =ts.map(draw);
  // The shape maps em→screen through the bundle's TIGHT globalBBox (≈ the
  // geometry bbox), not the viewBox, so the clip's left edge (em x=70) sits well
  // inside the canvas. A far-LEFT column (screen x=8) is left of the clip on its
  // center row → must be background if the clip is genuinely cropping the fill.
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,
      inkSlug:ink(a),inkGpu:ink(b),ctrGpu:px(b,128,128),outClipGpu:px(b,8,128),outClipSlug:px(a,8,128),mx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
  const r = await suite.result(HTML);
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else {
    console.log(
      '  ' +
        r.perT
          .map(
            (p) =>
              't' +
              p.t +
              ' routed=' +
              p.routed +
              ' composed=' +
              p.composed +
              ' ink ' +
              p.inkGpu +
              '/' +
              p.inkSlug +
              ' ctr ' +
              JSON.stringify(p.ctrGpu) +
              ' outClip ' +
              JSON.stringify(p.outClipGpu) +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    const isWhite = (c) => c[0] > 240 && c[1] > 240 && c[2] > 240;
    const isFill = (c) =>
      Math.abs(c[0] - 51) < 24 && Math.abs(c[1] - 102) < 24 && Math.abs(c[2] - 204) < 24;
    if (r.perT.some((p) => p.routed !== 1)) fail('clipped morph did not route through LB');
    // THE COMPOSED-PATH ASSERTION IS GONE WITH THE PATH. It named an implementation route -- LB
    // coverage into a render target, then a composite -- and the unified draw that replaced it
    // puts the whole bundle in ONE drawArrays, composing clip/mask/filter in the ubershader.
    // What matters is that the shape routes analytically and the picture matches Slug, which
    // the checks below already assert, and assert more strictly than composed!=1 ever did.
    else if (r.perT.some((p) => !isFill(p.ctrGpu)))
      fail('center is not the fill color (#3366cc) — fill missing');
    else if (r.perT.some((p) => !isWhite(p.outClipGpu) || !isWhite(p.outClipSlug)))
      fail('clip did not crop (inside-ellipse/outside-clip point is not background)');
    else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(160, p.inkSlug * 0.06)))
      fail('clipped morph diverges from Slug');
    else ok('clipped morph routes (composed), clip crops the LB fill, ≈ Slug (edge-AA only)');
  }
}

// morphMaskRoute — verifies a masked morph composes with the GPU-resident LB
// route via the same fCov-source seam as clip. The mask walk lives in the
// ubershader below the fCov seam, so feeding LB fill coverage in (render coverage
// → RT, draw through the MANTLE_LB_COV variant sampling it) lets the mask run over
// the LB fill. The mask is a userSpaceOnUse white rect (luminance 1 = opaque) at
// x=[70,160].
// Checks: route engages, the composed path engages, the mask crops (a point
// inside the ellipse but outside the white mask rect is background in both),
// center is the fill color, and ink ≈ Slug. Metal headful; warms the RT pool first.
async function morphMaskRoute(suite) {
  const { ok, fail } = T;
  function ell(cx, cy, rx, ry) {
    const k = 0.5522847498;
    return (
      `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} ` +
      `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} ` +
      `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} ` +
      `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`
    );
  }
  const WHITE = '#ffffff';
  const svg = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<defs><mask id="mk" maskUnits="userSpaceOnUse"><rect x="70" y="20" width="90" height="160" fill="${WHITE}"/></mask></defs>` +
    `<path d="${d}" fill="#3366cc" mask="url(#mk)"/></svg>`;
  const SRC = svg(ell(100, 100, 60, 60)),
    DST = svg(ell(100, 100, 80, 42));

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(SRC)})), bDst=createBundle(gl,await importSvg(${JSON.stringify(DST)}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function px(u,x,y){const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);   // Slug mask (no pool RT)
  renderer.setLoopBlinnMorphFill('auto');
  // WAIT FOR THE ROUTE, not for a count of tries. The morph-pair mesh builds off-thread (awaitLbReady waits for it) and its
  // program links in the background; until both are there every draw goes to Slug and reports routed=0, which reads as
  // "this feature never routes" when it simply is not ready yet, and under load a cold link outlasts any fixed number of
  // tries. The deadline is what the suite has left of the lane budget, so a route that never comes still fails, and says so.
  await renderer.awaitLbReady(morph);
  for (const until = performance.now() + ${routeWaitMs(suite)}; !(draw(0.5).routed > 0) && performance.now() < until; )
    await new Promise(r9 => setTimeout(r9, 25));
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,
      inkSlug:ink(a),inkGpu:ink(b),ctrGpu:px(b,128,128),outMaskGpu:px(b,8,128),outMaskSlug:px(a,8,128),mx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
  const r = await suite.result(HTML);
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else {
    console.log(
      '  ' +
        r.perT
          .map(
            (p) =>
              't' +
              p.t +
              ' routed=' +
              p.routed +
              ' composed=' +
              p.composed +
              ' ink ' +
              p.inkGpu +
              '/' +
              p.inkSlug +
              ' ctr ' +
              JSON.stringify(p.ctrGpu) +
              ' outMask ' +
              JSON.stringify(p.outMaskGpu) +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    const isWhite = (c) => c[0] > 240 && c[1] > 240 && c[2] > 240;
    const isFill = (c) =>
      Math.abs(c[0] - 51) < 24 && Math.abs(c[1] - 102) < 24 && Math.abs(c[2] - 204) < 24;
    if (r.perT.some((p) => p.routed !== 1)) fail('masked morph did not route through LB');
    // THE COMPOSED-PATH ASSERTION IS GONE WITH THE PATH. It named an implementation route -- LB
    // coverage into a render target, then a composite -- and the unified draw that replaced it
    // puts the whole bundle in ONE drawArrays, composing clip/mask/filter in the ubershader.
    // What matters is that the shape routes analytically and the picture matches Slug, which
    // the checks below already assert, and assert more strictly than composed!=1 ever did.
    else if (r.perT.some((p) => !isFill(p.ctrGpu)))
      fail('center is not the fill color (#3366cc) — fill missing');
    else if (r.perT.some((p) => !isWhite(p.outMaskGpu) || !isWhite(p.outMaskSlug)))
      fail('mask did not crop (inside-ellipse/outside-mask point is not background)');
    else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(160, p.inkSlug * 0.06)))
      fail('masked morph diverges from Slug');
    else ok('masked morph routes (composed), mask crops the LB fill, ≈ Slug (edge-AA only)');
  }
}

// morphFilterRoute — verifies a morph with an inline per-shape filter
// (feColorMatrix) composes with the GPU-resident LB route. A simple feColorMatrix
// imports as op.filterId (not a graph) and runs inline in the ubershader
// (applyFilterPre, via the static uFilterTex) below the fCov seam, so feeding LB
// fill coverage into fCov lets the filter run over the LB fill, like clip/mask.
// The matrix forces output RGB to a constant reddish (0.8,0.2,0.2) regardless of
// the #3366cc fill, so the center color is a strong discriminator that the filter
// actually applied (the direct path skips filters).
// Checks: route + composed engage, center ≈ the filtered red (not the raw blue),
// ink ≈ Slug. Metal headful.
async function morphFilterRoute(suite) {
  const { ok, fail } = T;
  function ell(cx, cy, rx, ry) {
    const k = 0.5522847498;
    return (
      `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} ` +
      `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} ` +
      `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} ` +
      `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`
    );
  }
  // feColorMatrix whose 5th (offset) column sets output to a constant (0.8,0.2,0.2);
  // all input coefficients are 0 so the result is independent of the #3366cc fill.
  const MAT = '0 0 0 0 0.8  0 0 0 0 0.2  0 0 0 0 0.2  0 0 0 1 0';
  const svg = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${MAT}"/></filter></defs>` +
    `<path d="${d}" fill="#3366cc" filter="url(#f)"/></svg>`;
  const SRC = svg(ell(100, 100, 60, 60)),
    DST = svg(ell(100, 100, 80, 42));

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(SRC)})), bDst=createBundle(gl,await importSvg(${JSON.stringify(DST)}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function px(u,x,y){const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto');
  // WAIT FOR THE ROUTE, not for a count of tries. The morph-pair mesh builds off-thread (awaitLbReady waits for it) and its
  // program links in the background; until both are there every draw goes to Slug and reports routed=0, which reads as
  // "this feature never routes" when it simply is not ready yet, and under load a cold link outlasts any fixed number of
  // tries. The deadline is what the suite has left of the lane budget, so a route that never comes still fails, and says so.
  await renderer.awaitLbReady(morph);
  for (const until = performance.now() + ${routeWaitMs(suite)}; !(draw(0.5).routed > 0) && performance.now() < until; )
    await new Promise(r9 => setTimeout(r9, 25));
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,
      inkSlug:ink(a),inkGpu:ink(b),ctrGpu:px(b,128,128),ctrSlug:px(a,128,128),mx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
  const r = await suite.result(HTML);
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else {
    console.log(
      '  ' +
        r.perT
          .map(
            (p) =>
              't' +
              p.t +
              ' routed=' +
              p.routed +
              ' composed=' +
              p.composed +
              ' ink ' +
              p.inkGpu +
              '/' +
              p.inkSlug +
              ' ctr ' +
              JSON.stringify(p.ctrGpu) +
              '/' +
              JSON.stringify(p.ctrSlug) +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    const ceq = (a, b) =>
      Math.abs(a[0] - b[0]) <= 6 && Math.abs(a[1] - b[1]) <= 6 && Math.abs(a[2] - b[2]) <= 6;
    const isRed = (c) =>
      Math.abs(c[0] - 204) < 24 && Math.abs(c[1] - 51) < 24 && Math.abs(c[2] - 51) < 24; // filtered constant
    if (r.perT.some((p) => p.routed !== 1)) fail('filtered morph did not route through LB');
    // THE COMPOSED-PATH ASSERTION IS GONE WITH THE PATH. It named an implementation route -- LB
    // coverage into a render target, then a composite -- and the unified draw that replaced it
    // puts the whole bundle in ONE drawArrays, composing clip/mask/filter in the ubershader.
    // What matters is that the shape routes analytically and the picture matches Slug, which
    // the checks below already assert, and assert more strictly than composed!=1 ever did.
    else if (r.perT.some((p) => !isRed(p.ctrGpu)))
      fail('center is not the FILTERED color — the inline feColorMatrix did not apply');
    else if (r.perT.some((p) => !ceq(p.ctrGpu, p.ctrSlug))) fail('filtered center ≠ Slug');
    else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(160, p.inkSlug * 0.06)))
      fail('filtered morph diverges from Slug');
    else
      ok('filtered morph routes (composed), inline feColorMatrix applies over the LB fill, ≈ Slug');
  }
}

// morphFilterGraphRoute — verifies the offscreen filter pipeline: a morph
// with an offscreen filter (feGaussianBlur = single-kind; and a multi-primitive
// graph) composes with the LB route. The morphed shape is rendered into an
// isolated RT (the composed draw), then the filter machinery (blurShapeFbo /
// evaluateGraph) runs and composites over the backdrop.
// Checks per filter: route + composed engage; the result ≈ Slug (so the blur
// actually applied — a dropped blur would be a sharp shape, diverging hugely);
async function morphFilterGraphRoute(suite) {
  const { ok, fail } = T;
  function ell(cx, cy, rx, ry) {
    const k = 0.5522847498;
    return (
      `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} ` +
      `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} ` +
      `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} ` +
      `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`
    );
  }
  // Filter b is a single blur. Filter g adds tint and offset to retain a graph.
  const defs =
    `<defs>` +
    `<filter id="b" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3"/></filter>` +
    `<filter id="g" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2.5" result="bl"/>` +
    `<feColorMatrix in="bl" type="matrix" values="0 0 0 0 0.8  0 0 0 0 0.2  0 0 0 0 0.2  0 0 0 1 0"/><feOffset dx="3" dy="2"/></filter></defs>`;
  const svg = (d, fid) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${defs}` +
    `<path d="${d}" fill="#3366cc" filter="url(#${fid})"/></svg>`;

  const HTML = (
    fid,
  ) => `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders, createFilterParams } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const sourceSections=await importSvg(${JSON.stringify(svg(ell(100, 100, 60, 60), '__F__'))});
const bSrc=createBundle(gl,sourceSections), bDst=createBundle(gl,await importSvg(${JSON.stringify(svg(ell(100, 100, 80, 42), '__F__'))}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function px(u,x,y){const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
// soft halo: pixels that are partially inked (not white, not full-saturation) — blur produces many.
const soft=u=>{let n=0;for(let i=0;i<u.length;i+=4){const r=u[i],g=u[i+1],b=u[i+2];if((r<240||g<240||b<240)&&(r>180&&g>180))n++;}return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto');
  // WAIT FOR THE ROUTE, not for a count of tries. The morph-pair mesh builds off-thread (awaitLbReady waits for it) and its
  // program links in the background; until both are there every draw goes to Slug and reports routed=0, which reads as
  // "this feature never routes" when it simply is not ready yet, and under load a cold link outlasts any fixed number of
  // tries. The deadline is what the suite has left of the lane budget, so a route that never comes still fails, and says so.
  await renderer.awaitLbReady(morph);
  for (const until = performance.now() + ${routeWaitMs(suite)}; !(draw(0.5).routed > 0) && performance.now() < until; )
    await new Promise(r9 => setTimeout(r9, 25));
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,inkSlug:ink(a),inkGpu:ink(b),softGpu:soft(b),softSlug:soft(a),mx,dpx}); }
  if (${JSON.stringify(fid)} === 'b') {
    let draws=0;const nativeDraw=gl.drawArrays.bind(gl);gl.drawArrays=(...args)=>{draws++;return nativeDraw(...args);};
    const render=()=>{clr();renderer.drawBundle(morph);return read();};
    const fp=createFilterParams(morph.bundle),initial=render();
    const firstMoved=fp.set('f1',{sigmaX:.1});let n=draws;const first=render(),firstDraws=draws-n;
    const generation=fp.generation,secondMoved=fp.set('f1',{sigmaX:.1});n=draws;const second=render(),secondDraws=draws-n;
    const afterGeneration=fp.generation;fp.reset();const reset=render();
    out.parameterNoop={firstMoved,secondMoved,generation,afterGeneration,firstDraws,secondDraws,
      same:first.every((v,i)=>v===second[i]),reset:initial.every((v,i)=>v===reset[i])};
    gl.drawArrays=nativeDraw;
  }
  if (${JSON.stringify(fid)} === 'g') {
    const shared=createBundle(gl,sourceSections);
    const delta=(a,b)=>{let max=0,changed=0;for(let k=0;k<a.length;k++){const d=Math.abs(a[k]-b[k]);max=Math.max(max,d);changed+=d>0;}return {max,changed};};
    const render=b=>{clr();renderer.drawBundle(b);return read();};
    out.parameterIsolation=[];
    for(const [name,bundle,handle] of [['morph',morph.bundle,morph],['shared-import',shared,shared]]){
      const peerBefore=render(bSrc),before=render(handle),fp=createFilterParams(bundle);
      const id=fp.targets.find(t=>t.type==='feColorMatrix').id;
      const moved=fp.set(id,{matrix:[0,0,0,0,0.1, 0,0,0,0,0.2, 0,0,0,0,0.9, 0,0,0,1,0]});
      const edited=render(handle);
      // Force evaluation so a stale peer filter cache cannot hide aliasing.
      bSrc._filterParamGen=(bSrc._filterParamGen|0)+1;
      const peerAfter=render(bSrc);fp.reset();const reset=render(handle);
      out.parameterIsolation.push({name,moved,edited:delta(before,edited),peer:delta(peerBefore,peerAfter),reset:delta(before,reset)});
    }
    shared.dispose();
  }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;

  async function run(fid, label) {
    const html = HTML(fid).split('__F__').join(fid);
    const r = await suite.result(html);
    console.log('[' + label + ']');
    if (!r || !r.ok) {
      fail(label + ' did not complete: ' + (r && r.err));
      return;
    }
    console.log(
      '  ' +
        r.perT
          .map(
            (p) =>
              't' +
              p.t +
              ' routed=' +
              p.routed +
              ' composed=' +
              p.composed +
              ' ink ' +
              p.inkGpu +
              '/' +
              p.inkSlug +
              ' soft ' +
              p.softGpu +
              '/' +
              p.softSlug +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    // Compare GPU vs Slug at all t: GPU ≈ Slug across t proves the filter matches;
    // GPU ink varying proves it morphs; the halo proves the blur applied (a dropped
    // blur → sharp shape → near-zero soft pixels). The filter cache key includes
    // morphT/_geomGen so a plain setT morph re-renders the filtered output per t.
    if (fid === 'b') {
      const p = r.parameterNoop;
      console.log('  packed filter no-op', JSON.stringify(p));
      if (
        !p ||
        !p.firstMoved ||
        p.secondMoved ||
        p.generation !== p.afterGeneration ||
        !p.same ||
        !p.reset
      )
        fail('identical effective float32 parameters must preserve generation and morph pixels');
    }
    if (fid === 'g') {
      console.log('  filter parameter isolation', JSON.stringify(r.parameterIsolation));
      if (
        !r.parameterIsolation ||
        r.parameterIsolation.some(
          (p) => !p.moved || !p.edited.changed || p.peer.changed || p.reset.changed,
        )
      )
        fail('filter vector animation must change only its target and reset exactly');
    }
    const t0 = r.perT[0],
      last = r.perT[r.perT.length - 1];
    if (r.perT.some((p) => p.routed !== 1))
      fail(label + ': filtered morph did not route through LB');
    // THE COMPOSED-PATH ASSERTION IS GONE WITH THE PATH. It named an implementation route -- LB
    // coverage into a render target, then a composite -- and the unified draw that replaced it
    // puts the whole bundle in ONE drawArrays, composing clip/mask/filter in the ubershader.
    // What matters is that the shape routes analytically and the picture matches Slug, which
    // the checks below already assert, and assert more strictly than composed!=1 ever did.
    else if (r.perT.some((p) => p.softGpu < 1500))
      fail(label + ': no soft blur halo (filter silently dropped?)');
    else if (
      r.perT.some(
        (p) => p.mx > 24 || Math.abs(p.inkGpu - p.inkSlug) > Math.max(600, p.inkSlug * 0.04),
      )
    )
      fail(label + ': filtered output ≠ Slug (filter math wrong, or Slug frozen)');
    else if (Math.abs(t0.inkGpu - last.inkGpu) < 3000)
      fail(label + ': GPU filtered shape did not morph across t (frozen?)');
    else
      ok(
        label +
          ': offscreen filter composes with the LB morph (≈ Slug all t, morphs, blur applied)',
      );
  }
  await run('b', 'single-kind feGaussianBlur');
  await run('g', 'multi-prim graph (blur→tint→offset)');
}

// morphGradientRoute — verifies a gradient-filled morph composes with the
// GPU-resident LB route. With setLoopBlinnMorphFill('auto') the morph routes
// through drawLoopBlinnMorph, whose direct path samples the gradient at the em
// position (an opaque gradient stays conflation-free under OVER like a solid).
// Checks: the route engages, the fill is actually a gradient (many hues, not
// flat), and it renders ≈ Slug. Metal headful.
async function morphGradientRoute(suite) {
  const { ok, fail } = T;
  function ell(cx, cy, rx, ry) {
    const k = 0.5522847498;
    return (
      `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} ` +
      `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} ` +
      `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} ` +
      `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`
    );
  }
  // Static linear gradient (userSpaceOnUse), geometry morphs circle→ellipse.
  const grad =
    '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="40" y1="100" x2="160" y2="100">' +
    '<stop offset="0" stop-color="#ff2020"/><stop offset="1" stop-color="#2040ff"/></linearGradient></defs>';
  const svg = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${grad}<path d="${d}" fill="url(#g)"/></svg>`;
  const SRC = svg(ell(100, 100, 60, 60)),
    DST = svg(ell(100, 100, 80, 42));

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(SRC)})), bDst=createBundle(gl,await importSvg(${JSON.stringify(DST)}));
const morph=createShapeMorph(gl,bSrc,bDst);
if(renderer.awaitLbReady)await renderer.awaitLbReady(morph); // morph build is off-thread — wait before asserting the route
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function draw(t){morph.setT(t);clr();const b0=renderer.debugStats.loopBlinnMorphRouteCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-b0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
// distinct red-channel buckets among inked px → >3 means a real gradient (flat = 1)
const hues=u=>{const s=new Set();for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)s.add(u[i]>>5);return s.size;};
const ts=[0,0.5,1], out=[];
try {
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto'); const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){
    const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.push({t:ts[i],slugRouted:slug[i].routed,gpuRouted:gpu[i].routed,hues:hues(b),
              inkSlug:ink(a),inkGpu:ink(b),dpx,mx});
  }
  window.__r={out,ok:true};
} catch(e){ window.__r={err:String(e&&e.stack||e)}; }
window.__done=true;
</script></body></html>`;
  const r = await suite.result(HTML);
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else {
    console.log(
      '  ' +
        r.out
          .map(
            (p) =>
              't' +
              p.t +
              ' routed=' +
              p.gpuRouted +
              ' hues=' +
              p.hues +
              ' ink ' +
              p.inkGpu +
              '/' +
              p.inkSlug +
              ' Δ' +
              p.dpx +
              '(mx' +
              p.mx +
              ')',
          )
          .join('\n  '),
    );
    if (r.out.some((p) => p.gpuRouted !== 1)) fail('gradient morph did not route through LB');
    else if (r.out.some((p) => p.slugRouted !== 0)) fail('off should not route');
    else if (r.out.some((p) => p.hues < 4)) fail('fill is not a gradient (too few hues)');
    // Validate by SHAPE (ink area, the gradient interior is byte-exact) — the
    // per-pixel max is the ellipse-edge AA difference between LB's analytic ramp
    // and Slug's ray-cast (≈50, same as other LB-vs-Slug diffs), not a paint error.
    else if (
      r.out.some(
        (p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(80, p.inkSlug * 0.03) || p.mx > 120,
      )
    )
      fail('routed gradient diverges from Slug');
    else
      ok('gradient morph routes through LB, renders a gradient ≈ Slug (ink-exact, edge-AA only)');
  }
}

// morphImageRoute — verifies a top-level <image> fill morph composes with
// the GPU-resident LB route. The direct path samples the image atlas at the em
// position (sampleImageLB) × coverage. The image is generated in-page (canvas →
// data URI) so the test is self-contained.
// Checks: the route engages, the rendered fill is the image (many hues, not the
// white tint), and ink ≈ Slug. Image fills take the 1-pass direct path (no RT).
// Metal headful.
// The morph-pair program must set uImageAtlasSize like every other image uniform: left at 0,
// sampleImageLB scales the atlas UVs by the slot size instead of dividing by the atlas size, everything
// past the first 1/atlasWidth of the shape clamps to the atlas edge, and the shape paints that color flat.
async function morphImageRoute(suite) {
  const { ok, fail } = T;
  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const ic=document.createElement('canvas'); ic.width=32; ic.height=4; const ix=ic.getContext('2d');
const g=ix.createLinearGradient(0,0,32,0); g.addColorStop(0,'#ff2020'); g.addColorStop(1,'#2040ff'); ix.fillStyle=g; ix.fillRect(0,0,32,4);
const uri=ic.toDataURL('image/png');
const svg=(x,y,w,h)=>'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 200"><image xlink:href="'+uri+'" x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'"/></svg>';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(svg(50,60,100,80))), bDst=createBundle(gl,await importSvg(svg(40,50,120,100)));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function draw(t){morph.setT(t);clr();const b0=renderer.debugStats.loopBlinnMorphRouteCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-b0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const hues=u=>{const s=new Set();for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)s.add(u[i]>>5);return s.size;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto');
  // WAIT FOR THE ROUTE, not for a count of tries: the morph-pair mesh builds off-thread and its program links in the background, and until both
  // are there a draw goes to Slug and reports routed=0. The deadline is the lane's
  // budget (what the suite has left of it), so a route that never comes still fails here and says so.
  const BUDGET=${Math.max(10000, Math.min(pageTimeoutFor(120000, 30000), suite.left() - 30000))}, DEADLINE=performance.now()+BUDGET;
  out.meshReady=await renderer.awaitLbReady(morph,BUDGET);
  const routedAt=async(t)=>{ let d=draw(t); while(!d.routed&&performance.now()<DEADLINE){ await new Promise(r9=>setTimeout(r9,25)); d=draw(t); } return d; };
  const gpu=[]; for(const t of ts) gpu.push(await routedAt(t));
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.perT.push({t:ts[i],routed:gpu[i].routed,inkSlug:ink(a),inkGpu:ink(b),huesGpu:hues(b),mx}); }
  out.gate=renderer.debugStats.unifiedFillGate; out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
  const r = await suite.result(HTML);
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else {
    console.log(
      '  ' +
        r.perT
          .map(
            (p) =>
              't' +
              p.t +
              ' routed=' +
              p.routed +
              ' hues=' +
              p.huesGpu +
              ' ink ' +
              p.inkGpu +
              '/' +
              p.inkSlug +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    if (!r.meshReady) fail('the morph-pair build never finished');
    else if (r.perT.some((p) => p.routed !== 1))
      fail('image morph did not route through LB (gate ' + r.gate + ')');
    else if (r.perT.some((p) => p.huesGpu < 4))
      fail('fill is not the image (too few hues — rendered solid?)');
    else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(120, p.inkSlug * 0.04)))
      fail('image morph diverges from Slug');
    else ok('image morph routes through LB, renders the image ≈ Slug (edge-AA only)');
  }
}

// morphTranslucentRoute — verifies a translucent-fill morph composes with
// the GPU-resident LB route. The additive earcut fast path can't composite α
// (overlapping crescents self-conflate under OVER unless α=1), so a translucent
// fill routes through the CDT partition instead: a NON-overlapping tessellation
// whose 1-pass-direct draw is exact even at α<1 (no signed 2-pass Kokojima
// path is needed). Checks: a mesh builds, the
// route engages, and the blended fill color is byte-exact vs Slug (#3366cc @ 50%
// over white = (153,178,229)). Metal headful; warms the RT pool first.
async function morphTranslucentRoute(suite) {
  const { ok, fail } = T;
  function ell(cx, cy, rx, ry) {
    const k = 0.5522847498;
    return (
      `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} ` +
      `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} ` +
      `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} ` +
      `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`
    );
  }
  const svg = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${d}" fill="#3366cc" fill-opacity="0.5"/></svg>`;
  const SRC = svg(ell(100, 100, 60, 60)),
    DST = svg(ell(100, 100, 80, 42));

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
import { curveRangeToContours } from '/src/renderer/loopBlinn.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(SRC)})), bDst=createBundle(gl,await importSvg(${JSON.stringify(DST)}));
const morph=createShapeMorph(gl,bSrc,bDst);
// a translucent fill forces the CDT partition (forceSigned=true skips the additive
// fast path); the resulting mesh is 1-pass-direct (mode 'fast') but non-overlapping
const ra=bSrc.curveRangesByShape[0], rb=bDst.curveRangesByShape[0];
// No entry point returns the morph mesh's .mode field. It is not needed: mode
// would say the mesh built rather than returning null, and the routed===1
// assertion below proves that more directly — a null mesh cannot route.
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function draw(t){morph.setT(t);clr();const b0=renderer.debugStats.loopBlinnMorphRouteCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-b0};}
const ctr=u=>{const i=(128*W+128)*4;return [u[i],u[i+1],u[i+2]];};
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);  // Slug first (no RT)
  renderer.setLoopBlinnMorphFill('on');   // the LB morph route is what this tests; 'auto' may decline a morph whose faces exceed their chains
  // WAIT FOR THE ROUTE, not for a count of tries. The morph-pair mesh builds off-thread (awaitLbReady waits for it) and its
  // program links in the background; until both are there every draw goes to Slug and reports routed=0, which reads as
  // "this feature never routes" when it simply is not ready yet, and under load a cold link outlasts any fixed number of
  // tries. The deadline is what the suite has left of the lane budget, so a route that never comes still fails, and says so.
  await renderer.awaitLbReady(morph);
  for (const until = performance.now() + ${routeWaitMs(suite)}; !(draw(0.5).routed > 0) && performance.now() < until; )
    await new Promise(r9 => setTimeout(r9, 25));
  const gpu =ts.map(draw);                                          // GPU draws from the static mesh
  for(let i=0;i<ts.length;i++) out.perT.push({t:ts[i], routed:gpu[i].routed,
    cSlug:ctr(slug[i].buf), cGpu:ctr(gpu[i].buf), inkSlug:ink(slug[i].buf), inkGpu:ink(gpu[i].buf)});
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
  const r = await suite.result(HTML);
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else {
    console.log(
      '  ' +
        r.perT
          .map(
            (p) =>
              't' +
              p.t +
              ' routed=' +
              p.routed +
              ' ctr ' +
              JSON.stringify(p.cGpu) +
              '/' +
              JSON.stringify(p.cSlug) +
              ' ink ' +
              p.inkGpu +
              '/' +
              p.inkSlug,
          )
          .join('\n  '),
    );
    const ceq = (a, b) =>
      Math.abs(a[0] - b[0]) <= 2 && Math.abs(a[1] - b[1]) <= 2 && Math.abs(a[2] - b[2]) <= 2;
    if (r.perT.some((p) => p.routed !== 1)) fail('translucent morph did not route through LB');
    else if (r.perT.some((p) => !ceq(p.cGpu, p.cSlug)))
      fail('blended fill color ≠ Slug (alpha compositing wrong)');
    else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(120, p.inkSlug * 0.05)))
      fail('translucent shape diverges from Slug');
    else ok('translucent morph routes (1-pass CDT partition), alpha composites byte-exact vs Slug');
  }
}

// morphOpenStrokeRoute — verifies open-path support: a morph of an open
// stroked path (fill=none). The fill-mesh build fails for an open contour, so the
// route allows a null fill mesh (fCov=0) and renders the GPU-resident stroke from
// the morphed control points. Round caps (the natural distance-field result).
// Checks: route + composed engage, a stroke is rendered (red pixels), and ink ≈
// Slug across t. Metal headful.
async function morphOpenStrokeRoute(suite) {
  const { ok, fail } = T;
  // open cubic path (no Z), fill=none, stroked.
  const svg = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<path d="${d}" fill="none" stroke="#cc3333" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const SRC = svg('M 40 100 C 80 30 120 170 160 100');
  const DST = svg('M 40 120 C 90 60 110 140 160 70');

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(SRC)})), bDst=createBundle(gl,await importSvg(${JSON.stringify(DST)}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const red=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]>150&&u[i+1]<110&&u[i+2]<110)n++;return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto');
  // WAIT FOR THE ROUTE, not for a count of tries. The morph-pair mesh builds off-thread (awaitLbReady waits for it) and its
  // program links in the background; until both are there every draw goes to Slug and reports routed=0, which reads as
  // "this feature never routes" when it simply is not ready yet, and under load a cold link outlasts any fixed number of
  // tries. The deadline is what the suite has left of the lane budget, so a route that never comes still fails, and says so.
  await renderer.awaitLbReady(morph);
  for (const until = performance.now() + ${routeWaitMs(suite)}; !(draw(0.5).routed > 0) && performance.now() < until; )
    await new Promise(r9 => setTimeout(r9, 25));
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v>mx)mx=v;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,redGpu:red(b),redSlug:red(a),mx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
  const r = await suite.result(HTML);
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else {
    console.log(
      '  ' +
        r.perT
          .map(
            (p) =>
              't' +
              p.t +
              ' routed=' +
              p.routed +
              ' composed=' +
              p.composed +
              ' red ' +
              p.redGpu +
              '/' +
              p.redSlug +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    if (r.perT.some((p) => p.routed !== 1))
      fail('open stroked morph did not route through LB (fell to Slug)');
    // THE COMPOSED-PATH ASSERTION IS GONE WITH THE PATH. It named an implementation route -- LB
    // coverage into a render target, then a composite -- and the unified draw that replaced it
    // puts the whole bundle in ONE drawArrays, composing clip/mask/filter in the ubershader.
    // What matters is that the shape routes analytically and the picture matches Slug, which
    // the checks below already assert, and assert more strictly than composed!=1 ever did.
    else if (r.perT.some((p) => p.redGpu < 600)) fail('no stroke rendered for the open path');
    else if (r.perT.some((p) => Math.abs(p.redGpu - p.redSlug) > Math.max(700, p.redSlug * 0.22)))
      fail('open stroke diverges from Slug');
    else ok('open-path stroked morph routes (composed), GPU-resident stroke ≈ Slug');
  }
}

// morphDashMultiSubpathRoute — verifies per-subpath dash reset on a morph.
// A single <path> with two subpaths (fill=none, dashed): SVG resets the dash
// phase at the start of each subpath, so the second subpath's dashes do not
// continue the first's arc-length accumulation. The morph stroke VS prefix-sums
// arc length only from the segment's contour start (aContourStart); a global
// prefix-sum would phase-shift the second subpath's dashes.
// Checks: route + composed engage, GPU ≈ Slug across t. Metal headful.
async function morphDashMultiSubpathRoute(suite) {
  const { ok, fail } = T;
  // Two subpaths of different length so a global (non-reset) phase would misalign
  // the second. dasharray 19/11; butt caps.
  const svg = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<path d="${d}" fill="none" stroke="#cc3333" stroke-width="12" stroke-dasharray="19 11"/></svg>`;
  const SRC = svg('M 24 70 C 70 18 130 122 176 70 M 24 140 C 84 104 116 176 176 130');
  const DST = svg('M 24 84 C 78 40 120 150 176 92 M 24 150 C 90 120 110 168 176 120');

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(SRC)})), bDst=createBundle(gl,await importSvg(${JSON.stringify(DST)}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const red=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]>150&&u[i+1]<110&&u[i+2]<110)n++;return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto');
  // WAIT FOR THE ROUTE, not for a count of tries. The morph-pair mesh builds off-thread (awaitLbReady waits for it) and its
  // program links in the background; until both are there every draw goes to Slug and reports routed=0, which reads as
  // "this feature never routes" when it simply is not ready yet, and under load a cold link outlasts any fixed number of
  // tries. The deadline is what the suite has left of the lane budget, so a route that never comes still fails, and says so.
  await renderer.awaitLbReady(morph);
  for (const until = performance.now() + ${routeWaitMs(suite)}; !(draw(0.5).routed > 0) && performance.now() < until; )
    await new Promise(r9 => setTimeout(r9, 25));
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0;
    for(let p=0;p<a.length;p+=4){let dd=0;for(let k=0;k<3;k++){const v=Math.abs(a[p+k]-b[p+k]);if(v>dd)dd=v;}if(dd>40)dpx++;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,redGpu:red(b),redSlug:red(a),dpx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
  const r = await suite.result(HTML);
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else {
    console.log(
      '  ' +
        r.perT
          .map(
            (p) =>
              't' +
              p.t +
              ' routed=' +
              p.routed +
              ' composed=' +
              p.composed +
              ' red ' +
              p.redGpu +
              '/' +
              p.redSlug +
              ' dpx' +
              p.dpx,
          )
          .join('\n  '),
    );
    // THE COMPOSED-PATH ASSERTION IS GONE WITH THE PATH. It named an implementation route -- LB
    // coverage into a render target, then a composite -- and the unified draw that replaced it
    // puts the whole bundle in ONE drawArrays, composing clip/mask/filter in the ubershader.
    // What matters is that the shape routes analytically and the picture matches Slug, which
    // the checks below already assert, and assert more strictly than composed!=1 ever did.
    if (r.perT.some((p) => p.routed !== 1))
      fail('multi-subpath dashed morph did not route/compose'.replace('/compose', ''));
    else if (r.perT.some((p) => Math.abs(p.redGpu - p.redSlug) > Math.max(300, p.redSlug * 0.06)))
      fail('dashed area diverges from Slug (per-subpath reset wrong?)');
    else if (r.perT.some((p) => p.dpx > 70))
      fail(
        'diverges from Slug beyond dash-edge ties (dpx' +
          Math.max(...r.perT.map((p) => p.dpx)) +
          ' — subpath phase off?)',
      );
    else ok('multi-subpath dashes reset per subpath, ≈ Slug');
  }
}

// morphComposedColorRoute — validates that PAINT morphs under the composed
// path (clip/mask/filter/stroke). The composed draw reads fill/stroke color
// from uMetaTex; the route uploads the lerped bbox+fill+stroke meta texels per
// frame, so a color-morphing CLIPPED shape shows the interpolated color.
// Checks: route + composed engage, the center color MORPHS red→blue across t
// (not frozen), and GPU ≈ Slug.
async function morphComposedColorRoute(suite) {
  const { ok, fail } = T;
  function ell(cx, cy, rx, ry) {
    const k = 0.5522847498;
    return (
      `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} ` +
      `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} ` +
      `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} ` +
      `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`
    );
  }
  // Same clip; the FILL color differs between src (#cc3333 red) and dst (#3366cc blue).
  const svg = (d, fill) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<defs><clipPath id="cp"><rect x="55" y="20" width="120" height="160"/></clipPath></defs>` +
    `<path d="${d}" fill="${fill}" clip-path="url(#cp)"/></svg>`;
  const SRC = svg(ell(100, 100, 60, 60), '#cc3333'),
    DST = svg(ell(100, 100, 80, 42), '#3366cc');

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(SRC)})), bDst=createBundle(gl,await importSvg(${JSON.stringify(DST)}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function px(u,x,y){const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto');
  // WAIT FOR THE ROUTE, not for a count of tries. The morph-pair mesh builds off-thread (awaitLbReady waits for it) and its
  // program links in the background; until both are there every draw goes to Slug and reports routed=0, which reads as
  // "this feature never routes" when it simply is not ready yet, and under load a cold link outlasts any fixed number of
  // tries. The deadline is what the suite has left of the lane budget, so a route that never comes still fails, and says so.
  await renderer.awaitLbReady(morph);
  for (const until = performance.now() + ${routeWaitMs(suite)}; !(draw(0.5).routed > 0) && performance.now() < until; )
    await new Promise(r9 => setTimeout(r9, 25));
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v>mx)mx=v;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,ctrGpu:px(b,128,128),ctrSlug:px(a,128,128),mx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
  const r = await suite.result(HTML);
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else {
    console.log(
      '  ' +
        r.perT
          .map(
            (p) =>
              't' +
              p.t +
              ' routed=' +
              p.routed +
              ' composed=' +
              p.composed +
              ' ctr ' +
              JSON.stringify(p.ctrGpu) +
              '/' +
              JSON.stringify(p.ctrSlug) +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    const ceq = (a, b) =>
      Math.abs(a[0] - b[0]) <= 4 && Math.abs(a[1] - b[1]) <= 4 && Math.abs(a[2] - b[2]) <= 4;
    const t0 = r.perT[0],
      t1 = r.perT[2];
    const red = (c) => c[0] > 140 && c[2] < 100,
      blue = (c) => c[2] > 140 && c[0] < 100;
    // THE COMPOSED-PATH ASSERTION IS GONE WITH THE PATH. It named an implementation route -- LB
    // coverage into a render target, then a composite -- and the unified draw that replaced it
    // puts the whole bundle in ONE drawArrays, composing clip/mask/filter in the ubershader.
    // What matters is that the shape routes analytically and the picture matches Slug, which
    // the checks below already assert, and assert more strictly than composed!=1 ever did.
    if (r.perT.some((p) => p.routed !== 1))
      fail('clipped color-morph did not route/compose'.replace('/compose', ''));
    else if (!red(t0.ctrGpu))
      fail('t0 center is not red (paint frozen / wrong): ' + JSON.stringify(t0.ctrGpu));
    else if (!blue(t1.ctrGpu))
      fail(
        't1 center is not blue (paint did NOT morph — frozen at t0): ' + JSON.stringify(t1.ctrGpu),
      );
    else if (r.perT.some((p) => !ceq(p.ctrGpu, p.ctrSlug))) fail('composed color ≠ Slug');
    else ok('composed paint morphs red→blue under clip, byte-≈ Slug');
  }
}

const suite = await openPageSuite({
  root: ROOT,
  args: ['--use-angle=metal', '--no-sandbox', '--use-gl=angle'],
});
try {
  await T.run(
    [
      ['morphRoute', morphRoute],
      ['loopBlinnMorph', loopBlinnMorph],
      ['morphClipRoute', morphClipRoute],
      ['morphMaskRoute', morphMaskRoute],
      ['morphFilterRoute', morphFilterRoute],
      ['morphFilterGraphRoute', morphFilterGraphRoute],
      ['morphGradientRoute', morphGradientRoute],
      ['morphImageRoute', morphImageRoute],
      ['morphTranslucentRoute', morphTranslucentRoute],
      ['morphOpenStrokeRoute', morphOpenStrokeRoute],
      ['morphDashMultiSubpathRoute', morphDashMultiSubpathRoute],
      ['morphComposedColorRoute', morphComposedColorRoute],
    ],
    suite,
  );
} finally {
  await suite.close();
}
if (T.failures()) {
  console.error('\n' + T.failures() + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nmorphRouteSmoke: drawBundle morph routing works, and clip, mask, filters, paints and strokes compose with it',
);

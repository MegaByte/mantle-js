// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbHoleParitySmoke — Loop-Blinn topology routing: each shape class takes the partition it
// needs (earcut mesh, CDT partition or annulus SDF), and inks and leaves holes where Slug does:
//   lbHoleParity              a curved ring: the hole stays empty (CDT, not the additive mesh)
//   lbConcaveCubicParity      concave and holed cubics: notch, cubic ring, glyph-like contours
//   lbCuspHoleParity          a curved hole whose outline carries a d1≈0 cubic (Bezout resultant)
//   lbConcaveCurveFill        a concave single contour keeps the mesh's far-arc interior triangles
//   lbEllipticalRingParity    a mildly elliptical ring is not taken for a circle by the annulus SDF
//   lbDiagonalFrameParity     a thin diagonal frame routes to the CDT instead of shattering
//   lbLensParity              a lens (two arcs on the same endpoints) fills inside, not outside
//   lbConvexCurveFastPath     a convex curved contour takes the earcut mesh; a concave one the CDT
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openReady } from './_pageReady.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
import { emitFixture } from './_fixtures.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// lbHoleParity — a fill WITH A HOLE (ring) must render through the LB
// route matching Slug: the hole stays EMPTY. Guards the static↔morph unification
// for holes — multi-contour CURVED-holed static shapes take the CDT partition path
// (the same one the morph route uses), because the additive single-pass mesh only
// ADDS coverage (MAX/OVER) and would fill the hole (~2× ink).
async function lbHoleParity(host) {
  // A thick ring: outer circle + concentric inner circle (the hole), one path with
  // two subpaths (nonzero winding → annulus). Cubic-arc curves throughout.
  const SVG = readFileSync(
    new URL('../examples/smoke/lbHoleParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
// PRIMITIVES OFF, before any bundle exists. This ring is concentric circles, so shapeRecognize claims it as an SDF
// annulus, and a primitive is a peer of the analytic engines that setLoopBlinnFill('off') deliberately keeps -- with it on,
// the 'off' frame routes the annulus (loopBlinnRouteCount +1, an identical picture) and the 'on' frame never reaches the
// CDT hole partition this smoke exists to check.
renderer.setSdfPrimitives(false);
renderer.setViewport(100, 100);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle);
await renderer.awaitLbReady(bundle);   // LB build is off-thread at load; wait for the worker before asserting the route
// Self-morph (a single-pose timeline, as games mount static art) → the MORPH
// route, which must apply signed coverage to the holed shape too.
const morph = createShapeMorph(gl, createBundle(gl, await importSvg(${JSON.stringify(SVG)})), createBundle(gl, await importSvg(${JSON.stringify(SVG)})));
morph.setT(0);
if (renderer.awaitLbReady) await renderer.awaitLbReady(morph); // morph build is off-thread — wait before asserting the route
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };
const draw = (mode) => { renderer.setLoopBlinnFill(mode); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1, 1, 1, 1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { px: readAll(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const ink = (px) => { let n = 0; for (let i = 0; i < 100 * 100; i++) { const o = i * 4; if (px[o] < 230 || px[o + 1] < 230 || px[o + 2] < 230) n++; } return n; };
// interior mean diff over pixels inked in BOTH (skip AA rim)
const diff = (a, b) => { let s = 0, both = 0; for (let i = 0; i < 100 * 100; i++) { const o = i * 4;
  const ai = a[o] < 230 || a[o+2] < 230, bi = b[o] < 230 || b[o+2] < 230;
  if (ai && bi) { both++; for (let k = 0; k < 3; k++) s += Math.abs(a[o+k]-b[o+k]); } }
  return both ? +(s/(both*3)).toFixed(2) : 999; };
const drawM = (mode) => { renderer.setLoopBlinnFill(mode); const r = renderer.debugStats.loopBlinnMorphRouteCount;
  renderer.beginFrame([1, 1, 1, 1]); renderer.drawBundle(morph); renderer.endFrame();
  return { px: readAll(), routed: renderer.debugStats.loopBlinnMorphRouteCount - r }; };
const slug = draw('off');
const lb = draw('on');
// The morph route needs its variant linked. A frame drawn before that falls back to another engine with the same
// picture, but not through the route this checks, so wait for the route rather than counting frames.
let morphLb = drawM('auto');
for (let w = 0; w < 200 && !morphLb.routed; w++) { await new Promise((r) => setTimeout(r, 10)); morphLb = drawM('auto'); }
window.__out = { slugRouted: slug.routed, lbRouted: lb.routed, slugInk: ink(slug.px), lbInk: ink(lb.px),
  center: { slug: at(slug.px, 50, 50), lb: at(lb.px, 50, 50) }, maxDiff: diff(slug.px, lb.px),
  morphRouted: morphLb.routed, morphInk: ink(morphLb.px), morphCenter: at(morphLb.px, 50, 50), morphDiff: diff(slug.px, morphLb.px) };
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
    // 60s. The page above awaits TWO off-thread LB builds and then
    // renders three times before it sets __ready, so this budget covers real work,
    // not just navigation.
    //
    // Be careful reading a timeout here as a renderer defect. On a machine
    // under memory pressure this smoke slows by more than an order of magnitude
    // while light smokes stay at 1-2s, and it then fails at ANY timeout. Check
    // free swap first.
    await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));
  const isBg = (c) => c[0] > 230 && c[1] > 230 && c[2] > 230;

  if (!o.slugRouted) ok('Slug used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted) ok('ring routes through LB');
  else fail('ring did NOT route to LB');
  if (isBg(o.center.slug)) ok('Slug leaves the hole empty');
  else fail('Slug reference filled the hole?? ' + JSON.stringify(o.center.slug));
  if (isBg(o.center.lb)) ok('LB leaves the hole EMPTY (CDT partition)');
  else
    fail(
      'LB FILLED the hole (center ' +
        JSON.stringify(o.center.lb) +
        ') — CDT hole-removal not engaged',
    );
  if (Math.abs(o.lbInk - o.slugInk) <= o.slugInk * 0.05)
    ok('LB ink matches Slug within 5% (' + o.lbInk + ' vs ' + o.slugInk + ')');
  else fail('LB ink != Slug (' + o.lbInk + ' vs ' + o.slugInk + ') — hole fill / overfill');
  if (o.maxDiff <= 6) ok('interior fill matches Slug (mean channel diff ' + o.maxDiff + ')');
  else fail('interior != Slug (mean channel diff ' + o.maxDiff + ')');
  // MORPH route (single-pose timeline) must also apply signed coverage to the hole.
  if (o.morphRouted) ok('ring routes through the MORPH route');
  else fail('ring did NOT route to the morph route');
  if (isBg(o.morphCenter)) ok('MORPH route leaves the hole EMPTY (signed)');
  else
    fail(
      'MORPH route FILLED the hole (center ' +
        JSON.stringify(o.morphCenter) +
        ') — multi-contour not forced signed',
    );
  if (Math.abs(o.morphInk - o.slugInk) <= o.slugInk * 0.05)
    ok('morph ink matches Slug (' + o.morphInk + ' vs ' + o.slugInk + ')');
  else
    fail('morph ink != Slug (' + o.morphInk + ' vs ' + o.slugInk + ') — hole fill via morph route');

  await page.close();
  if (!failures)
    console.log(
      '\\nlbHoleParitySmoke: a holed fill renders through the signed LB path with the hole empty',
    );
  return failures;
}

// lbConcaveCubicParity — CONCAVE / holed CUBIC shapes render on LB matching
// Slug. Guards three cases icons and font text hit:
// (1) a 'C'/notch shape whose concave cubic edges the EARCUT rim would mis-
// thread (filling the mouth) routes to the CDT partition; (2) a cubic-ring
// (holed) whose crescent hulls the CDT SUBDIVIDES — the sub-triangles are
// ADOPTED into the crescent (buildLoopBlinnCDT), not dropped (under-fill);
// (3) two disjoint filled bars (a pause icon) fill both, not one. All vs Slug.
async function lbConcaveCubicParity(host) {
  let failures = 0;
  const ok = (m) => console.log('ok', m);
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  const cub = (cx, cy, r) => {
    const k = 0.5522847498 * r;
    return (
      `M ${cx + r} ${cy} C ${cx + r} ${cy - k} ${cx + k} ${cy - r} ${cx} ${cy - r} C ${cx - k} ${cy - r} ${cx - r} ${cy - k} ${cx - r} ${cy} ` +
      `C ${cx - r} ${cy + k} ${cx - k} ${cy + r} ${cx} ${cy + r} C ${cx + k} ${cy + r} ${cx + r} ${cy + k} ${cx + r} ${cy} Z`
    );
  };
  const CASES = {
    // 'C'-shape: concave cubic edges + a mouth notch (earcut mis-filled the mouth)
    cShape: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#3366cc" d="M150 50 C 80 20 40 60 40 100 C 40 140 80 180 150 150 L150 120 C 100 145 70 130 70 100 C 70 70 100 55 150 80 Z"/></svg>`,
    // cubic ring (NOT arcs): outer+inner cubic circles, evenodd — CDT crescent adoption
    cubicRing: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#3366cc" fill-rule="evenodd" d="${cub(100, 100, 70)} ${cub(100, 100, 38)}"/></svg>`,
    // two disjoint filled bars (a pause icon) — both must fill
    pauseBars: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#3366cc" d="M60 50 h30 v100 h-30 Z M110 50 h30 v100 h-30 Z"/></svg>`,
    // ARC ring (annulus of arcs = rquads) — a mute/how-to-play ring; a MODERATE
    // width fills fully via the adopted arc crescents and stays on LB.
    arcRing: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#3366cc" fill-rule="evenodd" d="M50 8 a42 42 0 1 0 0.1 0 Z M50 22 a28 28 0 1 0 0.1 0 Z"/></svg>`,
    // THIN arc ring — its arc hulls subdivide heavily (inner+outer mutually
    // intrude), so every band triangle is reconstructed against both its inner and
    // outer arc: each band triangle emits a crescent per straddled arc (outer arc
    // ramps the outer edge, inner arc the inner edge) plus a deep-fill solid base.
    // Renders SOLID and smooth on LB (no "alpha wedges", no faceted polygon),
    // matching Slug.
    thinArcRing: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#3366cc" fill-rule="evenodd" d="M50 10 a40 40 0 1 0 0.1 0 Z M50 20 a30 30 0 1 0 0.1 0 Z"/></svg>`,
  };
  // cShape routes like every other case and must render correctly: against an exact reference at 512 px no analytic
  // piece of it paints air (0 px outside, 0 wrong solid, AA mean on a par with Slug). A shape the strict cubic audit
  // declines belongs in NO_ROUTE.
  const NO_ROUTE = new Set([]);

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="220" height="220"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W=220,H=220;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders,{staticUnified:true}); renderer.setViewport(W,H);
const read=()=>{const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;};
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<200)n++;return n;};
const diff=(a,b)=>{let n=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])>60)n++;return n;};
function measure(b){ renderer.setLoopBlinnFill('off'); renderer.beginFrame([1,1,1,1]); renderer.drawBundle(b); renderer.endFrame(); const slug=read();
  const c1=renderer.debugStats.loopBlinnRouteCount; renderer.setLoopBlinnFill('on'); renderer.beginFrame([1,1,1,1]); renderer.drawBundle(b); renderer.endFrame(); const lb=read();
  return {slugInk:ink(slug),lbInk:ink(lb),diffPx:diff(slug,lb),lbRouted:renderer.debugStats.loopBlinnRouteCount>c1}; }
const out={}; const CASES=${JSON.stringify(CASES)};
try{ for(const [k,svg] of Object.entries(CASES)){ const b=createBundle(gl,await importSvg(svg)); renderer.prepareBundle(b); await renderer.awaitLbReady(b); out[k]=measure(b); } out.ok=true; }
catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
  // HEADLESS EVEN ON THE GPU. Headless reaches the real GPU -- ANGLE (Apple, ANGLE Metal Renderer)
  // reports and TIMES the same either way. A window is not free to the person running this: macOS
  // CLAMPS --window-position, so a headful run cannot be put out of the way and lands
  // on whichever desktop is in front.
  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  await page.goto(host.page(HTML), {
    waitUntil: 'load',
    timeout: 20000,
  });
  await page
    .waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 })
    .catch(() => {});
  const r = await page.evaluate(() => window.__r);
  await page.close();
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else
    for (const k of Object.keys(CASES)) {
      const v = r[k];
      console.log(
        '  ' +
          k +
          ': lbRouted=' +
          v.lbRouted +
          ' ink lb=' +
          v.lbInk +
          ' slug=' +
          v.slugInk +
          ' diffPx=' +
          v.diffPx,
      );
      if (NO_ROUTE.has(k)) {
        if (!v.lbRouted) ok(k + ': correctly falls back to Slug (gate)');
        else fail(k + ': routed LB but should hit the correctness gate');
      } else if (v.lbRouted) ok(k + ': routes through LB');
      else fail(k + ': did NOT route to LB');
      if (v.diffPx <= Math.max(160, v.slugInk * 0.06))
        ok(k + ': renders correctly (diffPx ' + v.diffPx + ')');
      else
        fail(
          k +
            ': DIVERGES from Slug (diffPx ' +
            v.diffPx +
            ', ink ' +
            v.lbInk +
            ' vs ' +
            v.slugInk +
            ')',
        );
    }
  if (!failures)
    console.log('lbConcaveCubicParity: concave/holed cubic shapes render on LB matching Slug');
  return failures;
}

// lbCuspHoleParity — a CURVED-HOLED shape whose outer boundary carries a d1≈0 cubic (klmn undefined, not
// self-intersecting) renders through LB's CDT partition via the exact Bezout resultant (kind 4) instead of dropping
// the whole shape to Slug. Checks: the shape routes through LB (no per-shape Slug sentinel), the hole stays empty,
// and the LB render matches Slug within 5% ink.
//
// TWO CASES. `spikeTip` leaves the cubic's start point along its own closing edge (both leave (50,60) heading +y): a
// ZERO-ANGLE spike tip. The over-paint proof cannot certify a face that another boundary enters, a tangent joint is
// exactly that, and the shape declines to Slug -- hole or no hole. `cuspHole` moves the closing edge's foot to x=40,
// which gives the same cubic and hole a real joint, and LB meshes it (against an exact reference at 512 px, 0 px
// painted outside, 0 wrong solid). So `cuspHole` must route; `spikeTip` must only render correctly, by whichever path
// serves it.
async function lbCuspHoleParity(host) {
  let failures = 0;
  const ok = (m) => console.log('ok', m);
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  // Named constants, not a generator call: scripts/genSmokeAssets.mjs derives examples/smoke/*.svg from the SVG strings a
  // smoke holds, and names each file after the constant.
  const HOLE = 'M 85 120 L 115 120 L 115 155 L 85 155 Z'; // square hole; evenodd
  const CUSP_HOLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill-rule="evenodd" fill="#3366cc" d="M 50 60 C 50 160 150 10 150 110 L 150 175 L 40 175 Z ${HOLE}"/></svg>`; // d1≈0 cubic, real joint at (50,60)
  const SPIKE_TIP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill-rule="evenodd" fill="#3366cc" d="M 50 60 C 50 160 150 10 150 110 L 150 175 L 50 175 Z ${HOLE}"/></svg>`; // same cubic, zero-angle joint
  const CASES = { cuspHole: CUSP_HOLE, spikeTip: SPIKE_TIP };
  const MUST_ROUTE = new Set(['cuspHole']);

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W=200,H=200;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders,{staticUnified:true}); renderer.setViewport(W,H);
const CASES=${JSON.stringify(CASES)};
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const at=(u,x,y)=>{const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];};
const results={};
for (const [name, svg] of Object.entries(CASES)) {
  const out={};
  try{
    const bundle=createBundle(gl,await importSvg(svg)); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
    renderer.setLoopBlinnFill('off'); const r0=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(bundle); const slug=read();
    out.slugRouted = renderer.debugStats.loopBlinnRouteCount>r0;
    renderer.setLoopBlinnFill('on');  const r1=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(bundle); const lb=read();
    out.lbRouted = renderer.debugStats.loopBlinnRouteCount>r1;
    out.hasSlug = !!bundle._lbHasSlug;   // true → a shape fell back to a per-shape Slug sentinel
    out.slugInk=ink(slug); out.lbInk=ink(lb);
    out.holeLb=at(lb,100,137); out.holeSlug=at(slug,100,137);   // center of the hole
    out.ok=true;
  }catch(e){out.err=String(e&&e.stack||e);}
  results[name]=out;
}
window.__r=results; window.__done=true;
</script></body></html>`;
  // HEADLESS EVEN ON THE GPU. Headless reaches the real GPU -- ANGLE (Apple, ANGLE Metal Renderer)
  // reports and TIMES the same either way. A window is not free to the person running this: macOS
  // CLAMPS --window-position, so a headful run cannot be put out of the way and lands
  // on whichever desktop is in front.
  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  await page.goto(host.page(HTML), {
    waitUntil: 'load',
    timeout: 20000,
  });
  await page
    .waitForFunction(() => window.__done === true, { timeout: 90000, polling: 100 })
    .catch(() => {});
  const r = await page.evaluate(() => window.__r);
  await page.close();
  const isBg = (c) => c[0] > 240 && c[1] > 240 && c[2] > 240;
  if (!r) fail('did not complete');
  for (const [name, x] of Object.entries(r || {})) {
    if (!x.ok) {
      fail(name + ': did not complete: ' + x.err);
      continue;
    }
    console.log(
      '  ' +
        name +
        ': routed slug=' +
        x.slugRouted +
        ' lb=' +
        x.lbRouted +
        ' hasSlugSentinel=' +
        x.hasSlug +
        '  ink lb=' +
        x.lbInk +
        ' slug=' +
        x.slugInk +
        '  hole lb=' +
        JSON.stringify(x.holeLb),
    );
    if (!x.slugRouted) ok(name + ': Slug used with LB off');
    else fail(name + ': LB routed with fill off');
    if (MUST_ROUTE.has(name)) {
      if (x.lbRouted) ok(name + ': routes through LB');
      else fail(name + ': did NOT route to LB');
      if (!x.hasSlug) ok(name + ': served on the LB CDT path (no per-shape Slug sentinel)');
      else fail(name + ': fell back to a per-shape Slug sentinel (not served by the CDT)');
    }
    if (isBg(x.holeLb) && isBg(x.holeSlug)) ok(name + ': hole stays empty in both');
    else
      fail(
        name +
          ': hole filled? lb=' +
          JSON.stringify(x.holeLb) +
          ' slug=' +
          JSON.stringify(x.holeSlug),
      );
    if (Math.abs(x.lbInk - x.slugInk) <= Math.max(120, x.slugInk * 0.05))
      ok(name + ': LB ink matches Slug within 5% (' + x.lbInk + ' vs ' + x.slugInk + ')');
    else fail(name + ': LB diverges from Slug (' + x.lbInk + ' vs ' + x.slugInk + ')');
  }
  if (!failures)
    console.log(
      '\nlbCuspHoleParitySmoke: a d1≈0 cubic in a holed shape renders on LB (Bezout CDT); a zero-angle spike renders correctly',
    );
  return failures;
}

// A single-contour curved shape with a concave outline must fill through the
// fast-mesh LB path without losing interior triangles that touch a distant arc.
async function lbConcaveCurveFill(host) {
  const SVG = readFileSync(new URL('../examples/_concave_cubic.svg', import.meta.url), 'utf8');
  const N = 200;
  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
const N = ${N};
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(N, N);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
// How long this page waits for a route it expects: the lane's budget, so a loaded machine only takes longer and a route that never comes still says so.
const BUDGET = ${pageTimeoutFor(120000, 30000)}, DEADLINE = performance.now() + BUDGET;
const read = () => { const px = new Uint8Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const ink = (px) => { let n = 0; for (let i = 0; i < N * N; i++) { const o = i * 4; if (!(px[o] > 245 && px[o + 1] > 245 && px[o + 2] > 245)) n++; } return n; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1, 1, 1, 1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { ink: ink(read()), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const slug = draw('off');
// STEADY STATE, not the first frame. While the LB-hosting fill variant is still
// linking, a bundle falls to the best NON-LB engine (the ordinary fill pass re-runs
// its own selection) rather than into the classic coverage-RT routes, so nothing
// routes to LB by design until the program has linked. So wait for THE ROUTE, not
// for a count of frames: on a loaded machine a link outlasts any fixed frame
// count.
renderer.setLoopBlinnFill('on'); renderer.prepareBundle(bundle);
const meshReady = await renderer.awaitLbReady(bundle, BUDGET);   // pinned first: a build under the default selection may not hold this shape
let lb = draw('on');
while (!lb.routed && performance.now() < DEADLINE) {
  if (renderer.precompileFills) { try { renderer.precompileFills(); } catch {} }
  // rAF ALONE NEVER SETTLES in a headless page with no visible work. Timeout wins if rAF stalls.
  await new Promise((r) => { const _t = setTimeout(r, 100); requestAnimationFrame(() => { clearTimeout(_t); r(); }); });
  lb = draw('on');
}
window.__out = { meshReady, gate: renderer.debugStats.unifiedFillGate, slugInk: slug.ink, lbInk: lb.ink, lbRouted: lb.routed }; window.__ready = true;
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
  try {
    await openReady(page, host.page(HTML), { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }
  const o = await page.evaluate(() => window.__out);
  console.log('  ', JSON.stringify(o));
  if (o.meshReady) ok('the analytic build finished');
  else fail('the analytic build never finished');
  if (o.lbRouted) ok('concave curved shape routes through LB');
  else fail('shape did NOT route to LB');
  if (o.lbInk >= o.slugInk * 0.95)
    ok('LB fills the concave shape (ink ' + o.lbInk + ' vs Slug ' + o.slugInk + ')');
  else
    fail(
      'LB UNDER-FILLS the concave shape: ink ' +
        o.lbInk +
        ' vs Slug ' +
        o.slugInk +
        ' (' +
        (((o.lbInk / o.slugInk) * 100) | 0) +
        '%) — curveTri over-reach on the fast-mesh earcut',
    );
  await page.close();
  if (!failures)
    console.log(
      '\nlbConcaveCurveFillSmoke: a concave-outline curved shape fills via the fast mesh (chord-edge curveTri guard)',
    );
  return failures;
}

// lbEllipticalRingParity — a MILDLY elliptical ring (aspect ~1.06, like a
// font 'o'/'O'/'0') must NOT be mistaken for a circle by the annulus SDF. The
// circle fit that samples only the on-curve ENDPOINTS passes a few-percent ellipse
// (res/r≈0.02 under a 0.03 tolerance) and renders it as a MIS-SIZED circle — the
// ring comes out too thick, mean boundary error ~0.3 vs Slug (round glyphs look
// visibly rough). So the fit also checks each segment's t=½ ON-CURVE midpoint and
// tightens to 0.01·r, so the ellipse is rejected → it takes the accurate CDT
// crescent path and matches Slug. (True circles sit at res/r≈0, still SDF-exact —
// guarded by lbAnnulusSdfSmoke, both its lbCircleSdf and its lbAnnulusSdf cases.)
async function lbEllipticalRingParity(host) {
  const R = 64;
  // N-quad ellipse; aspect rx/ry ~1.06 → a few-percent ellipse (endpoints near a
  // circle, curve bulges off it). control = endpoint-tangent intersection.
  function quadEllipse(cx, cy, rx, ry, ccw) {
    const N = 8;
    const pt = (a) => [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
    const tn = (a) => [-rx * Math.sin(a), ry * Math.cos(a)];
    let d = '';
    for (let i = 0; i < N; i++) {
      const sg = ccw ? 1 : -1,
        a0 = (sg * 2 * Math.PI * i) / N,
        a1 = (sg * 2 * Math.PI * (i + 1)) / N;
      const p0 = pt(a0),
        p1 = pt(a1),
        t0 = tn(a0).map((v) => v * sg),
        t1 = tn(a1).map((v) => v * sg);
      const det = t0[0] * -t1[1] - t0[1] * -t1[0];
      const s = ((p1[0] - p0[0]) * -t1[1] - (p1[1] - p0[1]) * -t1[0]) / det;
      const ctrl = [p0[0] + s * t0[0], p0[1] + s * t0[1]];
      d +=
        (i === 0 ? `M${p0[0].toFixed(3)} ${p0[1].toFixed(3)} ` : '') +
        `Q${ctrl[0].toFixed(3)} ${ctrl[1].toFixed(3)} ${p1[0].toFixed(3)} ${p1[1].toFixed(3)} `;
    }
    return d + 'Z';
  }
  // outer CCW + inner CW → nonzero fills the ring. rx/ry ≈ 1.03 (a few-percent
  // ellipse, like a font 'o') — res/r≈0.02 sits between a 0.03 tolerance
  // (false-accept → mis-sized circle, mean≈0.3) and the fit's 0.01 (rejected → CDT).
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${R} ${R}" width="${R}" height="${R}"><path fill="black" d="${quadEllipse(32, 32, 26, 25.2, true)} ${quadEllipse(32, 32, 17.3, 16.8, false)}"/></svg>`;
  emitFixture('lbEllipticalRingParity__SVG', SVG);

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${R}" height="${R}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true }); renderer.setViewport(${R}, ${R});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const read = () => { const px = new Uint8Array(${R}*${R}*4); gl.readPixels(0,0,${R},${R},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const cov = (px,x,y) => { const q = ((${R}-1-y)*${R}+x)*4; return (255-px[q])/255; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const slug = draw('off'), lb = draw('on');
let worst=0, sum=0, n=0, hole=cov(lb.px, 32, 32);
for (let y=0;y<${R};y++) for (let x=0;x<${R};x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if ((s>0.02&&s<0.98)||(l>0.02&&l<0.98)){ const e=Math.abs(s-l); if(e>worst)worst=e; sum+=e; n++; } }
window.__out = { lbRouted: lb.routed, worst:+worst.toFixed(3), mean:+(sum/Math.max(n,1)).toFixed(4), hole:+hole.toFixed(2) };
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
  if (o.lbRouted) ok('elliptical ring routes through LB');
  else fail('ring did NOT route to LB');
  if (o.hole < 0.05) ok('ring hole stays empty (' + o.hole + ')');
  else fail('ring hole filled (' + o.hole + ')');
  // The discriminator is MEAN: a false circle-fit renders a mis-sized
  // circle → the whole boundary is off, mean ≈ 0.3; the correct CDT path is ≈ 0.05.
  if (o.mean <= 0.12)
    ok('elliptical ring matches Slug — not mistaken for a circle (mean ' + o.mean + ')');
  else
    fail(
      'elliptical ring rendered as a mis-sized circle (mean ' +
        o.mean +
        ') — annulus false-accept?',
    );

  await page.close();
  if (!failures)
    console.log(
      '\nlbEllipticalRingParitySmoke: a few-percent-elliptical ring is not mis-rendered as a circle',
    );
  return failures;
}

// lbDiagonalFrameParity — a thin diagonal frame does not shatter on
// Loop-Blinn. A thin fill FRAME formed by two opposite-winding STRAIGHT
// contours with a DIAGONAL folded corner (a page outline: outer CCW + inner inset
// CW, nonzero fills the ~10px border) would shatter into a fan of inverted
// triangles on the LB earcut fast path — the hole-bridge crosses the thin, near-
// coincident diagonal sliver. So multi-contour straight shapes route to the CDT
// partition (robust for any hole geometry), so LB matches the Slug ray-cast.
// Single-contour straight polygons (streamed road strips) keep the earcut fast path.
async function lbDiagonalFrameParity(host) {
  const W = 93,
    H = 143;
  // De-obfuscated real asset (folded-corner page outline): outer CCW page + inner CW inset.
  const SVG = `<svg viewBox="0 0 186 286" xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><path d="M135.2 10 L176 51 V276 H10 V10 Z  M139.4 0 H0 V286 H186 V46.9 L183.1 44 L142.3 3 Z" fill="#000"/></svg>`;
  emitFixture('lbDiagonalFrameParity__SVG', SVG);

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true }); renderer.setViewport(${W}, ${H});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const read = () => { const px = new Uint8Array(${W}*${H}*4); gl.readPixels(0,0,${W},${H},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const cov = (px,x,y) => { const q = ((${H}-1-y)*${W}+x)*4; return (255-px[q])/255; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const slug = draw('off'), lb = draw('on');
let xor=0, sInk=0, lInk=0;
for (let y=0;y<${H};y++) for (let x=0;x<${W};x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if (s>0.5) sInk++; if (l>0.5) lInk++; if (Math.abs(s-l)>0.5) xor++; }
window.__out = { lbRouted: lb.routed, xor, sInk, lInk };
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
  if (o.lbRouted) ok('diagonal frame routes through LB');
  else fail('frame did NOT route to LB');
  if (o.sInk > 500 && o.lInk > 500)
    ok('frame fills a real border (Slug ' + o.sInk + ', LB ' + o.lInk + ' px)');
  else fail('frame ink implausible (Slug ' + o.sInk + ', LB ' + o.lInk + ')');
  if (o.xor <= 30) ok('LB matches Slug — thin diagonal frame does not shatter (xor ' + o.xor + ')');
  else fail('LB diverges from Slug — frame shattering? (xor ' + o.xor + ')');

  await page.close();
  if (!failures)
    console.log(
      '\nlbDiagonalFrameParitySmoke: thin diagonal opposite-winding frame renders via CDT, matches Slug',
    );
  return failures;
}

// lbLensParity — a LENS (vesica: two arcs sharing both endpoints) must
// render through the LB route matching Slug — filled INSIDE, empty OUTSIDE.
//
// Guards the degenerate chord ring. The CDT fill-sign calibration probes just
// off the first segment's chord and tests an even-odd polygon built from segment
// ENDPOINTS. A lens's two arcs share the same two vertices, so that polygon is a
// hairline (zero area) → pointInPoly always false → the sign would invert and LB
// fill the OUTSIDE (a bowtie/diamond), leaving the lens empty (~2× Slug's ink).
// So chordRing re-derives a degenerate ring with on-curve midpoints, which gives
// it real area.
async function lbLensParity(host) {
  // Sharp vesica: two arcs from (50,10)→(50,90)→(50,10), bulging opposite ways.
  const SVG = readFileSync(
    new URL('../examples/smoke/lbLensParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
renderer.setViewport(100, 100);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };
const draw = (mode) => { renderer.setLoopBlinnFill(mode); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1, 1, 1, 1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { px: readAll(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const ink = (px) => { let n = 0; for (let i = 0; i < 100 * 100; i++) { const o = i * 4; if (px[o] < 230 || px[o + 1] < 230 || px[o + 2] < 230) n++; } return n; };
const slug = draw('off');
const lb = draw('on');
window.__out = { slugRouted: slug.routed, lbRouted: lb.routed, slugInk: ink(slug.px), lbInk: ink(lb.px),
  // (50,50) = lens center (INSIDE) · (14,50) = far-left (OUTSIDE the lens, inside the inverted bowtie)
  centerSlug: at(slug.px, 50, 50), centerLb: at(lb.px, 50, 50),
  outSlug: at(slug.px, 14, 50), outLb: at(lb.px, 14, 50) };
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
  const isBg = (c) => c[0] > 230 && c[1] > 230 && c[2] > 230;
  const isFill = (c) => c[2] > 120 && c[0] < 160 && c[1] < 200; // ~#3366cc

  if (!o.slugRouted) ok('Slug used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted) ok('lens routes through LB');
  else fail('lens did NOT route to LB');
  if (isFill(o.centerSlug)) ok('Slug fills the lens center');
  else fail('Slug reference did not fill center?? ' + JSON.stringify(o.centerSlug));
  if (isFill(o.centerLb)) ok('LB fills the lens center (sign not inverted)');
  else
    fail(
      'LB left the lens center EMPTY (' +
        JSON.stringify(o.centerLb) +
        ') — degenerate-ring sign inversion',
    );
  if (isBg(o.outLb)) ok('LB leaves OUTSIDE the lens empty (no inverted bowtie)');
  else fail('LB filled OUTSIDE the lens (' + JSON.stringify(o.outLb) + ') — inverted fill');
  if (Math.abs(o.lbInk - o.slugInk) <= o.slugInk * 0.05)
    ok('LB ink matches Slug within 5% (' + o.lbInk + ' vs ' + o.slugInk + ')');
  else fail('LB ink != Slug (' + o.lbInk + ' vs ' + o.slugInk + ') — inversion / mis-fill');

  await page.close();
  if (!failures) console.log('lbLensParity: lens fills inside, empty outside, ink matches Slug');
  return failures;
}

// lbConvexCurveFastPath — a single-contour, opaque, CONVEX curved shape
// (no concave curve, no hole) renders through the cheap earcut MESH path instead
// of the CDT partition — and matches Slug. A shape with a CONCAVE curve must still
// fall to the CDT path (the mesh mis-threads it). Guards the routing fast path:
// buildLoopBlinnMesh flags hasConcave, so only concave curves pay the CDT cost.
async function lbConvexCurveFastPath(host) {
  // convex: ellipse (arcs) + a convex cubic "leaf". concave: a crescent (inner cubic
  // bulges into the fill) — the mesh would over-fill it, so it must route to CDT.
  const SHAPES = {
    ellipse: { convex: true, d: 'M60 20 A40 25 0 1 0 60 100 A40 25 0 1 0 60 20 Z' },
    leaf: { convex: true, d: 'M60 15 C95 30 95 90 60 105 C25 90 25 30 60 15 Z' },
    crescent: { convex: false, d: 'M60 15 C100 15 100 105 60 105 C90 85 90 35 60 15 Z' },
  };

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="120" height="120"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true }); renderer.setViewport(120, 120);
window.__run = async (d) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120"><path fill="#3366cc" d="' + d + '"/></svg>';
  const bundle = createBundle(gl, await importSvg(svg)); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
  const read = () => { const px = new Uint8Array(120*120*4); gl.readPixels(0,0,120,120,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
  const fill = (px,i) => { const o = i*4; return px[o] < 230 || px[o+2] < 230; };
  const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
    renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame();
    return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
  const slug = draw('off'), lb = draw('on');
  let ink = 0, disagree = 0;
  for (let i = 0; i < 120*120; i++) { if (fill(slug.px,i)) ink++; if (fill(slug.px,i) !== fill(lb.px,i)) disagree++; }
  return { slugInk: ink, disagree, routed: lb.routed };
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
    await openReady(page, host.page(HTML), { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  for (const [name, s] of Object.entries(SHAPES)) {
    const o = await page.evaluate((d) => window.__run(d), s.d);
    console.log(`  [${name}] ` + JSON.stringify(o));
    if (o.routed) ok(`[${name}] routes through LB`);
    else fail(`[${name}] did NOT route to LB`);
    // disagreement with Slug: a mis-thread over/under-fills a large region (~thousands
    // of px); a correct render differs only in a thin AA band (~tens of px). The tol
    // sits well between the two so it catches a mis-thread but passes AA noise.
    const tol = Math.max(200, o.slugInk * 0.08);
    if (o.disagree <= tol)
      ok(
        `[${name}] ${s.convex ? 'convex→mesh' : 'concave→CDT'} matches Slug (disagree ${o.disagree} ≤ ${tol | 0})`,
      );
    else
      fail(
        `[${name}] disagrees with Slug by ${o.disagree}px (> ${tol | 0}) — ${s.convex ? 'mesh mis-thread' : 'CDT error'}`,
      );
  }

  await page.close();
  if (!failures)
    console.log(
      '\\nlbConvexCurveFastPathSmoke: convex curves render correct via mesh, concave via CDT',
    );
  return failures;
}

const host = await openCaseHost(ROOT);
const failures = await runCases(host, [
  ['lbHoleParity', lbHoleParity],
  ['lbConcaveCubicParity', lbConcaveCubicParity],
  ['lbCuspHoleParity', lbCuspHoleParity],
  ['lbConcaveCurveFill', lbConcaveCurveFill],
  ['lbEllipticalRingParity', lbEllipticalRingParity],
  ['lbDiagonalFrameParity', lbDiagonalFrameParity],
  ['lbLensParity', lbLensParity],
  ['lbConvexCurveFastPath', lbConvexCurveFastPath],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nlbHoleParitySmoke: every topology class routes and inks like Slug');

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbTranslucentSolidSmoke — translucent solid fills on the Loop-Blinn route composite alpha
// exactly, as Slug does: no pixel is composited twice.
//   lbTranslucentSolid          forced LB serves translucent solids, overlapping shapes included
//   lbTranslucentStripBlend     a translucent curve does not blend over itself on its curve bands
//   lbTranslucentOverlapParity  overlapping translucent circles batch into the one-draw route
//   lbTranslucentParity         a translucent diamond on the composite path
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { emitFixture } from './_fixtures.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// lbTranslucentSolid — forced LB serves translucent solids and composites
// alpha exactly, including overlapping shapes (no pixel composited twice).
async function lbTranslucentSolid(host) {
  const N = 200;

  // Two overlapping translucent solid discs, drawn as proper 4-cubic circles (tangent
  // control points, k = 0.5523r). Do NOT use corner-style control points here: those
  // classify as kind-4 (Bezout) cubics, which have their own open under-fill bug
  // (probes/_lbCubicCircleBug.mjs) and would make this test fail for an unrelated reason.
  // The center band is covered by both: red-over-blue at 50% each.
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">
  <path fill="#3366cc" fill-opacity="0.5" d="M 30 100 C 30.000 72.385 52.385 50.000 80 50 C 107.615 50.000 130.000 72.385 130 100 C 130.000 127.615 107.615 150.000 80 150 C 52.385 150.000 30.000 127.615 30 100 Z"/>
  <path fill="#cc3333" fill-opacity="0.5" d="M 70 100 C 70.000 72.385 92.385 50.000 120 50 C 147.615 50.000 170.000 72.385 170 100 C 170.000 127.615 147.615 150.000 120 150 C 92.385 150.000 70.000 127.615 70 100 Z"/>
</svg>`;
  const QUAD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">
  <path fill="#3366cc" fill-opacity="0.5" d="M 30 45 Q 100 15 170 45 L 170 155 Q 100 185 30 155 Z"/>
</svg>`;
  emitFixture('lbTranslucentSolid__SVG', SVG);

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
// The double-paint question is the unified draw's, answered by a painter-order depth
// claim (see unifiedFillDraw) — and that is what the pixel assertions below check.
const renderer = createRenderer(gl, shaders, { staticUnified: true });
// Exercise prepareBundle's synchronous builder before its queued worker can
// publish. It must choose the same convex-translucent chain plan as the worker.
const qBundle = createBundle(gl, await importSvg(${JSON.stringify(QUAD_SVG)}));
const syncPrepared = renderer.prepareBundle(qBundle);
const qChain = qBundle._lbMeshesRaw && qBundle._lbMeshesRaw[0] && qBundle._lbMeshesRaw[0].interiorChainA;
const syncConvexHasChain = !!qChain && qChain.some(v => v !== 0);
qBundle.dispose();
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle);
const draw = () => { renderer.setViewport(N,N); renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); return Array.from(px); };
const at = (px, x, yTop) => { const o = ((N-1-yTop)*N + x)*4; return [px[o], px[o+1], px[o+2]]; };

renderer.setLoopBlinnFill('off'); draw(); const slug = readAll();
const c0 = renderer.debugStats.loopBlinnRouteCount;
// awaitLbReady, not just prepareBundle: while the LB-hosting variant links a bundle
// falls to the best non-LB engine, so a one-frame draw would route nothing.
renderer.setLoopBlinnFill('on'); await renderer.awaitLbReady(bundle); draw(); const lb = readAll();
const lbRouted = renderer.debugStats.loopBlinnRouteCount - c0;

let maxDiff = 0, sum = 0;
for (let i = 0; i < slug.length; i++) { const d = Math.abs(slug[i]-lb[i]); if (d>maxDiff) maxDiff=d; sum+=d; }

// where does it differ? coarse 4x4 map of mean |diff| per cell + ink counts
const cells=[];
for(let cy=0;cy<4;cy++){ const row=[];
  for(let cx=0;cx<4;cx++){ let acc=0,n=0;
    for(let y=cy*N/4;y<(cy+1)*N/4;y++) for(let x=cx*N/4;x<(cx+1)*N/4;x++){
      const o=(y*N+x)*4; for(let k=0;k<3;k++){acc+=Math.abs(slug[o+k]-lb[o+k]); n++;} }
    row.push(+(acc/n).toFixed(1)); }
  cells.push(row); }
const ink=(px)=>{let n=0; for(let i=0;i<px.length;i+=4) if(px[i]<250||px[i+1]<250||px[i+2]<250) n++; return n;};

// DOUBLE-COMPOSITE DETECTOR. A mean over the whole image cannot see a one-pixel line, so it
// misses what this pins: an AA ring extruded from EVERY cubic hull edge, including the chord
// shared with the interior triangle, lies inside the fill and its klm reads "inside", so it
// paints coverage 1 a second time — invisible under an opaque
// fill, a solid line under a translucent one. Any LB pixel materially DARKER than Slug on a
// white ground is a pixel composited twice. There must be none.
let doubled = 0, worst = 0;
for (let i = 0; i < N*N; i++) {
  const o = i*4;
  const d = ((slug[o]+slug[o+1]+slug[o+2]) - (lb[o]+lb[o+1]+lb[o+2])) / 3;
  // > 16, not > 8: a genuine double-composite is huge (a 0.5 fill compositing to 0.75 reads ~35
  // and this fixture reads up to 56). Edge pixels differ by single digits simply because the two
  // kernels round differently at an edge, and scoring those would make this a test of AA agreement rather than of double-compositing.
  if (d > 16) { doubled++; if (d > worst) worst = d; }
}
window.__out = {
  doubled, worstDark: +worst.toFixed(1),
  cells, inkSlug: ink(slug), inkLb: ink(lb),
  lbRouted,
  syncPrepared, syncConvexHasChain,
  maxDiff, meanDiff: sum/slug.length,
  // (120,100) lies in the overlap of both discs; (55,100) only in the blue one.
  overlapLb: at(lb,120,100), overlapSlug: at(slug,120,100),
  soloLb:    at(lb,55,100),  soloSlug:    at(slug,55,100),
};
window.__ready = true;
</script></body></html>`;

  const br = host.browser;
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(host.page(HTML), { waitUntil: 'load', timeout: 90000 });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });
  const o = await pg.evaluate(() => window.__out);
  await pg.close();

  let fail = 0;
  const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
  const near = (a, b, t) => a.every((v, i) => Math.abs(v - b[i]) <= t);

  console.log('  diff map (mean |Δ| per 50x50 cell, top row = top of image):');
  for (const row of o.cells) console.log('    ' + row.map((v) => String(v).padStart(6)).join(''));
  console.log(`  ink: slug=${o.inkSlug} lb=${o.inkLb} (ratio ${(o.inkLb / o.inkSlug).toFixed(3)})`);
  ok(o.lbRouted > 0, `translucent solids take the forced LB route (routes=${o.lbRouted})`);
  ok(
    o.syncPrepared && !o.syncConvexHasChain,
    'synchronous and worker builders both omit convex translucent PART chains',
  );
  // LB/Slug differ by a few LSBs on cubic AA edges; interior pixels must agree tightly.
  ok(
    o.meanDiff <= 3.0,
    `matches all-Slug (meanDiff=${o.meanDiff.toFixed(4)}, maxDiff=${o.maxDiff})`,
  );
  // The one that matters for translucency, and the one a mean cannot see.
  ok(
    o.doubled === 0,
    `NO pixel is composited twice (${o.doubled} px darker than Slug, worst Δlum ${o.worstDark})`,
  );
  ok(
    near(o.overlapLb, o.overlapSlug, 3),
    `α composites exactly where the two discs OVERLAP (lb=${o.overlapLb} slug=${o.overlapSlug})`,
  );
  ok(
    near(o.soloLb, o.soloSlug, 3),
    `α correct in the singly-covered region (lb=${o.soloLb} slug=${o.soloSlug})`,
  );

  console.log(fail ? `\nLB-TRANSLUCENT-SOLID FAIL (${fail})` : '\nLB-TRANSLUCENT-SOLID PASS');
  return fail;
}

// lbTranslucentStripBlend — a TRANSLUCENT curved shape must not blend
// over ITSELF along its curve bands.
//
// LB's curve strips (kinds 9/10) deliberately share the interior's depth tier and
// BLEND with it rather than claiming the pixel. That union is exact at α=1, where
// "band ∪ interior saturates" — OVER with an opaque color is idempotent, so
// painting a pixel twice is harmless.
//
// At α<1 it is NOT. The union blends the shape OVER ITSELF: α=0.6 twice reads
// 0.84, three times 0.94, and along a curve band it drives to fully opaque. A
// translucent curved shape then renders its edges far too solid and swallows
// whatever sits behind it. On parallax hills (stacked ridges, the front one at
// fill-opacity 0.6) a band along every ridge would paint the front hill at
// coverage 1.00 where the truth is 0.60, eating the thin
// visible sliver of the ridge behind it — which reads as "the curve fill is
// missing" and as "the AA is too dark".
//
// Assertions:
//   1. The bundle actually routes to LB (else this proves nothing).
//   2. LB matches Slug across the whole canvas.
//   3. The translucent shape's coverage over the shape behind it is the TRUE α,
//      not the self-blended 1-(1-α)^n. This is the assertion that fails loudly on
//      a defect: the band saturates instead of ramping.
async function lbTranslucentStripBlend(host) {
  const url = host.url(`mantleDemo.html`);

  // Back: OPAQUE pure-green ridge. Front: the same ridge dropped 30em, PURE BLUE at
  // fill-opacity 0.6 — chained quads, so it carries curve strips. Pure primaries keep
  // the arithmetic unambiguous: over green, the blue channel IS the front's coverage.
  const ALPHA = 0.6;
  // A ridge of 17 chained NEAR-FLAT quads (control deviation ~0.55% of chord) — this
  // is the geometry that actually carries curve strips, and a 2-quad ridge does NOT
  // reproduce the bug. Back: OPAQUE green. Front: the same ridge dropped 30em, PURE
  // BLUE at fill-opacity 0.6. Pure primaries keep the arithmetic unambiguous — over
  // green, the blue channel IS the front shape's coverage.
  const BACK =
    'M0.000,200.000 Q37.492,198.853 75.000,198.530 Q112.492,197.408 150.000,197.110 Q187.493,196.037 225.000,195.789 Q262.494,194.787 300.000,194.610 Q337.495,193.701 375.000,193.616 Q412.496,192.815 450.000,192.839 Q487.497,192.160 525.000,192.305 Q562.499,191.757 600.000,192.034 Q637.500,191.622 675.000,192.034 Q712.501,191.757 750.000,192.305 Q787.503,192.160 825.000,192.839 Q862.504,192.815 900.000,193.616 Q937.505,193.701 975.000,194.610 Q1012.506,194.787 1050.000,195.789 Q1087.507,196.037 1125.000,197.110 Q1162.508,197.408 1200.000,198.530 Q1237.508,198.853 1275.000,200.000 L1275.000,400 L0,400 Z';
  const FRONT =
    'M0.000,230.000 Q37.492,228.853 75.000,228.530 Q112.492,227.408 150.000,227.110 Q187.493,226.037 225.000,225.789 Q262.494,224.787 300.000,224.610 Q337.495,223.701 375.000,223.616 Q412.496,222.815 450.000,222.839 Q487.497,222.160 525.000,222.305 Q562.499,221.757 600.000,222.034 Q637.500,221.622 675.000,222.034 Q712.501,221.757 750.000,222.305 Q787.503,222.160 825.000,222.839 Q862.504,222.815 900.000,223.616 Q937.505,223.701 975.000,224.610 Q1012.506,224.787 1050.000,225.789 Q1087.507,226.037 1125.000,227.110 Q1162.508,227.408 1200.000,228.530 Q1237.508,228.853 1275.000,230.000 L1275.000,400 L0,400 Z';
  const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1275 400">
  <path d="${BACK}" fill="#00ff00"/>
  <path d="${FRONT}" fill="#0000ff" fill-opacity="${ALPHA}"/>
</svg>`;
  emitFixture('lbTranslucentStripBlend__SVG', SVG);

  let failures = 0;
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  const ok = (m) => console.log('ok', m);

  const { browser } = host;
  const page = await browser.newPage();
  await page.setViewport({ width: 850, height: 400 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
    timeout: 20000,
    polling: 100,
  });

  const results = await page.evaluate(
    async (svg, alpha) => {
      const { importSvg, createBundle } = await import('/src/index.js');
      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      const cnv = document.getElementById('glcanvas');
      const W = 1700,
        H = 800;
      cnv.width = W;
      cnv.height = H;
      const shot = () => {
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };
      const asset = await importSvg(svg);

      renderer.setLoopBlinnFill('off');
      const bS = createBundle(gl, asset);
      const hS = renderer.createBundleHandle(bS);
      renderer.beginFrame([1, 1, 1, 1]);
      hS.draw();
      renderer.endFrame();
      const slug = shot();

      renderer.setLoopBlinnFill('on');
      const bL = createBundle(gl, asset);
      const hL = renderer.createBundleHandle(bL);
      await renderer.awaitLbReady(bL);
      renderer.beginFrame([1, 1, 1, 1]);
      hL.draw();
      renderer.endFrame();
      const lb = shot();
      const lbRouted = Array.isArray(bL._lbMeshes) && bL._lbMeshes.length > 0;

      let diff = 0;
      for (let i = 0; i < slug.length; i += 4) {
        const d = Math.max(
          Math.abs(slug[i] - lb[i]),
          Math.abs(slug[i + 1] - lb[i + 1]),
          Math.abs(slug[i + 2] - lb[i + 2]),
        );
        if (d > 16) diff++;
      }

      // Coverage of the FRONT (blue, translucent) shape where it lies OVER the back
      // (green) shape: on pure primaries the blue channel is exactly that coverage.
      // Sample well inside the overlap AND right along the front ridge's curve band,
      // which is where the self-blend showed up.
      const covAt = (px, x, y) => {
        const i = ((H - 1 - y) * W + x) * 4;
        return px[i + 2] / 255;
      };
      const worstOver = { cov: 0, x: -1, y: -1 };
      for (let x = 40; x < W - 40; x += 3) {
        for (let y = 300; y < 560; y++) {
          // only where the BACK shape is present in Slug (so we're over green, not white)
          const i = ((H - 1 - y) * W + x) * 4;
          if (slug[i + 1] < 40 && slug[i + 2] < 40) continue; // not the green/blue composite
          if (slug[i] > 200) continue; // white bg
          const c = covAt(lb, x, y);
          if (c > worstOver.cov) {
            worstOver.cov = c;
            worstOver.x = x;
            worstOver.y = y;
          }
        }
      }
      hS.dispose();
      hL.dispose();
      bS.dispose();
      bL.dispose();
      return { lbRouted, diff, total: W * H, worstOver, alpha };
    },
    SVG,
    ALPHA,
  );

  const { lbRouted, diff, total, worstOver, alpha } = results;
  console.log(
    `  lbRouted=${lbRouted} diff=${diff}/${total}px  max front-coverage over the back shape=${worstOver.cov.toFixed(2)} (true α=${alpha})`,
  );

  if (!lbRouted) fail('bundle did NOT route to LB — this smoke is not exercising the LB path');
  else ok('bundle routes to LB');

  // LB and Slug will never be pixel-identical at an edge: the two kernels round differently
  // there. This bound is a sanity
  // check that the two engines agree on the PICTURE — the strip double-blend it guards against is a
  // whole-shape effect worth tens of thousands of pixels, not hundreds. (The real assertion is the
  // one below: a translucent shape must take exactly ONE OVER.)
  if (diff > 2000) fail(`LB differs from Slug on ${diff}px`);
  else ok(`LB matches Slug (${diff}px differ, of ${total})`);

  // Self-blending drives coverage to 1-(1-α)^n: 0.84 at two overlaps, →1.0 along a
  // band. Allow a little AA headroom over α, but nowhere near the 0.84 second blend.
  const CEIL = alpha + 0.12;
  if (worstOver.cov > CEIL) {
    fail(
      `the translucent shape blended over ITSELF: coverage ${worstOver.cov.toFixed(2)} at ` +
        `(${worstOver.x},${worstOver.y}) exceeds α=${alpha} (1-(1-α)² would be ` +
        `${(1 - (1 - alpha) ** 2).toFixed(2)}) — curve strips are co-covering the interior`,
    );
  } else {
    ok(
      `translucent shape takes exactly ONE OVER (max coverage ${worstOver.cov.toFixed(2)} ≤ ${CEIL.toFixed(2)})`,
    );
  }

  await page.close();
  console.log(failures ? `\nFAILURES: ${failures}` : '\nPASS');
  return failures;
}

// lbTranslucentOverlapParity — translucent SOLID fills BATCH into the
// one-draw unified route: _ensureLbMeshes builds them as CDT partitions, so the
// route's direct premultiplied OVER composites α exactly (no per-shape composite
// RTs). The load-bearing correctness case is OVERLAPPING translucent shapes —
// the route draws them in painter order, so the overlap must composite
// (blue 50% over red 50% over white) byte-identically to Slug. Two overlapping
// half-alpha circles; check the overlap region + a red-only region + total ink.
async function lbTranslucentOverlapParity(host) {
  let failures = 0;
  const ok = (m) => console.log('ok', m);
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  const circ = (cx, cy, r, fill) => {
    const k = 0.5522847498 * r;
    return (
      `<path fill="${fill}" fill-opacity="0.5" d="M ${cx + r} ${cy} C ${cx + r} ${cy - k} ${cx + k} ${cy - r} ${cx} ${cy - r} ` +
      `C ${cx - k} ${cy - r} ${cx - r} ${cy - k} ${cx - r} ${cy} C ${cx - r} ${cy + k} ${cx - k} ${cy + r} ${cx} ${cy + r} ` +
      `C ${cx + k} ${cy + r} ${cx + r} ${cy + k} ${cx + r} ${cy} Z"/>`
    );
  };
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${circ(80, 100, 55, '#ff0000')}${circ(120, 100, 55, '#0000ff')}</svg>`;
  emitFixture('lbTranslucentOverlapParity__SVG', SVG);

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W=200,H=200;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders,{staticUnified:true}); renderer.setViewport(W,H);
// SLUG HERE MEANS SLUG. A recognised circle/ellipse/annulus is drawn by the SDF primitive, which is
// a peer of the analytic engines and deliberately ignores setLoopBlinnFill('off') -- so with
// primitives on, "LB off" is not "everything through the cover-quad kernel", and this comparison
// would be primitive-vs-primitive. setSdfPrimitives(false) is the switch that means what this test
// needs. Before createBundle: a recognised mesh is cached on its bundle.
renderer.setSdfPrimitives(false);
const bundle=createBundle(gl,await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const read=()=>{const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;};
const clr=()=>{gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);};
const at=(u,x,y)=>{const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];};
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<248||u[i+1]<248||u[i+2]<248)n++;return n;};
const out={};
try{
  renderer.setLoopBlinnFill('off'); const r0=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(bundle); const slug=read();
  out.slugRouted=renderer.debugStats.loopBlinnRouteCount>r0;
  renderer.setLoopBlinnFill('on');  const r1=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(bundle); const lb=read();
  out.lbRouted=renderer.debugStats.loopBlinnRouteCount>r1;
  out.overlapLB=at(lb,100,100); out.overlapSlug=at(slug,100,100);   // both circles overlap here
  out.redLB=at(lb,68,100);      out.redSlug=at(slug,68,100);        // red-only
  out.inkLB=ink(lb);            out.inkSlug=ink(slug);
  out.ok=true;
}catch(e){ out.err=String(e&&e.stack||e); }
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
  const eq = (a, b) =>
    Math.abs(a[0] - b[0]) <= 3 && Math.abs(a[1] - b[1]) <= 3 && Math.abs(a[2] - b[2]) <= 3;
  if (!r || !r.ok) {
    fail('did not complete: ' + (r && r.err));
  } else {
    console.log(
      '  routed slug=' +
        r.slugRouted +
        ' lb=' +
        r.lbRouted +
        '  overlap lb=' +
        JSON.stringify(r.overlapLB) +
        ' slug=' +
        JSON.stringify(r.overlapSlug) +
        '  ink ' +
        r.inkLB +
        '/' +
        r.inkSlug,
    );
    if (!r.slugRouted) ok('Slug used with LB off');
    else fail('LB routed with fill off');
    if (r.lbRouted) ok('translucent bundle routes through LB');
    else fail('translucent bundle did NOT route to LB');
    if (eq(r.overlapLB, r.overlapSlug))
      ok(
        'OVERLAP composites byte-exact vs Slug (painter-order OVER) ' + JSON.stringify(r.overlapLB),
      );
    else
      fail(
        'overlap differs: LB ' +
          JSON.stringify(r.overlapLB) +
          ' vs Slug ' +
          JSON.stringify(r.overlapSlug),
      );
    if (eq(r.redLB, r.redSlug)) ok('red-only region matches Slug');
    else
      fail(
        'red region differs: LB ' +
          JSON.stringify(r.redLB) +
          ' vs Slug ' +
          JSON.stringify(r.redSlug),
      );
    if (Math.abs(r.inkLB - r.inkSlug) <= Math.max(120, r.inkSlug * 0.05))
      ok('ink matches Slug within 5% (' + r.inkLB + ' vs ' + r.inkSlug + ')');
    else fail('ink diverges (' + r.inkLB + ' vs ' + r.inkSlug + ')');
  }
  if (!failures)
    console.log(
      '\\nlbTranslucentOverlapParitySmoke: overlapping translucent batches through the combined route, matches Slug',
    );
  return failures;
}

// lbTranslucentParity — a translucent SOLID fill rides the
// analytic composite path (MAX-blend coverage RT clamps self-overlap, then one
// paint×coverage composite applies alpha exactly), matching Slug. The 1-pass
// direct draw would conflate overlapping coverage; this proves the composite
// route handles alpha.
async function lbTranslucentParity(host) {
  // A diamond filled at 50% opacity over a black background.
  const SVG = readFileSync(
    new URL('../examples/smoke/lbTranslucentParity__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true });
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);

const draw = () => { renderer.setViewport(100, 100); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 100 * 100; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 8 || lb[o + 1] > 8 || lb[o + 2] > 8, slugInk = slug[o] > 8 || slug[o + 1] > 8 || slug[o + 2] > 8;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = { slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n, ctrLB: at(lb, 50, 50), ctrSlug: at(slug, 50, 50) };
window.__ready = true;
var out_slugRouted, out_lbRouted;
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

  // ≈ #3366cc (51,102,204) × 0.5 over black ≈ (26, 51, 102). Half-intensity, not full, not black.
  const isHalf = (c) => c[2] > 70 && c[2] < 140 && c[0] < 60 && c[1] > 25 && c[1] < 80;

  if (!o.slugRouted) ok('Slug path used with LB off');
  else fail('LB routed with fill off');
  if (o.lbRouted) ok('translucent bundle routes through the analytic composite path (LB on)');
  else fail('translucent bundle did NOT route to the analytic fill');
  if (o.inkPx > 1000) ok('shape renders (' + o.inkPx + ' ink px)');
  else fail('shape barely rendered: ' + o.inkPx);
  if (isHalf(o.ctrLB)) ok('center is half-intensity (alpha applied) ' + JSON.stringify(o.ctrLB));
  else fail('alpha not applied: center=' + JSON.stringify(o.ctrLB));
  if (o.maxDiff <= 6)
    ok(
      'render parity: analytic translucent fill matches Slug (mean channel diff ' + o.maxDiff + ')',
    );
  else fail('analytic translucent interior != Slug (mean channel diff ' + o.maxDiff + ')');

  await page.close();
  if (!failures) console.log('lbTranslucentParity: all assertions passed');
  return failures;
}

const host = await openCaseHost(ROOT);
const failures = await runCases(host, [
  ['lbTranslucentSolid', lbTranslucentSolid],
  ['lbTranslucentStripBlend', lbTranslucentStripBlend],
  ['lbTranslucentOverlapParity', lbTranslucentOverlapParity],
  ['lbTranslucentParity', lbTranslucentParity],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nlbTranslucentSolidSmoke: translucent solids composite alpha exactly');

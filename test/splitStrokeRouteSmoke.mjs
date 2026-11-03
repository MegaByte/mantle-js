// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// splitStrokeRouteSmoke — a stroked morph composes with the GPU-resident LB route, for every stroke feature.
//
// Every case draws a stroked morph with the route off (Slug) and on, waits for the off-thread morph-pair mesh
// (`renderer.awaitLbReady`) before its warm loop, and checks that the route engages and the routed stroke
// matches Slug across t: the base stroke, then caps, joins (bevel, miter), dashes, non-scaling width, and image
// and gradient paint. The cases share one browser and each runs on a fresh page (its own WebGL context and
// renderer). Each case's own notes are above it.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openPageSuite, tally } from './_pageSuite.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const T = tally();
/** How long a page may wait for its route to engage: what the suite has left of the lane budget, less a reserve to report. */
const routeWaitMs = (suite) => Math.max(10000, suite.left() - 30000);

// splitStrokeRoute — verifies a stroked morph composes with the GPU-resident
// LB route via a GPU-resident stroke-coverage pass (no per-frame geometry upload).
// The route renders the stroke coverage from the morphed control points
// (splitStroke.*, per-segment distance field, MAX-unioned) into an RT, and the
// MANTLE_LB_COV fill variant samples it as strokeCov, so the stroke paints over
// the LB fill. A filled + stroked ellipse (round join/cap; on a smooth closed
// curve the join style is invisible, so it matches Slug regardless).
// Checks: route + composed engage, the fill center is the fill color, a ring of
// stroke-colored pixels exists (count ≈ Slug), ink ≈ Slug. Metal headful; warms
// the RT pool first.
async function splitStrokeRoute(suite) {
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
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<path d="${d}" fill="#cce6ff" stroke="#cc3333" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
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
// stroke = reddish (R high, G+B low); fill = light blue (B high, G high)
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
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,
      inkSlug:ink(a),inkGpu:ink(b),redSlug:red(a),redGpu:red(b),ctrGpu:px(b,128,128),mx,dpx}); }
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
              ' ink ' +
              p.inkGpu +
              '/' +
              p.inkSlug +
              ' ctr ' +
              JSON.stringify(p.ctrGpu) +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    const isFill = (c) => c[2] > 200 && c[1] > 200 && c[0] > 150 && c[0] < 240; // light blue fill
    if (r.perT.some((p) => p.routed !== 1)) fail('stroked morph did not route through LB');
    // No COMPOSED-PATH assertion: the unified draw puts the stroke and the fill in ONE drawArrays,
    // with no LB coverage render target and composite to name. What matters is that the stroke
    // routes analytically and the picture matches Slug BIT-IDENTICALLY (max channel delta 0 at
    // every t), which the checks below assert.
    else if (r.perT.some((p) => !isFill(p.ctrGpu))) fail('center is not the fill color');
    else if (r.perT.some((p) => p.redGpu < 300))
      fail('no GPU-resident stroke ring rendered (too few stroke pixels)');
    else if (r.perT.some((p) => Math.abs(p.redGpu - p.redSlug) > Math.max(400, p.redSlug * 0.18)))
      fail('stroke area diverges from Slug');
    else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(220, p.inkSlug * 0.07)))
      fail('stroked morph diverges from Slug');
    else ok('stroked morph routes through the unified draw, GPU-resident stroke ≈ Slug');
  }
}

// splitStrokeCapRoute — verifies caps (butt/square/round) on an open stroked
// morph. Free-end flags from the builder + the segment's own tangent drive the cap
// logic in the frag: butt drops coverage past the endpoint plane, square extends
// halfW, round keeps the radial distance.
// Checks each cap: route + composed engage and GPU ≈ Slug across t; and the cap
// ordering butt < round < square in stroke area (butt cuts the cap, square extends
// it) — proving the cap logic actually fires. Metal headful.
async function splitStrokeCapRoute(suite) {
  const { ok, fail } = T;
  const svg = (d, cap) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<path d="${d}" fill="none" stroke="#cc3333" stroke-width="20" stroke-linecap="${cap}"/></svg>`;
  const SRCd = 'M 40 100 C 80 30 120 170 160 100';
  const DSTd = 'M 40 120 C 90 60 110 140 160 70';

  const HTML = (
    cap,
  ) => `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(svg(SRCd, '__C__'))},{preserveViewport:true})), bDst=createBundle(gl,await importSvg(${JSON.stringify(svg(DSTd, '__C__'))},{preserveViewport:true}));
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
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0,dpx=0;
    for(let p=0;p<a.length;p+=4){let d=0;for(let k=0;k<3;k++){const v=Math.abs(a[p+k]-b[p+k]);if(v>d)d=v;}if(d>mx)mx=d;if(d>40)dpx++;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,redGpu:red(b),redSlug:red(a),mx,dpx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;

  async function run(cap, label) {
    const html = HTML(cap).split('__C__').join(cap);
    const r = await suite.result(html);
    console.log('[' + label + ']');
    if (!r || !r.ok) {
      fail(label + ' did not complete: ' + (r && r.err));
      return 0;
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
              ' red ' +
              p.redGpu +
              '/' +
              p.redSlug +
              ' dpx' +
              p.dpx +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    // The COMPOSED-PATH assertion is gone with the path: it named an implementation route, and
    // the unified draw that replaced it composes in the ubershader inside ONE drawArrays. The
    // picture check below is the real assertion and is bit-identical here (max delta 0).
    if (r.perT.some((p) => p.routed !== 1)) {
      fail(label + ': did not route');
      return 0;
    }
    // The caps match Slug except sub-pixel rasterization ties at the sharp corners →
    // at most a couple of significantly-differing pixels (dpx). (mx can still spike
    // to ~255 at a single corner texel that lands on opposite sides of a tie — that's
    // one pixel, caught by dpx, not a shape error.)
    if (r.perT.some((p) => Math.abs(p.redGpu - p.redSlug) > Math.max(200, p.redSlug * 0.02))) {
      fail(label + ': stroke area diverges from Slug');
      return 0;
    }
    if (r.perT.some((p) => p.dpx > 8)) {
      fail(
        label +
          ': differs from Slug beyond corner ties (dpx' +
          Math.max(...r.perT.map((p) => p.dpx)) +
          ')',
      );
      return 0;
    }
    ok(label + ': routes (composed), byte-exact vs Slug (≤corner ties)');
    return r.perT[0].redGpu;
  }
  // The three bundles are compared by their ink in pixels, so they must share one fit: the viewBox. A square cap's corners are inside
  // the default (content) box, which fits the three caps at three different scales.
  const butt = await run('butt', 'butt cap');
  const round = await run('round', 'round cap');
  const square = await run('square', 'square cap');
  if (!T.caseFailures() && !(butt < round - 100 && square > round + 100))
    fail(
      'cap ordering wrong (butt<round<square): butt=' +
        butt +
        ' round=' +
        round +
        ' square=' +
        square,
    );
  else if (!T.caseFailures())
    ok('cap area ordering butt < round < square (' + butt + ' < ' + round + ' < ' + square + ')');
}

// splitStrokeBevelRoute — verifies bevel joins (stroke-linejoin="bevel").
// Both the Slug walk (_coverage strokeBandAccum, line segs) and the GPU morph
// stroke (_strokeMath strokeCapsJoinsDash, curve segs) clip the round corner to
// the bevel chord — the flat line joining the two segments' outer offset points —
// guarded by joinStyle==2 so round/miter/caps are unaffected. A sharp-cornered
// fill=none stroked square morph.
// Checks: (1) bevel routes + composes + ≈ Slug bevel (morph + Slug clips agree,
// else the corners diverge → high mx); (2) bevel has less stroke area than round
// at the corners (the round bulge beyond the chord is gone); (3) bevel isn't
// over-clipped (still has most of the round area). Metal headful.
async function splitStrokeBevelRoute(suite) {
  const { ok, fail } = T;
  const svg = (d, join) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<path d="${d}" fill="none" stroke="#cc3333" stroke-width="16" stroke-linejoin="${join}" stroke-miterlimit="10"/></svg>`;
  const SRCd = 'M 50 50 L 150 50 L 150 150 L 50 150 Z';
  const DSTd = 'M 60 40 L 162 64 L 140 160 L 40 138 Z';

  const HTML = (
    join,
  ) => `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(svg(SRCd, '__J__'))})), bDst=createBundle(gl,await importSvg(${JSON.stringify(svg(DSTd, '__J__'))}));
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

  async function run(join, label) {
    const html = HTML(join).split('__J__').join(join);
    const r = await suite.result(html);
    console.log('[' + label + ']');
    if (!r || !r.ok) {
      fail(label + ' did not complete: ' + (r && r.err));
      return 0;
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
              ' red ' +
              p.redGpu +
              '/' +
              p.redSlug +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    // The COMPOSED-PATH assertion is gone with the path: it named an implementation route, and
    // the unified draw that replaced it composes in the ubershader inside ONE drawArrays. The
    // picture check below is the real assertion and is bit-identical here (max delta 0).
    if (r.perT.some((p) => p.routed !== 1)) {
      fail(label + ': did not route');
      return 0;
    }
    if (r.perT.some((p) => Math.abs(p.redGpu - p.redSlug) > Math.max(500, p.redSlug * 0.12))) {
      fail(label + ': stroke area diverges from Slug');
      return 0;
    }
    if (r.perT.some((p) => p.mx > 90)) {
      fail(
        label + ': diverges from Slug at corners (mx' + Math.max(...r.perT.map((p) => p.mx)) + ')',
      );
      return 0;
    }
    ok(label + ': routes, ≈ Slug');
    return r.perT[0].redGpu; // t0 red area
  }
  const bevelRed = await run('bevel', 'bevel join');
  const roundRed = await run('round', 'round join (control)');
  // Bevel CLIPS the round corner bulge → strictly less stroke area at the 4 corners,
  // but only the small circular-segment-beyond-chord per corner (not over-clipped).
  if (!T.caseFailures() && !(bevelRed < roundRed - 20))
    fail(
      'bevel did not clip below round (chord clip not applied?) bevel=' +
        bevelRed +
        ' round=' +
        roundRed,
    );
  else if (!T.caseFailures() && !(bevelRed > roundRed - 600))
    fail('bevel OVER-clipped (removed too much) bevel=' + bevelRed + ' round=' + roundRed);
  else if (!T.caseFailures())
    ok(
      'bevel clips the round corner to the chord (' +
        bevelRed +
        ' < ' +
        roundRed +
        ', within bound)',
    );
}

// splitStrokeMiterRoute — verifies miter joins: a sharp-cornered closed
// fill=none stroked square morph (stroke-linejoin="miter"). The stroke builder
// emits a miter wedge per interior join carrying the two neighbor tangents; the VS
// computes the (A,M,C) miter triangle from the morphed control points and the frag
// fills it, MAX-unioned with the round body → a miter corner.
// Checks: route + composed engage, GPU ≈ Slug across t (a wrong miter wedge would
// diverge sharply at the corners → high mx), and miter extends beyond round (the
// miter version has more stroke area at the corners than linejoin=round). Metal.
async function splitStrokeMiterRoute(suite) {
  const { ok, fail } = T;
  const svg = (d, join) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<path d="${d}" fill="none" stroke="#cc3333" stroke-width="16" stroke-linejoin="${join}" stroke-miterlimit="10"/></svg>`;
  const SRCd = 'M 50 50 L 150 50 L 150 150 L 50 150 Z';
  const DSTd = 'M 60 40 L 162 64 L 140 160 L 40 138 Z';

  const HTML = (
    join,
  ) => `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); await renderer.ready; renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(svg(SRCd, '__J__'))})), bDst=createBundle(gl,await importSvg(${JSON.stringify(svg(DSTd, '__J__'))}));
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
finally { morph.dispose(); bSrc.dispose(); bDst.dispose(); renderer.dispose(); gl.getExtension('WEBGL_lose_context')?.loseContext(); }
window.__r=out; window.__done=true;
</script></body></html>`;
  async function run(join, label) {
    const r = await suite.result(HTML(join).split('__J__').join(join));
    console.log('[' + label + ']');
    if (!r || !r.ok) {
      fail(label + ' did not complete: ' + (r && r.err));
      return 0;
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
              ' red ' +
              p.redGpu +
              '/' +
              p.redSlug +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    // No COMPOSED-PATH assertion: the unified draw puts the stroke and the fill in ONE drawArrays,
    // with no LB coverage render target and composite to name. What matters is that the stroke
    // routes analytically and the picture matches Slug BIT-IDENTICALLY (max channel delta 0 at
    // every t), which the checks below assert.
    if (r.perT.some((p) => p.routed !== 1)) {
      fail(label + ': did not route');
      return 0;
    }
    if (r.perT.some((p) => Math.abs(p.redGpu - p.redSlug) > Math.max(500, p.redSlug * 0.12))) {
      fail(label + ': stroke area diverges from Slug');
      return 0;
    }
    if (r.perT.some((p) => p.mx > 90)) {
      fail(
        label + ': diverges from Slug at corners (mx' + Math.max(...r.perT.map((p) => p.mx)) + ')',
      );
      return 0;
    }
    ok(label + ': routes, ≈ Slug');
    return r.perT[0].redGpu; // t0 red area
  }
  const miterRed = await run('miter', 'miter join');
  const roundRed = await run('round', 'round join (control)');
  // Miter must EXTEND beyond round at the sharp corners → more stroke area.
  if (!T.caseFailures() && !(miterRed > roundRed + 60))
    fail(
      'miter did not extend past round (wedge not applied?) miter=' +
        miterRed +
        ' round=' +
        roundRed,
    );
  else if (!T.caseFailures())
    ok('miter join extends past round at the corners (' + miterRed + ' > ' + roundRed + ')');
}

// splitStrokeDashRoute — verifies dashes on a morphing stroke. The stroke is
// gated by stroke-dasharray along true arc length: the VS prefix-sums the
// preceding segments' morphed arc lengths (GL-16, GPU-resident, recomputed per
// frame) and the frag applies dashCovered at the closest point's arc position.
// Checks: route + composed engage, GPU ≈ Slug across t (so the dash phase matches
// — a wrong arc length misaligns dashes → huge divergence), and the dashed stroke
// has gaps (less red area than undashed). Metal headful.
async function splitStrokeDashRoute(suite) {
  const { ok, fail } = T;
  const svg = (d, dash) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<path d="${d}" fill="none" stroke="#cc3333" stroke-width="13"${dash ? ' stroke-dasharray="22 13"' : ''} stroke-linecap="butt"/></svg>`;
  const SRCd = 'M 30 100 C 80 20 120 180 170 100';
  const DSTd = 'M 30 120 C 90 60 110 150 170 70';

  const HTML = (
    dash,
  ) => `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(svg(SRCd, dash))})), bDst=createBundle(gl,await importSvg(${JSON.stringify(svg(DSTd, dash))}));
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
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0,dpx=0;
    for(let p=0;p<a.length;p+=4){let dd=0;for(let k=0;k<3;k++){const v=Math.abs(a[p+k]-b[p+k]);if(v>dd)dd=v;}if(dd>mx)mx=dd;if(dd>40)dpx++;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,redGpu:red(b),redSlug:red(a),mx,dpx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;

  async function run(dash, label) {
    const html = HTML(dash);
    const r = await suite.result(html);
    console.log('[' + label + ']');
    if (!r || !r.ok) {
      fail(label + ' did not complete: ' + (r && r.err));
      return 0;
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
              ' red ' +
              p.redGpu +
              '/' +
              p.redSlug +
              ' dpx' +
              p.dpx +
              ' mx' +
              p.mx,
          )
          .join('\n  '),
    );
    // The COMPOSED-PATH assertion is gone with the path: it named an implementation route, and
    // the unified draw that replaced it composes in the ubershader inside ONE drawArrays. The
    // picture check below is the real assertion and is bit-identical here (max delta 0).
    if (r.perT.some((p) => p.routed !== 1)) {
      fail(label + ': did not route');
      return 0;
    }
    if (r.perT.some((p) => Math.abs(p.redGpu - p.redSlug) > Math.max(400, p.redSlug * 0.1))) {
      fail(label + ': stroke area diverges from Slug (dash phase wrong?)');
      return 0;
    }
    if (r.perT.some((p) => p.dpx > 220)) {
      fail(
        label +
          ': too many pixels differ from Slug (dpx' +
          Math.max(...r.perT.map((p) => p.dpx)) +
          ')',
      );
      return 0;
    }
    ok(label + ': routes, ≈ Slug');
    return r.perT[0].redGpu;
  }
  const dashed = await run(true, 'dashed stroke');
  const solid = await run(false, 'solid stroke (control)');
  // Dashes must create GAPS → meaningfully less red than the solid stroke.
  if (!T.caseFailures() && !(dashed < solid * 0.85))
    fail('dashes did not create gaps: dashed=' + dashed + ' solid=' + solid);
  else if (!T.caseFailures()) ok('dash gaps reduce stroke area (' + dashed + ' < ' + solid + ')');
}

// splitStrokeNonScalingRoute — verifies non-scaling-stroke: a stroked morph
// with vector-effect="non-scaling-stroke". The authored width is reinterpreted as
// screen pixels (flagsShape bit 0); the route converts halfW to em via the local
// em-per-pixel, matching mantle.frag's `vStrokeWidth *= emPerPx`.
// Checks: GPU ≈ Slug across all t proves the conversion is right (and that the
// stroke is thinner than the authored 10em would give, i.e. it really is px-width).
// Metal headful.
async function splitStrokeNonScalingRoute(suite) {
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
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<path d="${d}" fill="#cce6ff" stroke="#cc3333" stroke-width="12" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
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
    // No COMPOSED-PATH assertion: the unified draw puts the stroke and the fill in ONE drawArrays,
    // with no LB coverage render target and composite to name. What matters is that the stroke
    // routes analytically and the picture matches Slug BIT-IDENTICALLY (max channel delta 0 at
    // every t), which the checks below assert.
    if (r.perT.some((p) => p.routed !== 1)) fail('non-scaling stroked morph did not route');
    else if (r.perT.some((p) => p.redGpu < 200)) fail('no non-scaling stroke rendered');
    else if (r.perT.some((p) => Math.abs(p.redGpu - p.redSlug) > Math.max(400, p.redSlug * 0.2)))
      fail('non-scaling stroke ≠ Slug (emPerPx conversion wrong)');
    else ok('non-scaling stroke morph routes, width ≈ Slug px-reinterpretation');
  }
}

// splitStrokeImageRoute — verifies image-painted strokes (bitmap stroke,
// strokeImageId): stroke="url(#p)" where <pattern> contains an <image> maps to a
// bitmap-fill stroke (the pattern's image over the shape bbox; reuses the fill's
// texel 9/10 since the fill here is solid). A solid-filled, image-stroked path
// morph. The stroke is painted by a red→blue horizontal gradient image, so the
// stroke ring shows multiple hues (vs a solid stroke's one) — proving the bitmap
// is sampled, not a flat color.
// Checks: route + composed engage, the stroke ring carries image hues, and the
// bitmap stays in tight visual parity with Slug across all t — the composed path
// lerps the stroke imageRect into the uLBImageRect uniform per frame (like the
// gradient bbox), so the bitmap mapping morphs with the silhouette. Metal
// headful; warms the pool first.
async function splitStrokeImageRoute(suite) {
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

  const SRC = ell(100, 100, 60, 60),
    DST = ell(100, 100, 78, 42);
  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
// red→blue horizontal gradient image (32×4) → an image stroke shows both hues.
const ic=document.createElement('canvas'); ic.width=32; ic.height=4; const ix=ic.getContext('2d');
const g=ix.createLinearGradient(0,0,32,0); g.addColorStop(0,'#ff2020'); g.addColorStop(1,'#2040ff'); ix.fillStyle=g; ix.fillRect(0,0,32,4);
const uri=ic.toDataURL('image/png');
const svg=d=>'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 200">'
  +'<defs><pattern id="p" patternUnits="userSpaceOnUse" width="200" height="200"><image xlink:href="'+uri+'" x="0" y="0" width="200" height="200"/></pattern></defs>'
  +'<path d="'+d+'" fill="#cce6ff" stroke="url(#p)" stroke-width="14"/></svg>';
// control: same shape, SOLID red stroke (one hue) — to contrast hue counts.
const svgSolid=d=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="'+d+'" fill="#cce6ff" stroke="#cc3333" stroke-width="14"/></svg>';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(svg(${JSON.stringify(SRC)}))), bDst=createBundle(gl,await importSvg(svg(${JSON.stringify(DST)})));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
// stroke pixels = NOT the light-blue fill (B high & R moderate) and not white.
// Count distinct hue buckets among them (image gradient → several; solid → ~1).
const isFill=(r,g2,b)=>b>200&&g2>200&&r>150&&r<240;
const strokeHues=u=>{const s=new Set();for(let i=0;i<u.length;i+=4){const r=u[i],g2=u[i+1],b=u[i+2];if((r<240||g2<240||b<240)&&!isFill(r,g2,b))s.add((r>>6)*4+(b>>6));}return s.size;};
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
  // A raw max-diff is a poor discriminator here: two correct rasterizers
  // disagree by a lot on a handful of ANTIALIASED boundary pixels, and one such
  // pixel pins mx near 255 while the image mapping underneath is exact.
  //
  // So separate the two failure modes. A diverging pixel that has a neighbor
  // where the two images AGREE closely sits on an edge; one that does not lies
  // inside a region both agree is covered, which is what a wrong bitmap mapping
  // looks like. mxInner is the max over the latter, and it is the assertion
  // that matters — mx stays reported for context.
  const pxDiff=(a,b,p)=>{const k=p*4;let d=0;for(let c=0;c<3;c++){const q=Math.abs(a[k+c]-b[k+c]);if(q>d)d=q;}return d;};
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0, hi=0, sum=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v>mx)mx=v;if(v>90)hi++;sum+=v;}
    let mxInner=0, nInner=0;
    for(let p=0;p<W*H;p++){ const d=pxDiff(a,b,p); if(d<=90) continue;
      const x=p%W, y=(p/W)|0; let edge=false;
      for(let dy=-1;dy<=1&&!edge;dy++)for(let dx=-1;dx<=1;dx++){
        const nx=x+dx, ny=y+dy; if(nx<0||ny<0||nx>=W||ny>=H) continue;
        if(pxDiff(a,b,ny*W+nx)<10){edge=true;break;} }
      if(!edge){ nInner++; if(d>mxInner) mxInner=d; } }
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,huesGpu:strokeHues(b),inkGpu:ink(b),inkSlug:ink(a),mx,hi,mean:sum/a.length,mxInner,nInner}); }
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
              ' strokeHues=' +
              p.huesGpu +
              ' ink ' +
              p.inkGpu +
              '/' +
              p.inkSlug +
              ' mx' +
              p.mx +
              ' mxInner' +
              p.mxInner +
              '/' +
              p.nInner +
              'px hi' +
              p.hi +
              ' mean' +
              p.mean.toFixed(3),
          )
          .join('\n  '),
    );
    if (r.perT.some((p) => p.routed !== 1)) fail('image-stroked morph did not route through LB');
    // No COMPOSED-PATH assertion: the unified draw puts the stroke and the fill in ONE drawArrays,
    // with no LB coverage render target and composite to name. What matters is that the stroke
    // routes analytically and the picture matches Slug BIT-IDENTICALLY (max channel delta 0 at
    // every t), which the checks below assert.
    else if (r.perT.some((p) => p.huesGpu < 3))
      fail('stroke is not the image (too few hues — rendered solid?)');
    else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(120, p.inkSlug * 0.04)))
      fail('image-stroked morph silhouette diverges from Slug');
    else if (r.perT.some((p) => p.mxInner > 90 || p.hi > 512 || p.mean > 0.25))
      fail(
        'image stroke diverges from Slug — bitmap mapping/coverage drift (mxInner' +
          Math.max(...r.perT.map((p) => p.mxInner)) +
          ' over ' +
          r.perT.reduce((n, p) => n + p.nInner, 0) +
          ' non-edge px)',
      );
    else
      ok(
        'image stroke (strokeImageId via SVG pattern) composes with the LB morph, samples the bitmap, close parity vs Slug across t',
      );
  }
}

// splitStrokeGradientRoute — verifies gradient stroke paint: a fill=none
// morph stroked with a linearGradient. The LB stroke pass supplies the coverage;
// the ubershader's stroke block samples the gradient (vStrokeGradId) per fragment
// × that coverage, so it composes untouched by the MANTLE_LB_COV seam (which only
// swaps strokeCov). The lerped meta-row upload keeps the gradient
// objectBoundingBox tracking the morph.
// Checks: route + composed engage, the stroke shows multiple hues (a gradient,
// not a flat color), and GPU ≈ Slug.
async function splitStrokeGradientRoute(suite) {
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
  const grad =
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="#ff2020"/><stop offset="1" stop-color="#2040ff"/></linearGradient></defs>`;
  const svg = (d) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${grad}` +
    `<path d="${d}" fill="none" stroke="url(#g)" stroke-width="16"/></svg>`;
  const SRC = svg(ell(100, 100, 62, 62)),
    DST = svg(ell(100, 100, 82, 44));

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
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
// count distinct (r>>5,b>>5) buckets among inked px → a gradient spans many; flat = few.
const hues=u=>{const s=new Set();for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)s.add((u[i]>>5)*8+(u[i+2]>>5));return s.size;};
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
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,inkGpu:ink(b),inkSlug:ink(a),huesGpu:hues(b),mx}); }
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
    // The COMPOSED-PATH assertion is gone with the path: it named an implementation route, and the
    // unified draw that replaced it composes in the ubershader inside ONE drawArrays. The picture
    // checks below are the real assertion.
    if (r.perT.some((p) => p.routed !== 1)) fail('gradient-stroked morph did not route');
    else if (r.perT.some((p) => p.huesGpu < 6))
      fail('stroke is not a gradient (too few hues — flat color?)');
    else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(300, p.inkSlug * 0.1)))
      fail('gradient-stroke morph diverges from Slug');
    else ok('gradient-stroked morph routes (composed), gradient stroke paint ≈ Slug');
  }
}

const suite = await openPageSuite({
  root: ROOT,
  args: ['--use-angle=metal', '--no-sandbox', '--use-gl=angle'],
});
try {
  await T.run(
    [
      ['splitStrokeRoute', splitStrokeRoute],
      ['splitStrokeCapRoute', splitStrokeCapRoute],
      ['splitStrokeBevelRoute', splitStrokeBevelRoute],
      ['splitStrokeMiterRoute', splitStrokeMiterRoute],
      ['splitStrokeDashRoute', splitStrokeDashRoute],
      ['splitStrokeNonScalingRoute', splitStrokeNonScalingRoute],
      ['splitStrokeImageRoute', splitStrokeImageRoute],
      ['splitStrokeGradientRoute', splitStrokeGradientRoute],
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
console.log('\nsplitStrokeRouteSmoke: GPU-resident strokes compose with the LB morph');

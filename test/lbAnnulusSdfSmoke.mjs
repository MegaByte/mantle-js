// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbAnnulusSdfSmoke — circles and rings take the exact circular / annulus SDF (kind 7) on the
// Loop-Blinn route instead of per-arc crescents, so they are seam-free and match Slug at small
// render sizes:
//   lbAnnulusSdf        a concentric ring of cubics (opposite-wound: a hole under nonzero)
//   lbMorphEvenOdd      a morph between two rings that are rings only by the even-odd rule
//   lbCircleSdf         a filled circle, including at its horizontal and vertical tangents
//   lbAnnulusEvenOdd    a ring of two same-wound circles that is a ring only by the even-odd rule
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openReady } from './_pageReady.mjs';
import { emitFixture } from './_fixtures.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// lbAnnulusSdf — a CONCENTRIC circular RING built from CUBIC beziers (like
// the pause-menu how-to-play "?" ring) renders through the exact annulus SDF (kind
// 7), NOT per-≤90° cubic crescents: at SMALL render scale it's seam-free AND free of
// the wide-AA-ramp "wedge" the crescent path smears there, matching Slug everywhere.
async function lbAnnulusSdf(host) {
  // cubic-bezier circle (4×90° arcs), CCW; k = r·4/3·tan(π/8).
  function circlePath(cx, cy, r, ccw) {
    const k = r * 0.5522847498,
      dirs = ccw ? [0, 1, 2, 3] : [0, 3, 2, 1];
    const pt = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const tan = (a) => [(ccw ? -1 : 1) * Math.sin(a), (ccw ? 1 : -1) * Math.cos(a)];
    let d = '';
    for (let i = 0; i < 4; i++) {
      const a0 = (dirs[i] * Math.PI) / 2,
        a1 = (dirs[(i + 1) % 4] * Math.PI) / 2 + (ccw ? 0 : i === 3 ? -2 * Math.PI : 0);
      const p0 = pt(a0),
        p3 = pt(a1),
        t0 = tan(a0),
        t1 = tan(a1);
      const p1 = [p0[0] + k * t0[0], p0[1] + k * t0[1]],
        p2 = [p3[0] - k * t1[0], p3[1] - k * t1[1]];
      d +=
        (i === 0 ? `M${p0[0].toFixed(2)} ${p0[1].toFixed(2)} ` : '') +
        `C${p1[0].toFixed(2)} ${p1[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)} ${p3[0].toFixed(2)} ${p3[1].toFixed(2)} `;
    }
    return d + 'Z';
  }
  const R = 44; // small render size — where the wedge shows
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44"><path fill="#000000" d="${circlePath(22, 22, 18, true)} ${circlePath(22, 22, 12, false)}"/></svg>`;
  emitFixture('lbAnnulusSdf__SVG', SVG);

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${R}" height="${R}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
// REFERENCE = AAC (exact signed-area coverage). Slug and LB share the same exactBoxCov
// kernel, so "LB matches Slug" does not prove either is right.
// Create the AAC reference FIRST: the LAST-created renderer owns the global off-thread
// LB builder, and a Slug-only renderer would suppress the worker build (leaving the
// bundle Slug forever). Keep the LB renderer created last so createBundle kicks the LB build.
const refR = createRenderer(gl, shaders, { staticUnified: true, aacFill: true }); refR.setViewport(${R}, ${R}); refR.setLoopBlinnFill('off');
const renderer = createRenderer(gl, shaders, { staticUnified: true }); renderer.setViewport(${R}, ${R});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);
await renderer.awaitLbReady(bundle);   // LB builds off-thread; wait before asserting the route
const read = () => { const px = new Uint8Array(${R}*${R}*4); gl.readPixels(0,0,${R},${R},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const cov = (px,x,y) => { const q = ((${R}-1-y)*${R}+x)*4; return (255-px[q])/255; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame(); return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const drawRef = () => { refR.beginFrame([1,1,1,1]); refR.drawBundle(bundle); refR.endFrame(); return { px: read(), routed: 1 }; };
const slug = drawRef(), lb = draw('on');
let worst=0, sum=0, n=0, hole=1;
for (let y=0;y<${R};y++) for (let x=0;x<${R};x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if ((s>0.02&&s<0.98)||(l>0.02&&l<0.98)){ const e=Math.abs(s-l); if(e>worst)worst=e; sum+=e; n++; } }
hole = cov(lb.px, 22, 22);   // ring center must stay EMPTY
window.__out = { lbRouted: lb.routed, worst:+worst.toFixed(3), mean:+(sum/Math.max(n,1)).toFixed(3), hole:+hole.toFixed(2) };
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
  if (o.lbRouted) ok('ring routes through LB');
  else fail('ring did NOT route to LB');
  if (o.hole < 0.05) ok('ring hole stays empty (' + o.hole + ')');
  else fail('ring hole filled (' + o.hole + ')');
  if (o.worst <= 0.06)
    ok(
      'ring matches the exact reference at every boundary pixel (worst ' +
        o.worst +
        ') — annulus SDF, no wedge/seam',
    );
  else
    fail(
      'ring boundary diverges from the exact reference (worst ' +
        o.worst +
        ') — crescent wedge/seam?',
    );
  if (o.mean <= 0.015) ok('mean boundary error ' + o.mean);
  else fail('mean boundary error too high (' + o.mean + ')');

  await page.close();
  if (!failures)
    console.log('lbAnnulusSdf: cubic circular ring is wedge/seam-free (kind-7 annulus SDF)');
  return failures;
}

// lbMorphEvenOdd — a morph between two rings that are rings only because of the even-odd rule
// (same-wound circles): every drawn pose keeps its hole empty.
async function lbMorphEvenOdd(host) {
  // cubic-bezier circle (4×90° arcs), CCW; k = r·4/3·tan(π/8).
  function circlePath(cx, cy, r, ccw) {
    const k = r * 0.5522847498,
      dirs = ccw ? [0, 1, 2, 3] : [0, 3, 2, 1];
    const pt = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const tan = (a) => [(ccw ? -1 : 1) * Math.sin(a), (ccw ? 1 : -1) * Math.cos(a)];
    let d = '';
    for (let i = 0; i < 4; i++) {
      const a0 = (dirs[i] * Math.PI) / 2,
        a1 = (dirs[(i + 1) % 4] * Math.PI) / 2 + (ccw ? 0 : i === 3 ? -2 * Math.PI : 0);
      const p0 = pt(a0),
        p3 = pt(a1),
        t0 = tan(a0),
        t1 = tan(a1);
      const p1 = [p0[0] + k * t0[0], p0[1] + k * t0[1]],
        p2 = [p3[0] - k * t1[0], p3[1] - k * t1[1]];
      d +=
        (i === 0 ? `M${p0[0].toFixed(2)} ${p0[1].toFixed(2)} ` : '') +
        `C${p1[0].toFixed(2)} ${p1[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)} ${p3[0].toFixed(2)} ${p3[1].toFixed(2)} `;
    }
    return d + 'Z';
  }
  const R = 96;
  // TWO POSES, both rings only because of the fill rule. Same topology (two same-wound circles,
  // four cubics each), different radii — so the morph pairs one to one and every intermediate pose
  // is a ring too.
  const ringSvg = (ro, ri) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44"><path fill="#000000" fill-rule="evenodd" d="${circlePath(22, 22, ro, true)} ${circlePath(22, 22, ri, true)}"/></svg>`;
  const SRC = ringSvg(18, 12),
    DST = ringSvg(15, 5);
  emitFixture('lbMorphEvenOdd__SRC', SRC);
  emitFixture('lbMorphEvenOdd__DST', DST);

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${R}" height="${R}"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, depth:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(${R}, ${R});
renderer.setLoopBlinnFill('on');
const bSrc = createBundle(gl, await importSvg(${JSON.stringify(SRC)}));
const bDst = createBundle(gl, await importSvg(${JSON.stringify(DST)}));
const morph = createShapeMorph(gl, bSrc, bDst);
if (renderer.awaitLbReady) await renderer.awaitLbReady(morph);
// WHAT THIS DOES AND DOES NOT CATCH. It asserts an even-odd morph keeps its hole at every t, which
// nothing else covers. It does NOT discriminate the fill-rule threading in buildEarcutPair:
// without that threading it stays green, because a failed earcut pair falls through to
// buildLoopBlinnPartitionPair, which is handed the rule. Every such omission is masked the same
// way -- by a fallback that carries the rule -- so it is latent, and threading the rule removes
// wasted work rather than wrong pixels.
//
// THE HOLE IS THE ASSERTION. A pose built as nonzero fills the ring solid, because two same-wound
// circles are only a hole under even-odd — so a centre pixel that goes dark at ANY t means a pose
// lost the rule. Checked across t, since the two poses are built by different code paths (src
// builds, dst refreshes off it).
const out = [];
for (const t of [0, 0.25, 0.5, 0.75, 1]) {
  morph.setT(t);
  gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  renderer.drawBundle(morph);
  const px = new Uint8Array(${R}*${R}*4);
  gl.readPixels(0,0,${R},${R},gl.RGBA,gl.UNSIGNED_BYTE,px);
  const at = (x,y) => { const i = ((${R}-1-y)*${R}+x)*4; return 1 - px[i]/255; };
  let ink = 0; for (let i=0;i<px.length;i+=4) if (px[i] < 128) ink++;
  out.push({ t, hole: +at(${R}>>1, ${R}>>1).toFixed(3), ink });
}
window.__out = { poses: out };
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
  page.on('pageerror', (e) => fail('page: ' + e.message));
  let o = null;
  try {
    await page.goto(host.page(HTML), { waitUntil: 'load' });
    // POLL ON A TIMER, NOT ON rAF. waitForFunction defaults to polling inside requestAnimationFrame,
    // and a headless page that is not presenting frames never runs one -- so the predicate is never
    // evaluated and this waits out the full timeout however well the render went: a page that has
    // drawn all five poses, counted their ink and set window.__ready still reads as a timeout.
    await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
    o = await page.evaluate(() => window.__out);
    console.log('  ' + JSON.stringify(o.poses));
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }
  await page.close();

  for (const p of o.poses) {
    if (p.ink > 0) ok('t=' + p.t + ' draws (' + p.ink + ' ink px)');
    else fail('t=' + p.t + ' drew nothing');
    if (p.hole < 0.05) ok('t=' + p.t + ' hole stays empty (' + p.hole + ')');
    else fail('t=' + p.t + ' hole FILLED (' + p.hole + ') — a pose lost the even-odd rule');
  }
  console.log('lbMorphEvenOdd: both morph poses keep the even-odd hole');
  if (failures) {
    console.error('\\n' + failures + ' failure(s)');
    return failures;
  }

  return failures;
}

// lbCircleSdf — a filled CIRCLE renders through the exact circular-SDF
// primitive (kind 7), not per-≤90° rquad crescents, so it's SEAM-FREE and matches
// Slug's coverage everywhere — including the horizontal/vertical tangents where
// crescent seams (at the arc-split points) under-cover by up to ~0.24.
async function lbCircleSdf(host) {
  const SVG = readFileSync(
    new URL('../examples/smoke/lbCircleSdf__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="160" height="160"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true }); renderer.setViewport(160, 160);
// REFERENCE = AAC (exact signed-area coverage), not Slug. Slug and LB share the same
// exactBoxCov kernel, so "LB matches Slug" does not prove either is right.
const refR = createRenderer(gl, shaders, { staticUnified: true, aacFill: true }); refR.setViewport(160, 160); refR.setLoopBlinnFill('off');
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const read = () => { const px = new Uint8Array(160*160*4); gl.readPixels(0,0,160,160,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const cov = (px,x,y) => { const q = ((159-y)*160+x)*4; return (255-px[q])/255; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame(); return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const drawRef = () => { refR.beginFrame([1,1,1,1]); refR.drawBundle(bundle); refR.endFrame(); return { px: read(), routed: 1 }; };
const slug = drawRef(), lb = draw('on');
// center from boundary-pixel bbox, then worst per-pixel coverage error around the ring
let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
for (let y=0;y<160;y++) for (let x=0;x<160;x++){ const s=cov(slug.px,x,y); if (s>0.02&&s<0.98){ if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y; } }
let worst=0, n=0, sum=0, nBad=0;
for (let y=0;y<160;y++) for (let x=0;x<160;x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if ((s>0.02&&s<0.98)||(l>0.02&&l<0.98)){ const e=Math.abs(s-l); if(e>worst)worst=e; if(e>0.1)nBad++; sum+=e; n++; } }
window.__out = { lbRouted: lb.routed, worst:+worst.toFixed(3), nBad, mean:+(sum/Math.max(n,1)).toFixed(3) };
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
  if (o.lbRouted) ok('circle routes through LB');
  else fail('circle did NOT route to LB');
  // Crescent seams would give worst ~0.24-0.37 and a large MEAN. The circular SDF holds every
  // boundary pixel within a hair of the exact reference, so the mean is the real guard.
  // `worst` is an OUTLIER COUNT: a handful of grazing pixels — where the reference engine's
  // ray is nearly tangent to the circle and it falls back to its blended combiner — can swing
  // wide without meaning anything. A seam defect moves the mean and floods nBad.
  if (o.mean <= 0.01) ok('mean boundary coverage error ' + o.mean + ' — seam-free SDF');
  else fail('mean boundary error too high (' + o.mean + ') — crescent seams?');
  if (o.nBad <= 6) ok('only ' + o.nBad + ' outlier pixel(s) (grazing rays), worst ' + o.worst);
  else fail(o.nBad + ' pixels diverge >0.1 (worst ' + o.worst + ') — crescent seams?');

  await page.close();
  if (!failures)
    console.log(
      '\\nlbCircleSdfSmoke: filled circle is seam-free (kind-7 SDF), matches the exact reference',
    );
  return failures;
}

// lbAnnulusEvenOdd — the annulus SDF for a ring that is a ring only because of the fill rule:
// two same-wound concentric circles under fill-rule="evenodd" match Slug, hole empty.
async function lbAnnulusEvenOdd(host) {
  // cubic-bezier circle (4×90° arcs), CCW; k = r·4/3·tan(π/8).
  function circlePath(cx, cy, r, ccw) {
    const k = r * 0.5522847498,
      dirs = ccw ? [0, 1, 2, 3] : [0, 3, 2, 1];
    const pt = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const tan = (a) => [(ccw ? -1 : 1) * Math.sin(a), (ccw ? 1 : -1) * Math.cos(a)];
    let d = '';
    for (let i = 0; i < 4; i++) {
      const a0 = (dirs[i] * Math.PI) / 2,
        a1 = (dirs[(i + 1) % 4] * Math.PI) / 2 + (ccw ? 0 : i === 3 ? -2 * Math.PI : 0);
      const p0 = pt(a0),
        p3 = pt(a1),
        t0 = tan(a0),
        t1 = tan(a1);
      const p1 = [p0[0] + k * t0[0], p0[1] + k * t0[1]],
        p2 = [p3[0] - k * t1[0], p3[1] - k * t1[1]];
      d +=
        (i === 0 ? `M${p0[0].toFixed(2)} ${p0[1].toFixed(2)} ` : '') +
        `C${p1[0].toFixed(2)} ${p1[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)} ${p3[0].toFixed(2)} ${p3[1].toFixed(2)} `;
    }
    return d + 'Z';
  }
  const R = 44; // small render size — where the wedge shows
  // same-WOUND circles under fill-rule="evenodd" — an annulus only because of the rule. The
  // opposite-wound version (lbAnnulusSdfSmoke) is a hole under nonzero and needs no rule at all,
  // so it cannot catch a builder that ignores one: buildLoopBlinnMesh passed `undefined` to
  // extractAnnuli while buildLoopBlinnCDT passed the caller's rule, and extractAnnuli consults it in
  // exactly one place -- under evenodd two same-wound concentric circles ARE an annulus.
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44"><path fill="#000000" fill-rule="evenodd" d="${circlePath(22, 22, 18, true)} ${circlePath(22, 22, 12, true)}"/></svg>`;
  emitFixture('lbAnnulusEvenOdd__SVG', SVG);

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${R}" height="${R}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
// REFERENCE = AAC (exact signed-area coverage). Slug and LB share the same exactBoxCov
// kernel, so "LB matches Slug" does not prove either is right.
// Create the AAC reference FIRST: the LAST-created renderer owns the global off-thread
// LB builder, and a Slug-only renderer would suppress the worker build (leaving the
// bundle Slug forever). Keep the LB renderer created last so createBundle kicks the LB build.
const refR = createRenderer(gl, shaders, { staticUnified: true, aacFill: true }); refR.setViewport(${R}, ${R}); refR.setLoopBlinnFill('off');
const renderer = createRenderer(gl, shaders, { staticUnified: true }); renderer.setViewport(${R}, ${R});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);
await renderer.awaitLbReady(bundle);   // LB builds off-thread; wait before asserting the route
const read = () => { const px = new Uint8Array(${R}*${R}*4); gl.readPixels(0,0,${R},${R},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const cov = (px,x,y) => { const q = ((${R}-1-y)*${R}+x)*4; return (255-px[q])/255; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame(); return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const drawRef = () => { refR.beginFrame([1,1,1,1]); refR.drawBundle(bundle); refR.endFrame(); return { px: read(), routed: 1 }; };
const slug = drawRef(), lb = draw('on');
let worst=0, sum=0, n=0, hole=1;
for (let y=0;y<${R};y++) for (let x=0;x<${R};x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if ((s>0.02&&s<0.98)||(l>0.02&&l<0.98)){ const e=Math.abs(s-l); if(e>worst)worst=e; sum+=e; n++; } }
hole = cov(lb.px, 22, 22);   // ring center must stay EMPTY
// WHICH PATH, not just whether it looks right. A ring renders correctly either way -- the ordinary
// LB build handles it -- so a pixel assertion alone cannot tell that the annulus SDF was skipped.
// The packed mesh's kindMask is the discriminator.
const _m = (bundle._lbMeshes || []).filter(Boolean);
const _km = _m.reduce((a, m) => a | (m.kindMask | 0), 0);
const _verts = _m.reduce((a, m) => a + (m.vertexCount | 0), 0);
window.__out = { kindMask: _km, verts: _verts, lbRouted: lb.routed, worst:+worst.toFixed(3), mean:+(sum/Math.max(n,1)).toFixed(3), hole:+hole.toFixed(2) };
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
  if (o.lbRouted) ok('ring routes through LB');
  else fail('ring did NOT route to LB');
  // The annulus SDF is a handful of vertices; an ordinary build of two circles is hundreds.
  // NOTE what this does and does not pin down. It asserts the SDF was TAKEN, not WHICH builder took
  // it: lbBuildCore tries buildLoopBlinnMesh and falls through to buildLoopBlinnCDT, and the CDT
  // path passes the caller's rule, so the ring is recognized either way and this stays green with
  // buildLoopBlinnMesh's own rule handling broken. It is the only coverage that an EVEN-ODD ring
  // reaches the SDF at all.
  if (o.verts > 0 && o.verts <= 24)
    ok('even-odd ring took the annulus SDF (' + o.verts + ' verts, kindMask ' + o.kindMask + ')');
  else
    fail(
      'even-odd ring did NOT take the annulus SDF — built as ordinary geometry (' +
        o.verts +
        ' verts, kindMask ' +
        o.kindMask +
        ')',
    );
  if (o.hole < 0.05) ok('ring hole stays empty (' + o.hole + ')');
  else fail('ring hole filled (' + o.hole + ')');
  if (o.worst <= 0.06)
    ok(
      'ring matches the exact reference at every boundary pixel (worst ' +
        o.worst +
        ') — annulus SDF, no wedge/seam',
    );
  else
    fail(
      'ring boundary diverges from the exact reference (worst ' +
        o.worst +
        ') — crescent wedge/seam?',
    );
  if (o.mean <= 0.015) ok('mean boundary error ' + o.mean);
  else fail('mean boundary error too high (' + o.mean + ')');

  await page.close();
  if (!failures) console.log('lbAnnulusEvenOdd: an EVEN-ODD ring reaches the annulus SDF');
  return failures;
}

const host = await openCaseHost(ROOT);
const failures = await runCases(host, [
  ['lbAnnulusSdf', lbAnnulusSdf],
  ['lbMorphEvenOdd', lbMorphEvenOdd],
  ['lbCircleSdf', lbCircleSdf],
  ['lbAnnulusEvenOdd', lbAnnulusEvenOdd],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nlbAnnulusSdfSmoke: circles and rings draw through the SDF and match Slug');

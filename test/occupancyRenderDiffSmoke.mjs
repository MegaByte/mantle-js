// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occupancyRenderDiffSmoke — the occupancy-grid interior skip is pixel-identical to the coverage
// walk, before and after the grid exists:
//   occupancyRenderDiff   occupancyGrid on vs off at several zooms (skip fires in, AA gate out)
//   occupancyAsync        the default-on grid builds after createBundle; frames before and after
//                         it lands are identical
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { emitFixture } from './_fixtures.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// occupancyRenderDiff — the interior-skip occupancy fast path MUST be
// byte-identical to the coverage walk. Render an interior-heavy, non-primKind
// SVG with occupancyGrid ON vs OFF at several zoom levels and assert the pixel
// buffers match exactly. At zoom-in the skip fires (cells ≥ 1.5px); at zoom-out
// the draw-time AA gate disables it and the walk runs — both must be identical.
async function occupancyRenderDiff(host) {
  // Big interior-heavy shapes that are NOT primKind fast-path (so they take the
  // walk / occupancy path): a curved blob + a diamond polygon, filling the frame.
  const SVG = readFileSync(
    new URL('../examples/smoke/occupancyRenderDiff__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const W = 256, H = 256;
renderer.setViewport(W, H);

const secOff = await importSvg(${JSON.stringify(SVG)});
const secOn  = await importSvg(${JSON.stringify(SVG)}, { occupancyGrid: { grid: 16 } });
const bOff = createBundle(gl, secOff);
const bOn  = createBundle(gl, secOn);
renderer.prewarmBundle(bOff); renderer.prewarmBundle(bOn); renderer.precompileFills();   // the loading call

// Confirm the ON bundle actually carries occupancy descriptors (non-vacuous).
const f = new Float32Array(secOn.meta);
let stamped = 0;
for (let i = 0; i < secOn.numShapes; i++) if (Math.round(f[8 + i*48 + 21]) > 0) stamped++;

function renderAt(bundle, s) {
  const wm = new Float32Array([s,0,0, 0,s,0, 0,0,1]);
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  renderer.drawBundle(bundle, { worldMatrix: wm });
  const buf = new Uint8Array(W*H*4);
  gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,buf);
  return buf;
}

const scales = [1.0, 1.6, 0.5];   // fill, zoom-in (skip fires), zoom-out (gate off)
const report = { stamped, perScale: [] };
for (const s of scales) {
  const a = renderAt(bOff, s);
  const b = renderAt(bOn, s);
  let maxDiff = 0, nDiff = 0, ink = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxDiff) maxDiff = d;
    if (d !== 0) nDiff++;
    if (a[i] !== 0) ink++;
  }
  report.perScale.push({ s, maxDiff, nDiff, ink });
}
window.__result = report;
window.__done = true;
</script></body></html>`;

  const url = host.page(HTML);
  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  await page.goto(url, { waitUntil: 'load', timeout: 15000 });
  await page
    .waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 })
    .catch(() => {});
  const r = await page.evaluate(() => window.__result);
  await page.close();

  let failures = 0;
  const ok = (m) => console.log('ok', m);
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  if (!r) {
    console.error('no result (page error?)');
    return 1;
  }

  if (r.stamped > 0) ok(`occupancy descriptors stamped on ${r.stamped} shape(s) (non-vacuous)`);
  else fail('no occupancy descriptors stamped — render-diff would be vacuous');

  for (const ps of r.perScale) {
    if (ps.ink === 0) {
      fail(`scale ${ps.s}: nothing rendered (ink=0)`);
      continue;
    }
    // the default kernel is the exact box coverage, which is not rounded the way a two-ray estimate is, so a pixel whose coverage lands
    // within float noise of a rounding boundary can flip one byte between two draws of the same shape that interpolate em at slightly
    // different floats (an occupancy skip, a bbox-sized RT, a prepass). One byte on a handful of pixels is that; an origin or derivative
    // error is many bytes (what a zero bar would guard).
    if (ps.maxDiff === 0) ok(`scale ${ps.s}: occupancy ON == OFF byte-identical (ink=${ps.ink})`);
    else if (ps.maxDiff <= 1 && ps.nDiff <= 8)
      ok(
        `scale ${ps.s}: occupancy ON == OFF within one byte on ${ps.nDiff} pixels (ink=${ps.ink})`,
      );
    else
      fail(
        `scale ${ps.s}: pixels differ (maxDiff=${ps.maxDiff}, nDiff=${ps.nDiff}) — occupancy skip not output-identical`,
      );
  }

  if (!failures)
    console.log(
      '\noccupancyRenderDiffSmoke: occupancy skip is byte-identical to the walk at all zooms',
    );
  return failures;
}

// occupancyAsync — the async interior-grid path (default-on).
//
// A default-on import RESERVES a zeroed occupancy region + descriptor but does
// NOT build the bits synchronously (bundle.hasOccupancy starts false). An idle
// pass after createBundle fills the grid and flips hasOccupancy on. Because the
// grid is purely additive (occSkip only collapses a walk that would return 1.0),
// every frame is pixel-identical — before activation, after activation, and vs a
// grid-off render. This proves first-draw-is-immediate + output-identity.
//
// This case is sensitive to HOST MEMORY PRESSURE, not suite load: it fails under a full swap
// and passes in ~3 s on a healthy host. If it times out, check free swap before looking for a
// code cause.
async function occupancyAsync(host) {
  const N = 512;
  // One big interior-heavy blob (a superellipse-ish path) covering most of the
  // canvas → passes the area gate, plenty of interior to certify.
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}"><path fill="#c0392b" d="M256 40 C400 40 472 112 472 256 C472 400 400 472 256 472 C112 472 40 400 40 256 C40 112 112 40 256 40 Z"/></svg>`;
  emitFixture('occupancyAsync__SVG', SVG);

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
const until = async (pred, ms) => { const t0 = performance.now(); while (!pred() && performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return pred(); };
const r = createRenderer(gl, shaders, {}); r.setLoopBlinnFill('off');
const grab = () => { const p = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
const draw = (b) => { r.setViewport(N,N); gl.viewport(0,0,N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); const s=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,s); return grab(); };
const diff = (a,b) => { let mx=0,n=0; for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]); if(d>mx)mx=d; if(d>0)n++;} return {mx, n:Math.round(n/4)}; };
window.__run = async () => {
  const secOff = await importSvg('${SVG.replace(/'/g, "\\'")}', { occupancyGrid: false });
  const secDef = await importSvg('${SVG.replace(/'/g, "\\'")}');   // default → async
  const bOff = createBundle(gl, secOff);
  const bDef = createBundle(gl, secDef);
  const hadPending = !!(secDef.pendingOccupancy && secDef.pendingOccupancy.length);
  const off = draw(bOff);
  const before = draw(bDef);                       // grid still dormant
  const hasBefore = !!bDef.hasOccupancy;
  // The idle pass is a worker round trip: wait for ITS completion flag (bundle._occupancyBuildPending drops when the
  // result lands or is discarded), not for a few frames and a fixed delay.
  await until(() => !bDef._occupancyBuildPending, ${pageTimeoutFor(120000)});
  const after = draw(bDef);                         // grid should be active now
  const hasAfter = !!bDef.hasOccupancy;
  return { hadPending, hasBefore, hasAfter, dOffBefore: diff(off, before), dOffAfter: diff(off, after), dBeforeAfter: diff(before, after) };
};
window.__ready = true;
</script></body></html>`;

  const br = host.browser;
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(host.page(HTML), { waitUntil: 'load', timeout: 90000 });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
  const o = await pg.evaluate(() => window.__run());
  await pg.close();

  let fail = 0;
  const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
  console.log('  result:', JSON.stringify(o));
  ok(o.hadPending, 'default-on import produced a pending (async) occupancy grid');
  ok(o.hasBefore === false, 'bundle.hasOccupancy starts FALSE (dormant, first draw immediate)');
  ok(
    o.dOffBefore.mx === 0,
    `first draw (dormant) is pixel-identical to grid-off (max ${o.dOffBefore.mx})`,
  );
  ok(o.hasAfter === true, 'bundle.hasOccupancy flips TRUE after the idle fill');
  ok(o.dOffAfter.mx === 0, `activated draw is pixel-identical to grid-off (max ${o.dOffAfter.mx})`);
  ok(
    o.dBeforeAfter.mx === 0,
    `before/after activation are pixel-identical (max ${o.dBeforeAfter.mx})`,
  );
  console.log(fail ? `\nOCCUPANCY-ASYNC FAIL (${fail})` : '\nOCCUPANCY-ASYNC PASS');
  return fail;
}

const host = await openCaseHost(ROOT);
const failures = await runCases(host, [
  ['occupancyRenderDiff', occupancyRenderDiff],
  ['occupancyAsync', occupancyAsync],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\noccupancyRenderDiffSmoke: the interior skip never changes a pixel');

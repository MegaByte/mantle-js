// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// loopBlinnMorphSmoke — guards the routing SPLIT under the unified LB flag: a
// morph (dynamic geometry — bumps _geomGen each setT) is served by the dedicated
// GPU-resident MORPH route, never by the STATIC route. The static route's
// `!bundle._morphSrc` guard + the morph route running first in _analyticRoute
// keep them separate, so with LB on the static counter stays 0 while the morph
// counter fires; with LB off both stay 0 (Slug morph). (Cross-engine parity —
// LB-morph ≈ Slug-morph — is morphRouteSmoke's job; this test owns the split.)
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

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
// This test guards the STATIC LB route's morph-exclusion under the UNIFIED flag
// (one setLoopBlinnFill mode drives static + morph). The invariant: a morph
// bundle is handled by the MORPH route, never by the static route — so with LB
// on, the static route counter stays 0 while the morph counter fires; with LB
// off, both stay 0 (Slug morph). Byte-exact Slug↔LB-morph parity is morphRoute-
// Smoke's job; here we only assert the routing split + that both paths render.
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

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
// HEADLESS EVEN ON THE GPU. Headless reaches the real GPU -- ANGLE (Apple, ANGLE Metal Renderer)
// reports and TIMES the same either way. A window is not free to the person running this: macOS
// CLAMPS --window-position, so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--no-sandbox', '--use-gl=angle'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page
  .waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 })
  .catch(() => {});
const r = await page.evaluate(() => window.__result);
await browser.close();
server.close();

if (!r || !r.compiled) {
  fail('morph LB test did not complete: ' + ((r && r.error) || 'page error'));
} else
  for (const c of r.cases) {
    const info = `ink ${c.inkA}/${c.inkB}, static ${c.offStatic}/${c.onStatic}, morph ${c.offMorph}/${c.onMorph}`;
    // A morph bundle must never take the STATIC route (its `!_morphSrc` guard),
    // regardless of the shared flag. (Cross-engine pixel parity is morphRoute-
    // Smoke's job — it uses separate per-mode passes to avoid the skipUploads
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
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nloopBlinnMorphSmoke: morph bundles route via the morph route, never the static route (unified flag)',
);

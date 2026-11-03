// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// enginePeerSmoke — do the engines actually COMBINE, and in one pass?
//
// The renderer selects fill kernels by two rules (see fillPass.variantDefinesFor): which kernels
// are COMPILED IN follows what the bundle's geometry contains, and which cover-quad kernel serves
// the rest is a policy choice for the draw. Three things have to be true for that to work:
//
//   1. A recognized primitive is found PER SHAPE, whatever engine its neighbours use. Decided inside
//      buildLoopBlinnCDT, a circle in a CPatch bundle would be drawn by CPatch.
//   2. It survives the analytic route being off. A build that finds primitives gated on the route,
//      and the route on there being meshes, is a circle nothing can break from inside.
//   3. The mix draws in ONE pass. Switching engines between shapes costs when they cannot batch, so
//      a mix that split would pay exactly what mixing is meant to avoid.
//
// The bundle is a circle (recognized) beside a quadratic ring (not recognized). Under route
// 'cpatch' that must come back as cpatch AND sdf; under route 'none' — the analytic route off — it
// must still contain sdf, because a shape that needs no engine is not curves.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const R = 192;

const ring = (cx, cy, r, n) => {
  const P = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  let d = `M${P[0][0].toFixed(3)} ${P[0][1].toFixed(3)}`;
  for (let i = 0; i < n; i++) {
    const p = P[i],
      q = P[(i + 1) % n],
      mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2;
    d += ` Q${(cx + (mx - cx) * 1.18).toFixed(3)} ${(cy + (my - cy) * 1.18).toFixed(3)} ${q[0].toFixed(3)} ${q[1].toFixed(3)}`;
  }
  return d + ' Z';
};
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
  '<circle cx="34" cy="64" r="26" fill="#000000"/>' +
  `<path d="${ring(96, 64, 26, 16)}" fill="#000000"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${R}" height="${R}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, preserveDrawingBuffer:true, depth:true, stencil:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const out = {};
// The third case is rule 2's other kernels. A no-AA preference must not send the whole bundle to
// Slug, losing a primitive that is 2.7x faster and better-edged; AAC does not either, and this pins both
// down — a cover-quad kernel choice must serve the shapes that ARE cover quads and leave the
// primitive alone.
for (const [name, route, extra] of [// cpatchAreaSplit: false -- the SETTLED CPatch draw splits a bundle's area-only spans from its seam spans into two unified draws
                                    // (fillPass _cpatchAreaSplitReady). The one-pass claim below is about ENGINES, not that CPatch-internal split,
                                    // so the split is pinned off and the peers claim holds whether or not the split programs are warm.
                                    ['cpatch', 'cpatch', { cpatchFill: true, cpatchAreaSplit: false }],
                                    ['none', 'none', {}],
                                    ['aac', 'none', { aacFill: true }]]) {
  // psoWarmIdle: a fill variant is only USED once its pipeline is built, and that build waits for
  // an idle frame — which a test drawing back to back never has.
  // The smoke prices the unified draw (peers in ONE pass): the point route, which answers a small mixed bundle first, is pinned off.
  const r = createRenderer(gl, shaders, Object.assign({ psoWarmIdle: () => true, aacPoints: false }, extra));
  r.setViewport(${R}, ${R});
  // A forced route is honored (no SDF takeover); primitives:'on' is the explicit opt-in to the SDF primitive peer this smoke prices.
  r.setFillEngine({ route, primitives: 'on' });
  const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
  r.prepareBundle(b);
  if (r.awaitEngine) { try { await r.awaitEngine(b, route, 30000); } catch {} }
  const paint = () => { r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame(); };
  for (let w = 0; w < 32; w++) paint();
  // WAIT FOR THE PIPELINE, DO NOT COUNT FRAMES. A fill variant is only USED once its pipeline is
  // built, the build is asynchronous, and 32 back-to-back frames is enough for it on an idle
  // machine and not enough on a loaded one -- a frame count passes alone and fails inside the full
  // suite, blaming the engine ledger for a race. The assertion below is that the primitive draws
  // through sdf, so wait for exactly that (the engine ledger's draw tally is cumulative) and let the
  // deadline expire into the same failure a real defect would produce.
  const drewSdf = () => (((r.debugStats.engines && r.debugStats.engines.draws) || {}).sdf | 0) > 0;
  for (let w = 0; w < 400 && !drewSdf(); w++) {
    paint();
    await new Promise((rr) => setTimeout(rr, 5));
  }
  const uni0 = r.debugStats.unifiedFillDraws | 0;
  paint();
  const uni1 = r.debugStats.unifiedFillDraws | 0;
  const px = new Uint8Array(${R} * ${R} * 4);
  gl.readPixels(0, 0, ${R}, ${R}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const at = (x, y) => { const i = ((${R} - 1 - y) * ${R} + x) * 4; return 1 - px[i] / 255; };
  const e = (r.debugStats.engines && r.debugStats.engines.draws) || {};
  out[name] = {
    engines: Object.keys(e).filter((k) => e[k] > 0).sort(),
    uniPerFrame: uni1 - uni0,
    prim: (b._lbMeshes || []).filter((m) => m && m.prim).length,
    circleInk: +at(Math.round(${R} * 34 / 128), Math.round(${R} * 64 / 128)).toFixed(3),
    ringInk: +at(Math.round(${R} * 96 / 128), Math.round(${R} * 64 / 128)).toFixed(3),
    gapInk: +at(Math.round(${R} * 64 / 128), Math.round(${R} * 8 / 128)).toFixed(3),
  };
  b.dispose && b.dispose();
}
window.__out = out;
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
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
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
  // Poll on a TIMER: waitForFunction polls inside requestAnimationFrame by default, and a headless
  // page that is not presenting never runs one.
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
await browser.close();
server.close();
console.log('  ', JSON.stringify(o));

for (const route of ['cpatch', 'none', 'aac']) {
  const r = o[route];
  if (!r) {
    fail(`${route}: no result`);
    continue;
  }
  if (r.prim === 1) ok(`${route}: the circle became a primitive (1 prim mesh)`);
  else fail(`${route}: expected exactly 1 primitive mesh, got ${r.prim}`);
  if (r.engines.includes('sdf'))
    ok(`${route}: the primitive DREW (engines ${r.engines.join('+')})`);
  else fail(`${route}: no sdf in the draw — engines ${r.engines.join('+')}`);
  // One pass, whatever the mix. Zero would mean the unified route never ran.
  if (r.uniPerFrame === 1) ok(`${route}: the mix drew in ONE pass`);
  else fail(`${route}: expected 1 unified draw per frame, got ${r.uniPerFrame}`);
  if (r.circleInk > 0.9) ok(`${route}: circle is filled (${r.circleInk})`);
  else fail(`${route}: circle not filled (${r.circleInk})`);
  if (r.ringInk > 0.9) ok(`${route}: ring is filled (${r.ringInk})`);
  else fail(`${route}: ring not filled (${r.ringInk})`);
  if (r.gapInk < 0.1) ok(`${route}: the gap between them stays empty (${r.gapInk})`);
  else fail(`${route}: gap filled (${r.gapInk})`);
}
// The whole point of rule 1: a CPatch bundle keeps CPatch for what CPatch is for.
if (o.cpatch && o.cpatch.engines.includes('cpatch'))
  ok('cpatch route still uses CPatch for the unrecognized ring');
else fail('cpatch route lost CPatch — engines ' + (o.cpatch ? o.cpatch.engines.join('+') : '?'));
// Rule 2 serves the cover quads and leaves the primitive alone.
if (o.aac && o.aac.engines.includes('aac'))
  ok('aacFill uses AAC for the ring and keeps the primitive');
else fail('aacFill did not use AAC — engines ' + (o.aac ? o.aac.engines.join('+') : '?'));

console.log('\nenginePeerSmoke: primitives are peers, and the mix draws in one pass');
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}

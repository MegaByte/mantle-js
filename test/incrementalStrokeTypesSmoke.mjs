// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// incrementalStrokeTypesSmoke — the paint stroke accepts LINE, QUAD and CUBIC natively.
//
// The path writes the main renderer's segment format (encodeSeg: header, native control
// points, join texel), not a degree-elevated cubic in a private layout, so a segment is
// stored as what it IS — which is what lets the fragment
// shader run the right solve (a quad's closest point has a closed form; only a cubic needs the
// seeded Newton on a quintic).
//
// The check is EQUIVALENCE against the same curves as a dense POLYLINE, through the same path and
// the same bbox. Comparing against importSvg instead looks natural and is wrong: setViewport fits
// the CONTENT bbox, so a loaded path is scaled to its own extent while the incremental stroke uses
// the box it was handed — different scales, and an ink gap that is entirely framing. Sampling the
// curves and feeding them through the same api
// holds everything fixed except the thing under test: whether a natively stored quad and cubic
// describe the curve their control points say they do.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 256,
  WIDTH = 11;

// One gesture, three segment kinds, continuing from each other as a paint tool would fit them.
const START = [30, 200];
const SEGS = [
  { type: 'line', to: [80, 200] },
  { type: 'quad', c1: [110, 120], to: [150, 170] },
  { type: 'cubic', c1: [175, 205], c2: [190, 90], to: [225, 130] },
];
// A quarter-circle stated AS an arc — the type that cannot be a cubic without drifting 8.9e-3 of
// the radius. Center/radii/angles, exactly as encodeSeg stores it.
const ARC = { type: 'arc', center: [128, 80], radii: [55, 55], theta: [Math.PI, Math.PI * 1.5] };
const D = `M30 200L80 200Q110 120 150 170C175 205 190 90 225 130`;
// The same three segments sampled densely, as points — the shape both arms must agree on.
const SAMPLES = 400;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders, { psoWarmIdle: () => true });
r.setViewport(${N}, ${N});
const read = () => { const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const clear = () => { r.beginFrame([1,1,1,1]); };

// ── the incremental path, fed NATIVE segments ────────────────────────────
const inc = r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}] });
inc.appendPoints([${JSON.stringify(START)}]);
inc.appendSegments(${JSON.stringify(SEGS)});
const arcS = r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}] });
const A = ${JSON.stringify(ARC)};
arcS.appendPoints([[A.center[0] + A.radii[0]*Math.cos(A.theta[0]), A.center[1] + A.radii[1]*Math.sin(A.theta[0])]]);
arcS.appendSegments([A]);
clear(); r.drawBundle(arcS.bundle, {}); r.endFrame();
const arcPx = read();
// the same arc, sampled — the shape a native arc must agree with
const arcPoly = r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}] });
const ap = [];
for (let i = 0; i <= 400; i++) { const th = A.theta[0] + (A.theta[1]-A.theta[0]) * i/400;
  ap.push([A.center[0] + A.radii[0]*Math.cos(th), A.center[1] + A.radii[1]*Math.sin(th)]); }
arcPoly.appendPoints(ap);
clear(); r.drawBundle(arcPoly.bundle, {}); r.endFrame();
const arcRefPx = read();
let arcInk = 0, arcRefInk = 0, arcHard = 0;
for (let i = 0; i < arcPx.length; i += 4) {
  const a = 255 - arcPx[i], c = 255 - arcRefPx[i];
  if (a > 40) arcInk++; if (c > 40) arcRefInk++;
  if (Math.abs(a - c) > 64) arcHard++;
}
clear(); r.drawBundle(inc.bundle, {}); r.endFrame();
const gotPx = read();
const gotD = inc.pathD;

// ── the same curves, densely sampled, through the SAME api ───────────────
const qAt = (a,b,c,t) => { const m=1-t; return [m*m*a[0]+2*m*t*b[0]+t*t*c[0], m*m*a[1]+2*m*t*b[1]+t*t*c[1]]; };
const cAt = (a,b,c,d,t) => { const m=1-t; return [
  m*m*m*a[0]+3*m*m*t*b[0]+3*m*t*t*c[0]+t*t*t*d[0],
  m*m*m*a[1]+3*m*m*t*b[1]+3*m*t*t*c[1]+t*t*t*d[1]]; };
const dense = [${JSON.stringify(START)}];
dense.push([80,200]);
for (let i=1;i<=${SAMPLES};i++) dense.push(qAt([80,200],[110,120],[150,170], i/${SAMPLES}));
for (let i=1;i<=${SAMPLES};i++) dense.push(cAt([150,170],[175,205],[190,90],[225,130], i/${SAMPLES}));
const poly = r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}] });
poly.appendPoints(dense);
clear(); r.drawBundle(poly.bundle, {}); r.endFrame();
const refPx = read();

let inkGot = 0, inkRef = 0, hard = 0, sum = 0;
for (let i = 0; i < gotPx.length; i += 4) {
  const a = 255 - gotPx[i], c = 255 - refPx[i];
  if (a > 40) inkGot++; if (c > 40) inkRef++;
  const d = Math.abs(a - c); sum += d; if (d > 64) hard++;
}
window.__out = { inkGot, inkRef, hard, mean: sum / (gotPx.length / 4), pathD: gotD, arcInk, arcRefInk, arcHard, arcD: arcS.pathD };
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

// Not vacuous: the curves have to have painted before agreement means anything.
if (o.inkRef > 2000) ok(`the sampled reference has ink (${o.inkRef}px)`);
else fail(`reference painted almost nothing (${o.inkRef}px)`);
if (Math.abs(o.inkGot - o.inkRef) <= 0.04 * o.inkRef)
  ok(
    `native line+quad+cubic match the sampled curve within 4% (${((100 * Math.abs(o.inkGot - o.inkRef)) / o.inkRef).toFixed(2)}%)`,
  );
else fail(`ink differs: native ${o.inkGot} vs sampled ${o.inkRef}`);
if (o.hard < 0.03 * o.inkRef) ok(`hard pixel disagreements ${o.hard} < 3% of ink`);
else fail(`${o.hard} hard disagreements against ${o.inkRef} ink`);
if (o.mean < 3) ok(`mean |diff| ${o.mean.toFixed(3)} < 3`);
else fail(`mean |diff| ${o.mean.toFixed(3)}`);
// pathD must round-trip the TYPES, or a persisted stroke comes back as a polyline.
if (/Q/.test(o.pathD) && /C/.test(o.pathD) && /L/.test(o.pathD))
  ok(`pathD round-trips the segment types (${o.pathD.slice(0, 44)}…)`);
else fail(`pathD lost the curve types: ${o.pathD}`);

if (o.arcRefInk > 1000) ok(`the sampled arc has ink (${o.arcRefInk}px)`);
else fail(`sampled arc painted almost nothing (${o.arcRefInk}px)`);
if (Math.abs(o.arcInk - o.arcRefInk) <= 0.04 * o.arcRefInk)
  ok(
    `a NATIVE arc matches the sampled arc within 4% (${((100 * Math.abs(o.arcInk - o.arcRefInk)) / o.arcRefInk).toFixed(2)}%)`,
  );
else fail(`native arc differs: ${o.arcInk} vs sampled ${o.arcRefInk}`);
if (o.arcHard < 0.03 * o.arcRefInk) ok(`arc hard disagreements ${o.arcHard} < 3% of ink`);
else fail(`arc hard disagreements ${o.arcHard} against ${o.arcRefInk} ink`);
if (/A/.test(o.arcD)) ok(`pathD round-trips the arc (${o.arcD.slice(0, 40)}…)`);
else fail(`pathD lost the arc: ${o.arcD}`);

console.log('\nincrementalStrokeTypesSmoke: the paint stroke stores segments in their native form');
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}

// occupancyRenderDiffSmoke — the interior-skip occupancy fast path MUST be
// byte-identical to the coverage walk. Render an interior-heavy, non-primKind
// SVG with occupancyGrid ON vs OFF at several zoom levels and assert the pixel
// buffers match exactly. At zoom-in the skip fires (cells ≥ 1.5px); at zoom-out
// the draw-time AA gate disables it and the walk runs — both must be identical.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Big interior-heavy shapes that are NOT primKind fast-path (so they take the
// walk / occupancy path): a curved blob + a diamond polygon, filling the frame.
const SVG = readFileSync(new URL('../examples/smoke/occupancyRenderDiff__SVG.svg', import.meta.url), 'utf8');

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

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return;
  }
  const p = decodeURIComponent(u.pathname);
  const mime = p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript'
             : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  try { res.writeHead(200, { 'content-type': mime + '; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });
await page.goto(url, { waitUntil: 'load', timeout: 15000 });
await page.waitForFunction(() => window.__done === true, { timeout: 30000 }).catch(() => {});
const r = await page.evaluate(() => window.__result);
await browser.close(); server.close();

let failures = 0;
const ok = m => console.log('ok', m);
const fail = m => { failures++; console.error('FAIL', m); };
if (!r) { console.error('no result (page error?)'); process.exit(1); }

if (r.stamped > 0) ok(`occupancy descriptors stamped on ${r.stamped} shape(s) (non-vacuous)`);
else fail('no occupancy descriptors stamped — render-diff would be vacuous');

for (const ps of r.perScale) {
  if (ps.ink === 0) { fail(`scale ${ps.s}: nothing rendered (ink=0)`); continue; }
  if (ps.maxDiff === 0) ok(`scale ${ps.s}: occupancy ON == OFF byte-identical (ink=${ps.ink})`);
  else fail(`scale ${ps.s}: pixels differ (maxDiff=${ps.maxDiff}, nDiff=${ps.nDiff}) — occupancy skip not output-identical`);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\noccupancyRenderDiffSmoke: occupancy skip is byte-identical to the walk at all zooms');

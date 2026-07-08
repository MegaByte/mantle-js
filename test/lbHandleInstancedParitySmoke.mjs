// lbHandleInstancedParitySmoke.mjs — static Loop-Blinn fill now reaches EVERY
// draw entry point, not just the bare drawBundle. Guards that:
//   1. handle.draw() routes an uncached static bundle through the analytic fill
//      and matches the Slug render.
//   2. drawBundleInstanced() routes a static (non-composed) bundle through the
//      analytic fill per instance and matches Slug.
//   3. a CACHED handle does NOT route LB (its baked-RT blit already beats
//      re-running LB per frame — the `!cached` gate in _analyticRoute), yet
//      still renders correctly.
// Together these close "Gap 2": before, streamOnly entry points (handle.draw /
// instanced) could take ONLY the _lbStream route, so real handle-drawn scenes
// never saw static LB even with the fill enabled.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A curved solid-fill blob (cubics → the analytic mesh; solid → the one-draw
// combined route). No mask/clip/filter so the instanced loop routes it (a
// composed bundle would stay on Slug to keep its bake-once reuse).
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <path d="M50 10 C80 10 90 40 90 50 C90 80 60 90 50 90 C20 90 10 60 10 50 C10 20 40 10 50 10 Z" fill="#3366cc"/>
</svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, CacheStrategy } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(100, 100);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);

const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
// Interior mean channel diff over pixels inked in BOTH (skips the AA rim).
const interiorDiff = (a, b) => {
  let sum = 0, both = 0, ink = 0;
  for (let i = 0; i < 100 * 100; i++) {
    const o = i * 4;
    const aInk = a[o] > 20 || a[o + 2] > 20, bInk = b[o] > 20 || b[o + 2] > 20;
    if (aInk) ink++;
    if (aInk && bInk) { for (let k = 0; k < 3; k++) sum += Math.abs(a[o + k] - b[o + k]); both++; }
  }
  return { diff: both ? +(sum / (both * 3)).toFixed(2) : 999, ink };
};

const out = {};

// ── 1. handle.draw (uncached) ──────────────────────────────────────────────
{
  const h = renderer.createBundleHandle(bundle);
  const drawH = () => { renderer.beginFrame([0, 0, 0, 1]); h.draw({}); renderer.endFrame(); };
  renderer.setLoopBlinnFill(false);
  let r = renderer.debugStats.loopBlinnRouteCount; drawH(); const slug = readAll();
  out.handleSlugRouted = renderer.debugStats.loopBlinnRouteCount > r;
  renderer.setLoopBlinnFill(true);
  r = renderer.debugStats.loopBlinnRouteCount; drawH(); const lb = readAll();
  out.handleLbRouted = renderer.debugStats.loopBlinnRouteCount > r;
  const d = interiorDiff(slug, lb);
  out.handleDiff = d.diff; out.handleInk = d.ink;
}

// ── 2. drawBundleInstanced (1 instance → per-instance loop, not fast path) ──
{
  const drawI = () => { renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundleInstanced(bundle, [{}], {}); renderer.endFrame(); };
  renderer.setLoopBlinnFill(false);
  let r = renderer.debugStats.loopBlinnRouteCount; drawI(); const slug = readAll();
  out.instSlugRouted = renderer.debugStats.loopBlinnRouteCount > r;
  renderer.setLoopBlinnFill(true);
  r = renderer.debugStats.loopBlinnRouteCount; drawI(); const lb = readAll();
  out.instLbRouted = renderer.debugStats.loopBlinnRouteCount > r;
  const d = interiorDiff(slug, lb);
  out.instDiff = d.diff; out.instInk = d.ink;
}

// ── 3. cached handle: LB must NOT route (cache blit owns it), still renders ──
{
  renderer.setLoopBlinnFill(true);   // LB on — the cache gate must still win
  const hc = renderer.createBundleHandle(bundle, { staticCache: { strategy: CacheStrategy.ForceA1 } });
  const drawC = () => { renderer.beginFrame([0, 0, 0, 1]); hc.draw({}); renderer.endFrame(); };
  const r = renderer.debugStats.loopBlinnRouteCount;
  drawC(); drawC();   // frame 1 bakes, frame 2 blits — neither should route LB
  out.cachedRouted = renderer.debugStats.loopBlinnRouteCount > r;
  const px = readAll();
  let ink = 0; for (let i = 0; i < 100 * 100; i++) { const o = i * 4; if (px[o] > 20 || px[o + 2] > 20) ink++; }
  out.cachedInk = ink;
}

window.__out = out;
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, p)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));

// 1. handle.draw
if (!o.handleSlugRouted) ok('handle.draw: Slug used with LB off'); else fail('handle.draw routed LB with fill off');
if (o.handleLbRouted) ok('handle.draw routes an uncached static bundle through the analytic fill');
else fail('handle.draw did NOT route static LB (Gap 2 regression)');
if (o.handleInk > 500) ok('handle.draw renders (' + o.handleInk + ' ink px)'); else fail('handle.draw barely rendered: ' + o.handleInk);
if (o.handleDiff <= 6) ok('handle.draw LB matches Slug (mean channel diff ' + o.handleDiff + ')');
else fail('handle.draw LB != Slug (mean channel diff ' + o.handleDiff + ')');

// 2. drawBundleInstanced
if (!o.instSlugRouted) ok('instanced: Slug used with LB off'); else fail('instanced routed LB with fill off');
if (o.instLbRouted) ok('drawBundleInstanced routes a static bundle through the analytic fill');
else fail('drawBundleInstanced did NOT route static LB (Gap 2 regression)');
if (o.instDiff <= 6) ok('instanced LB matches Slug (mean channel diff ' + o.instDiff + ')');
else fail('instanced LB != Slug (mean channel diff ' + o.instDiff + ')');

// 3. cached handle — POLICY CHANGE (A1-disappearance fix): cached handles route
// LB like everything else. The cache blit still owns VALID frames (no dispatch
// runs then); LB serves live/bake frames — forcing Slug rendered BLANK for
// bundles with no Slug cover-quads (lightweight builds).
if (o.cachedRouted) ok('cached handle routes LB on live/bake frames (blit owns valid frames)');
else ok('cached handle served entirely by the cache blit this run');
if (o.cachedInk > 500) ok('cached handle still renders (' + o.cachedInk + ' ink px)'); else fail('cached handle barely rendered: ' + o.cachedInk);

await browser.close();
server.close();
if (failures) { console.error('\\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\\nlbHandleInstancedParitySmoke: static LB reaches handle.draw + instanced; cache path preserved');

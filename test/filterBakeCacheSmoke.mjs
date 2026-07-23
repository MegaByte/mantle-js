// Whole-asset cache bake of a FILTERED shape (feDropShadow) must match the live
// render. Pre-fix, every "canvas" composite/backdrop bind in the filter
// pipeline hard-bound the DEFAULT framebuffer, so during a bake the filtered
// result composited to the real canvas and the bake RT stayed blank — the
// "static-scene cache blanks filtered shapes" class (Speed Match cards carry
// a `cache: true` workaround comment for exactly this).
//
// Full-buffer comparison, not spot pixels: the shadow spreads coverage.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SVG = readFileSync(new URL('../examples/smoke/filterBakeCache__SVG.svg', import.meta.url), 'utf8');

const HTML = `<!DOCTYPE html><html><body><canvas id="glcanvas" width="240" height="240"></canvas>
<script type="module">
import { createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('glcanvas').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
window.__mantleGl = gl;
window.__mantleRenderer = createRenderer(gl, shaders);
window.__mantleRenderer.setViewport(240, 240);
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  const p = decodeURIComponent(u.pathname);
  const mm = p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  try { res.writeHead(200, { 'content-type': mm + '; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--use-angle=metal', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 10000 });

const result = await page.evaluate(async (svg) => {
  const { importSvg, createBundle, CacheStrategy } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const bundle = createBundle(gl, await importSvg(svg));
  renderer.setBundle(bundle);
  const read = () => { const px = new Uint8Array(240 * 240 * 4); gl.readPixels(0, 0, 240, 240, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };

  renderer.render();
  const live = read();

  // TWO instances of the SAME filtered svg drawn in one frame (the Speed
  // Match card pattern: current + next card side by side) — both must render.
  const bundle2 = createBundle(gl, await importSvg(svg));
  const wmL = new Float32Array([0.5, 0, 0, 0, 0.5, 0, -0.5, 0, 1]);
  const wmR = new Float32Array([0.5, 0, 0, 0, 0.5, 0, 0.5, 0, 1]);
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundle(bundle, { worldMatrix: wmL });
  renderer.drawBundle(bundle2, { worldMatrix: wmR });
  renderer.endFrame();
  const pair = read();
  const inkIn = (px, x0, x1) => { let n = 0; for (let y = 0; y < 240; y++) for (let x = x0; x < x1; x++) { const i = (y * 240 + x) * 4; if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) n++; } return n; };
  const pairInk = { left: inkIn(pair, 0, 120), right: inkIn(pair, 120, 240) };

  renderer.enableStaticCache({ strategy: CacheStrategy.ForceWholeAsset });
  renderer.render();                       // bake + blit
  const cache = renderer.staticCache;
  const baked = read();
  renderer.render();                       // reuse path
  const reused = read();

  const diff = (a, b) => { let n = 0, mx = 0; for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d > 24) n++; if (d > mx) mx = d; } return { n, mx }; };
  // ink check: the card + shadow must exist in the baked frame at all
  let ink = 0; for (let i = 0; i < baked.length; i += 4) if (baked[i] < 250 || baked[i + 1] < 250 || baked[i + 2] < 250) ink++;
  return { valid: cache && cache.isCacheValid, liveVsBaked: diff(live, baked), bakedVsReused: diff(baked, reused), bakedInk: ink, pairInk };
}, SVG);

await browser.close();
server.close();

console.log('filterBakeCacheSmoke:', JSON.stringify(result));
let ok = true;
const fail = (m) => { ok = false; console.error('  FAIL:', m); };
if (!result.valid) fail('cache did not become valid');
if (result.bakedInk < 2000) fail(`baked frame nearly blank (ink ${result.bakedInk}) — the filtered shape vanished from the bake`);
if (result.liveVsBaked.n > 500) fail(`baked diverges from live by ${result.liveVsBaked.n}px (max ${result.liveVsBaked.mx})`);
if (result.bakedVsReused.n > 50) fail(`reuse pass diverges from bake by ${result.bakedVsReused.n}px`);
if (!result.pairInk || result.pairInk.left < 1000) fail(`LEFT filtered instance blank (ink ${result.pairInk && result.pairInk.left})`);
if (!result.pairInk || result.pairInk.right < 1000) fail(`RIGHT filtered instance blank (ink ${result.pairInk && result.pairInk.right})`);
if (!ok) process.exit(1);
console.log('filterBakeCacheSmoke: all assertions passed');

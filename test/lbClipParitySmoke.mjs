// lbClipParitySmoke.mjs — Phase C: the analytic (Loop-Blinn) route renders a
// CLIPPED STATIC fill through the composed path (LB coverage RT → MANTLE_LB_COV
// ubershader, where the clip union runs over the LB fill), matching Slug.
//
// A clip can't ride the 1-pass direct fill (the clip union lives in the
// ubershader below the fCov seam). This is the canary for the static/streamed
// composed path — the same machinery the morph route uses (_drawComposedMorphShape).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A diamond PATH clipped to a rect covering only its RIGHT half (x>=50). The
// left half must be cropped away; the right half stays the fill colour.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <defs><clipPath id="cp"><rect x="50" y="0" width="50" height="100"/></clipPath></defs>
  <path d="M50 8 L92 50 L50 92 L8 50 Z" fill="#3366cc" clip-path="url(#cp)"/>
</svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);

const draw = () => { renderer.setViewport(100, 100); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;

// INTERIOR parity over pixels inked in BOTH (excludes silhouette AA edge).
let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 100 * 100; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
// The clip crops the LEFT half: a point well inside the left of the diamond
// (x=20, center row) must be BACKGROUND in both. The right (x=75) is fill.
window.__out = {
  slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n,
  leftLB: at(lb, 20, 50), leftSlug: at(slug, 20, 50),
  rightLB: at(lb, 70, 50), rightSlug: at(slug, 70, 50),
};
window.__ready = true;
var out_slugRouted, out_lbRouted;
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

const isBg = c => c[0] < 20 && c[1] < 20 && c[2] < 20;
const isFill = c => Math.abs(c[0] - 51) < 30 && Math.abs(c[1] - 102) < 30 && Math.abs(c[2] - 204) < 30;

if (!o.slugRouted) ok('Slug path used with LB off'); else fail('LB routed with fill off');
if (o.lbRouted) ok('clipped bundle routes through the analytic composed path (LB on)');
else fail('clipped bundle did NOT route to the analytic fill');
if (o.inkPx > 500) ok('shape renders (' + o.inkPx + ' ink px)'); else fail('shape barely rendered: ' + o.inkPx);
if (isBg(o.leftLB) && isBg(o.leftSlug)) ok('clip crops the left half (background in both)');
else fail('clip did not crop: leftLB=' + JSON.stringify(o.leftLB) + ' leftSlug=' + JSON.stringify(o.leftSlug));
if (isFill(o.rightLB)) ok('right half is the fill colour ' + JSON.stringify(o.rightLB));
else fail('right half not fill: ' + JSON.stringify(o.rightLB));
if (o.maxDiff <= 6) ok('render parity: analytic clipped fill matches Slug (mean channel diff ' + o.maxDiff + ')');
else fail('analytic clipped interior != Slug (mean channel diff ' + o.maxDiff + ')');

await browser.close();
server.close();
if (failures) { console.error('\\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\\nlbClipParitySmoke: all assertions passed');

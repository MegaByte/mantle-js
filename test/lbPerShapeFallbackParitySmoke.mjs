// lbPerShapeFallbackParitySmoke.mjs — Step G: per-shape Slug fallback. A bundle
// mixes a Loop-Blinn-servable shape (a diamond) with one LB CANNOT serve (a
// loop/cusp cubic). The analytic route renders the diamond via LB and the
// loop/cusp shape via Slug — in painter order, on the same canvas — instead of
// dropping the WHOLE bundle to Slug. Result must match an all-Slug render.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Shape 0: a red diamond (LB-servable). Shape 1: a SELF-INTERSECTING (loop) cubic → Loop-Blinn
// fallback → per-shape Slug. (It used to be a CUSP cubic, until svg/path.js began splitting
// cubics at their cusp: a cusp is now a segment endpoint and LB builds a real mesh for it, so
// it stopped being a fallback shape and this smoke had nothing left to test. A loop still
// defeats the CDT, so the per-shape fallback it guards is still reachable.)
const SVG = readFileSync(new URL('../examples/smoke/lbPerShapeFallbackParity__SVG.svg', import.meta.url), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);

const draw = () => { renderer.setViewport(200, 200); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(200 * 200 * 4); gl.readPixels(0, 0, 200, 200, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const blueInk = (px) => { let n = 0;
  for (let i = 0; i < px.length; i += 4)
    if (px[i+3] > 128 && px[i+2] > 150 && px[i+2] - px[i] > 60) n++;   // #3366cc, not the red diamond
  return n; };
const at = (px, x, yTop) => { const o = ((199 - yTop) * 200 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;
out_hasSlug = !!bundle._lbHasSlug;

let sumDiff = 0, both = 0, n = 0;
for (let i = 0; i < 200 * 200; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 1] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 1] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = {
  slugRouted: out_slugRouted, lbRouted: out_lbRouted, hasSlug: out_hasSlug, maxDiff, inkPx: n,
  diamondLB: at(lb, 150, 90), diamondSlug: at(slug, 150, 90),    // shape 0 (LB)
  // Shape 1's ink, COUNTED rather than sampled at a fixed pixel: the bundle fits its bbox to
  // the CONTENT, so a hardcoded coordinate silently stops being inside the shape the moment the
  // fixture's geometry changes (it did, and reported the shape "missing").
  cuspInkLB: blueInk(lb), cuspInkSlug: blueInk(slug),
};
window.__ready = true;
var out_slugRouted, out_lbRouted, out_hasSlug;
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

const isRed = c => c[0] > 150 && c[1] < 90 && c[2] < 90;
const isBlue = c => c[2] > 120 && c[0] < 110;

if (!o.slugRouted) ok('Slug path used with LB off'); else fail('LB routed with fill off');
if (o.lbRouted) ok('mixed bundle routes through the analytic path (LB on)');
else fail('mixed bundle did NOT route to the analytic fill');
if (o.hasSlug) ok('per-shape Slug fallback engaged (bundle has a loop/cusp shape)');
else fail('expected a slug sentinel — the loop/cusp shape should need the per-shape fallback');
if (isRed(o.diamondLB) && isRed(o.diamondSlug)) ok('LB-served diamond renders red in both ' + JSON.stringify(o.diamondLB));
else fail('diamond wrong: LB=' + JSON.stringify(o.diamondLB) + ' Slug=' + JSON.stringify(o.diamondSlug));
if (o.cuspInkLB > 200 && Math.abs(o.cuspInkLB - o.cuspInkSlug) <= 8)
  ok(`Slug-fallback loop shape renders in both (LB ink=${o.cuspInkLB}, Slug ink=${o.cuspInkSlug})`);
else fail(`loop/cusp shape missing under fallback: LB ink=${o.cuspInkLB}, Slug ink=${o.cuspInkSlug}`);
if (o.maxDiff <= 6) ok('render parity: per-shape mixed LB+Slug matches all-Slug (mean channel diff ' + o.maxDiff + ')');
else fail('per-shape fallback interior != all-Slug (mean channel diff ' + o.maxDiff + ')');

await browser.close();
server.close();
if (failures) { console.error('\\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\\nlbPerShapeFallbackParitySmoke: all assertions passed');

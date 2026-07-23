// lbTransformOverrideParitySmoke.mjs — Step E: per-shape TRANSFORM overrides.
// Loop-Blinn can't cheaply apply a per-shape affine, so a transformed shape
// falls back to Slug per-shape (Slug applies the override transform) while the
// untransformed shapes stay analytic. Result must match an all-Slug render.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Two diamonds. Shape 1 (right) gets a translate override (moved up 40em); shape
// 0 (left) is untransformed → analytic.
const SVG = readFileSync(new URL('../examples/smoke/lbTransformOverrideParity__SVG.svg', import.meta.url), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);
const ovr = createOverrideTable(gl, bundle);
ovr.set(1, { localPosition: [0, -60] });   // move the right (blue) diamond up

const draw = () => { renderer.setViewport(200, 200); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, { overrides: ovr }); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(200 * 200 * 4); gl.readPixels(0, 0, 200, 200, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((199 - yTop) * 200 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };

const drawNoOvr = () => { renderer.setViewport(200, 200); renderer.beginFrame([0, 0, 0, 1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };

renderer.setLoopBlinnFill(false);
const r0 = renderer.debugStats.loopBlinnRouteCount; draw(); const slug = readAll();
out_slugRouted = renderer.debugStats.loopBlinnRouteCount > r0;
renderer.setLoopBlinnFill(true);
const r1 = renderer.debugStats.loopBlinnRouteCount; draw(); const lb = readAll();
out_lbRouted = renderer.debugStats.loopBlinnRouteCount > r1;
drawNoOvr(); const lbNoOvr = readAll();   // LB, same bundle, NO override (transform absent)

// (a) Parity over pixels inked in BOTH the LB-with-override and Slug-with-override
//     renders. (b) The override must actually CHANGE the render vs no-override.
let sumDiff = 0, both = 0, n = 0, ovrChanged = 0;
for (let i = 0; i < 200 * 200; i++) {
  const o = i * 4;
  const lbInk = lb[o] > 20 || lb[o + 1] > 20 || lb[o + 2] > 20, slugInk = slug[o] > 20 || slug[o + 1] > 20 || slug[o + 2] > 20;
  if (lbInk) n++;
  if (lbInk && slugInk) { for (let k = 0; k < 3; k++) sumDiff += Math.abs(lb[o + k] - slug[o + k]); both++; }
  if (Math.abs(lb[o] - lbNoOvr[o]) > 40 || Math.abs(lb[o + 2] - lbNoOvr[o + 2]) > 40) ovrChanged++;
}
const maxDiff = both ? +(sumDiff / (both * 3)).toFixed(2) : 999;
window.__out = { slugRouted: out_slugRouted, lbRouted: out_lbRouted, maxDiff, inkPx: n, ovrChanged };
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

if (!o.slugRouted) ok('Slug path used with LB off'); else fail('LB routed with fill off');
if (o.lbRouted) ok('bundle with a transform override routes through the analytic path (LB on)');
else fail('bundle did NOT route to the analytic fill');
if (o.inkPx > 1000) ok('shapes render (' + o.inkPx + ' ink px)'); else fail('barely rendered: ' + o.inkPx);
if (o.ovrChanged > 300) ok('the transform override visibly changed the render (' + o.ovrChanged + ' px moved vs no-override)');
else fail('transform override had no effect (only ' + o.ovrChanged + ' px differ from no-override)');
if (o.maxDiff <= 6) ok('render parity: LB+per-shape-Slug transform matches all-Slug (mean channel diff ' + o.maxDiff + ')');
else fail('transform-override interior != all-Slug (mean channel diff ' + o.maxDiff + ')');

await browser.close();
server.close();
if (failures) { console.error('\\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\\nlbTransformOverrideParitySmoke: all assertions passed');

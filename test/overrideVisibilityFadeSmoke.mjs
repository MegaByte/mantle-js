// Per-shape override `visibility` is a CONTINUOUS [0,1] fade, not binary
// on/off.
//
// The GL vertex shader folds visibility into the override tint alpha
// (vFill *= vOverrideTint), so visibility 0.5 ⇒ 50% opacity. A single green
// square over BLACK so the green channel directly reads the opacity (over
// white it would stay 255 and hide a binary-collapse fault).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SVG = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">'
  + '<rect id="g" x="20" y="20" width="60" height="60" fill="#00FF00"/></svg>';

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="80" height="80"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
const id = new Float32Array([1,0,0,0,1,0,0,0,1]);
const ov = createOverrideTable(gl, b);
// center-pixel green channel over a BLACK clear → directly = opacity*255.
function centerGreen() {
  const px = new Uint8Array(80*80*4);
  gl.readPixels(0,0,80,80, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px[(40*80 + 40)*4 + 1];
}
window.__byVis = () => {
  const out = {};
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    ov.update(0, { visibility: v });
    renderer.beginFrame([0,0,0,1]);
    renderer.drawBundle(b, { worldMatrix: id, overrides: ov });
    renderer.endFrame();
    out[v] = centerGreen();
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try { const x = readFileSync(path.join(ROOT, p)); res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(x); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

const g = await page.evaluate(() => window.__byVis());
const near = (a, b, tol = 24) => Math.abs(a - b) <= tol;
if (g['0'] === 0) ok('visibility 0 → fully hidden (green 0)'); else fail('vis0 green=' + g['0']);
if (g['1'] >= 230) ok('visibility 1 → fully opaque (green ' + g['1'] + ')'); else fail('vis1 green=' + g['1']);
// The bug: fractional visibility rendered FULL (255). Assert a linear ramp.
if (near(g['0.25'], 64)) ok('visibility 0.25 → ~25% opacity (green ' + g['0.25'] + ')'); else fail('vis0.25 not ~64: ' + g['0.25'] + ' (binary visibility)');
if (near(g['0.5'], 128)) ok('visibility 0.5 → ~50% opacity (green ' + g['0.5'] + ')'); else fail('vis0.5 not ~128: ' + g['0.5'] + ' (binary visibility)');
if (near(g['0.75'], 191)) ok('visibility 0.75 → ~75% opacity (green ' + g['0.75'] + ')'); else fail('vis0.75 not ~191: ' + g['0.75']);
if (g['0.25'] < g['0.5'] && g['0.5'] < g['0.75'])
  ok('opacity ramps monotonically with visibility (CONTINUOUS fade, not binary)');
else fail('non-monotonic: ' + JSON.stringify(g));

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\noverrideVisibilityFadeSmoke: all checks passed');

// textSmallScaleDilationSmoke.mjs — small-scaled text keeps its cover-quad
// AA band.
//
// The cover-quad half-pixel dilation (mantle.vert.glsl coverQuadDilate)
// must compose worldMatrix into the dilation Jacobian; otherwise a bundle
// drawn small via worldMatrix gets an AA band ~1/scale too thin, starving
// the cover quad and dropping tiny text near a viewport edge on some
// drivers (ANGLE/Metal). This renders a wide text bundle at a small scale,
// centered AND flush against the right edge, and asserts both keep
// substantial ink coverage.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MROOT = path.resolve(__dirname, '..');
const fontB64 = readFileSync(new URL('./font/fixtures/roboto-regular.ttf', import.meta.url)).toString('base64');

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="1179" height="679"></canvas>
<script type="module">
import { createRenderer, loadShaders, createTextBundle, MantleFontAsset } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders);
const FONT = new MantleFontAsset(Uint8Array.from(atob('${fontB64}'), c => c.charCodeAt(0)));
const tb = await createTextBundle(gl, { font: FONT, text: 'Span 3', style: { fontSize: 1, fill: [0,0,0,1] } });
const wm = (tx, ty, s) => new Float32Array([s,0,0, 0,s,0, tx,ty,1]);
function inkPixels() {
  const px = new Uint8Array(1179*679*4); gl.readPixels(0,0,1179,679,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let n = 0; for (let i = 0; i < 1179*679; i++) if (px[i*4] < 200) n++; return n;
}
function draw(tx, ty, s) { r.setViewport(1179,679); r.beginFrame([1,1,1,1]); r.drawBundle(tb.bundle, { worldMatrix: wm(tx,ty,s) }); r.endFrame(); }
// scale 0.078 (~8%) — wide bundle. center vs flush top-right.
draw(0, 0, 0.078);            const center = inkPixels();
draw(0.86, 0.95, 0.078);      const topRight = inkPixels();
window.__out = { center, topRight, renderer: (()=>{const e=gl.getExtension('WEBGL_debug_renderer_info');return e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):'?';})() };
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, {'content-type':'text/html'}); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try { res.writeHead(200, {'content-type':ct}); res.end(readFileSync(path.join(MROOT, p))); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

// Prefer real GPU (the cull is driver-specific); falls back to swiftshader.
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
  const got = await page.waitForFunction('window.__ready === true', { timeout: 30000 }).then(()=>1).catch(()=>0);
  if (!got) { fail('page did not become ready'); }
  else {
    const o = await page.evaluate('window.__out');
    console.log('renderer:', o.renderer, '| center ink px:', o.center, '| top-right ink px:', o.topRight);
    if (o.center > 100) ok('small-scale text renders centered'); else fail('centered small text starved: ' + o.center);
    if (o.topRight > 100) ok('small-scale text renders flush top-right (cover quad not starved at edge)');
    else fail('flush-right small text vanished/starved: ' + o.topRight);
    // The two placements are the same glyphs at the same scale → similar coverage.
    if (o.topRight > o.center * 0.6) ok('right-edge coverage comparable to center (no edge starvation)');
    else fail('right-edge coverage much lower than center: ' + o.topRight + ' vs ' + o.center);
  }
} finally { await browser.close(); server.close(); }
console.log(failures ? `\n${failures} FAILURE(S)` : '\nTEXT-SMALL-SCALE-DILATION PASS');
process.exit(failures ? 1 : 0);

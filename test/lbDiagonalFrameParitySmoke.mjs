// lbDiagonalFrameParitySmoke.mjs — regression for MANTLE_BUG_LOOPBLINN_THIN_
// DIAGONAL_FRAME. A thin fill FRAME formed by two opposite-winding STRAIGHT
// contours with a DIAGONAL folded corner (a page outline: outer CCW + inner inset
// CW, nonzero fills the ~10px border) used to shatter into a fan of inverted
// triangles on the LB earcut fast path — the hole-bridge crossed the thin, near-
// coincident diagonal sliver. Multi-contour straight shapes now route to the CDT
// partition (robust for any hole geometry), so LB matches the Slug ray-cast.
// Single-contour straight polygons (streamed road strips) keep the earcut fast path.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const W = 93, H = 143;
// De-obfuscated real asset (folded-corner page outline): outer CCW page + inner CW inset.
const SVG = `<svg viewBox="0 0 186 286" xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><path d="M135.2 10 L176 51 V276 H10 V10 Z  M139.4 0 H0 V286 H186 V46.9 L183.1 44 L142.3 3 Z" fill="#000"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(${W}, ${H});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);
const read = () => { const px = new Uint8Array(${W}*${H}*4); gl.readPixels(0,0,${W},${H},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const cov = (px,x,y) => { const q = ((${H}-1-y)*${W}+x)*4; return (255-px[q])/255; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const slug = draw('off'), lb = draw('on');
let xor=0, sInk=0, lInk=0;
for (let y=0;y<${H};y++) for (let x=0;x<${W};x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if (s>0.5) sInk++; if (l>0.5) lInk++; if (Math.abs(s-l)>0.5) xor++; }
window.__out = { lbRouted: lb.routed, xor, sInk, lInk };
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
if (o.lbRouted) ok('diagonal frame routes through LB'); else fail('frame did NOT route to LB');
if (o.sInk > 500 && o.lInk > 500) ok('frame fills a real border (Slug ' + o.sInk + ', LB ' + o.lInk + ' px)');
else fail('frame ink implausible (Slug ' + o.sInk + ', LB ' + o.lInk + ')');
if (o.xor <= 30) ok('LB matches Slug — thin diagonal frame no longer shatters (xor ' + o.xor + ')');
else fail('LB diverges from Slug — frame shattering? (xor ' + o.xor + ')');

await browser.close();
server.close();
if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\nlbDiagonalFrameParitySmoke: thin diagonal opposite-winding frame renders via CDT, matches Slug');

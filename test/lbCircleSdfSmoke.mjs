// lbCircleSdfSmoke.mjs — a filled CIRCLE renders through the exact circular-SDF
// primitive (kind 6), not per-≤90° rquad crescents, so it's SEAM-FREE and matches
// Slug's coverage everywhere — including the horizontal/vertical tangents where the
// old crescent seams (at the arc-split points) under-covered by up to ~0.24.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160"><path fill="#3366cc" d="M80 40 A40 40 0 1 0 80 120 A40 40 0 1 0 80 40 Z"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="160" height="160"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(160, 160);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);
const read = () => { const px = new Uint8Array(160*160*4); gl.readPixels(0,0,160,160,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const cov = (px,x,y) => { const q = ((159-y)*160+x)*4; return (255-px[q])/255; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame(); return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const slug = draw('off'), lb = draw('on');
// centre from boundary-pixel bbox, then worst per-pixel coverage error around the ring
let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
for (let y=0;y<160;y++) for (let x=0;x<160;x++){ const s=cov(slug.px,x,y); if (s>0.02&&s<0.98){ if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y; } }
let worst=0, n=0, sum=0;
for (let y=0;y<160;y++) for (let x=0;x<160;x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if ((s>0.02&&s<0.98)||(l>0.02&&l<0.98)){ const e=Math.abs(s-l); if(e>worst)worst=e; sum+=e; n++; } }
window.__out = { lbRouted: lb.routed, worst:+worst.toFixed(3), mean:+(sum/Math.max(n,1)).toFixed(3) };
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
if (o.lbRouted) ok('circle routes through LB'); else fail('circle did NOT route to LB');
// The crescent seams gave worst ~0.24-0.37; the SDF holds every boundary pixel within a
// hair of Slug. Guard well under the seam regime.
if (o.worst <= 0.05) ok('circle matches Slug at every boundary pixel (worst ' + o.worst + ') — seam-free SDF');
else fail('circle boundary coverage diverges from Slug (worst ' + o.worst + ') — crescent seams?');
if (o.mean <= 0.01) ok('mean boundary coverage error ' + o.mean); else fail('mean boundary error too high (' + o.mean + ')');

await browser.close();
server.close();
if (failures) { console.error('\\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\\nlbCircleSdfSmoke: filled circle is seam-free (kind-6 SDF), matches Slug');

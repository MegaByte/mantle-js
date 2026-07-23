// A single-contour curved shape with a concave outline must fill through the
// fast-mesh LB path without losing interior triangles that touch a distant arc.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG = readFileSync(new URL('../examples/_concave_cubic.svg', import.meta.url), 'utf8');
const N = 200;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
const N = ${N};
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(N, N);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const read = () => { const px = new Uint8Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const ink = (px) => { let n = 0; for (let i = 0; i < N * N; i++) { const o = i * 4; if (!(px[o] > 245 && px[o + 1] > 245 && px[o + 2] > 245)) n++; } return n; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1, 1, 1, 1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { ink: ink(read()), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const slug = draw('off'); const lb = draw('on');
window.__out = { slugInk: slug.ink, lbInk: lb.ink, lbRouted: lb.routed }; window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => { try {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  const p = decodeURIComponent(req.url.split('?')[0]);
  res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, p)));
} catch { if (!res.headersSent) res.writeHead(404); res.end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };
const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }
const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
if (o.lbRouted) ok('concave curved shape routes through LB'); else fail('shape did NOT route to LB');
if (o.lbInk >= o.slugInk * 0.95) ok('LB fills the concave shape (ink ' + o.lbInk + ' vs Slug ' + o.slugInk + ')');
else fail('LB UNDER-FILLS the concave shape: ink ' + o.lbInk + ' vs Slug ' + o.slugInk + ' (' + ((o.lbInk / o.slugInk * 100) | 0) + '%) — curveTri over-reach on the fast-mesh earcut');
await browser.close();
server.close();
if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\nlbConcaveCurveFillSmoke: a concave-outline curved shape fills via the fast mesh (chord-edge curveTri guard)');

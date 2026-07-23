// _strokeQuadBench — is the closed-form quad closest-point actually CHEAPER than
// the 5-sample seed + 3 Newton steps it replaced?
//
// e195c8a3's message claims "both cheaper and more accurate". The accuracy half
// was measured (float32 vs a float64 reference); the cost half was asserted, and
// it is not obvious: Cardano buys its exactness with a sqrt plus either two
// pow(.,1/3) or an acos and three cos, all of which are multi-cycle on a GPU,
// against 8 cheap polynomial evaluations.
//
// Fill-rate bound on purpose: many large stroked quadratics, so the fragment
// shader's closest-point solve dominates and the geometry/upload path does not.
//
//   node probes/_strokeQuadBench.mjs          # default 512px
//   N=1024 REPS=40 node probes/_strokeQuadBench.mjs
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const REPS = +(process.env.REPS || 24);
const STROKES = +(process.env.STROKES || 60);

// Wide strokes so a large share of the canvas runs the solve, and varied control
// points so no single degenerate case dominates.
function svg() {
  let b = '';
  for (let i = 0; i < STROKES; i++) {
    const y = 6 + (i * 116) / STROKES;
    const cx = 20 + ((i * 37) % 88);
    const cy = 4 + ((i * 53) % 120);
    b += `<path d="M6 ${y.toFixed(2)} Q${cx} ${cy} 122 ${(128 - y).toFixed(2)}" `
       + `fill="none" stroke="#000" stroke-width="7" stroke-opacity="0.5"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">${b}</svg>`;
}

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders); r.setViewport(${N}, ${N}); r.setLoopBlinnFill('off');
const b = createBundle(gl, await importSvg(${JSON.stringify(svg())}));
r.prepareBundle(b);
// readPixels is the GPU fence — without it we time the submit, not the draw.
const sync = () => { const p = new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0]; };
const frame = () => { r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); return sync(); };
for (let i = 0; i < 8; i++) frame();          // warm: compile, upload, clock ramp
const runs = [];
for (let k = 0; k < ${REPS}; k++) {
  const t0 = performance.now();
  for (let i = 0; i < 4; i++) frame();
  runs.push((performance.now() - t0) / 4);
}
runs.sort((a, b2) => a - b2);
window.__out = { med: runs[runs.length >> 1], min: runs[0], p25: runs[runs.length >> 2] };
window.__ready = true;
</${'script'}></body></html>`;

const server = http.createServer((q, res) => {
  const f = q.url.split('?')[0];
  if (f === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML); return; }
  try {
    const body = readFileSync(path.join(ROOT, f));
    const ext = path.extname(f);
    res.writeHead(200, { 'Content-Type': ext === '.js' || ext === '.mjs' ? 'text/javascript' : ext === '.glsl' ? 'text/plain' : 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nf'); }
});
await new Promise((r) => server.listen(0, r));
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await browser.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 120000 });
await pg.waitForFunction('window.__ready === true', { timeout: 180000, polling: 50 });
const o = await pg.evaluate(() => window.__out);
await browser.close(); server.close();
console.log(`  ${STROKES} stroked quads @${N}px — median ${o.med.toFixed(3)} ms  (p25 ${o.p25.toFixed(3)}, min ${o.min.toFixed(3)})`);

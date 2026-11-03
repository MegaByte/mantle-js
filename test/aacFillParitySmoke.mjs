// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacFillParitySmoke — the wired AAC (Analytic Area Coverage) GPU fill path
// (opts.aacFill) rendered vs Slug across all four curve types (line/quad/cubic/
// native-arc). AAC decodes the same curve buffer + H-bands as Slug but computes
// the exact per-pixel signed AREA (meshFreeRaster.js on the GPU) instead of
// Slug's dual-ray box filter. Asserts: (a) AAC renders each shape, (b) interior
// pixels are BYTE-IDENTICAL to Slug (both solid 1.0), (c) only edge AA differs
// and stays sub-visible (exact-area is ground truth; the delta is Slug's box-
// filter error). Proves buffer decode + band walk + signed-area accumulation +
// winding fold + paint + routing end-to-end.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 256,
  cx = 128,
  cy = 128,
  Ro = 110,
  Ri = 55;
function star(P) {
  const V = [];
  for (let i = 0; i < 2 * P; i++) {
    const r = i % 2 ? Ri : Ro,
      a = (i / (2 * P)) * 2 * Math.PI - Math.PI / 2;
    V.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return V;
}
const V = star(5);
let dStar = `M ${V[0][0].toFixed(2)} ${V[0][1].toFixed(2)} `;
for (let i = 1; i < V.length; i++) dStar += `L ${V[i][0].toFixed(2)} ${V[i][1].toFixed(2)} `;
dStar += 'Z';
// cubic blob (all C) + quadratic petal (all Q) — exercise the quad/cubic AAC loops
const dCubic = 'M60 128 C60 40 196 40 196 128 C196 216 60 216 60 128 Z';
const dQuad = 'M40 128 Q128 20 216 128 Q128 236 40 128 Z';
const dArc = 'M40 128 A88 70 0 1 0 216 128 A88 70 0 1 0 40 128 Z'; // native ellipse arcs
const SHAPES = { star: dStar, cubic: dCubic, quad: dQuad, arc: dArc };
const SVGS = Object.fromEntries(
  Object.entries(SHAPES).map(([k, d]) => [
    k,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#3366cc" d="${d}"/></svg>`,
  ]),
);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const SVGS = ${JSON.stringify(SVGS)};
async function render(svg, aac){
  const sec = await importSvg(svg);
  const r = createRenderer(gl, shaders, aac ? { aacFill: true } : {});
  r.setViewport(${N},${N}); r.setLoopBlinnFill('off');   // force the Slug/AAC per-pixel path
  const b = createBundle(gl, sec);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);
  b.dispose();
  return Array.from(px);
}
const out = {};
try { for (const k of Object.keys(SVGS)) out[k] = { slug: await render(SVGS[k], false), aac: await render(SVGS[k], true) }; }
catch(e){ out.err = String(e); }
window.__out = out;
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await launchBrowser({
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
let out;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000, polling: 100 });
  out = await page.evaluate(() => window.__out);
} catch (e) {
  console.error('setup failed:', e.message);
  await browser.close();
  server.close();
  process.exit(1);
}
await browser.close();
server.close();

let fail = 0;
const ok = (m) => console.log('ok', m);
const bad = (m) => {
  fail++;
  console.error('FAIL', m);
};
if (out.err) {
  bad('render threw: ' + out.err);
} else
  for (const k of ['star', 'cubic', 'quad', 'arc']) {
    const S = out[k].slug,
      A = out[k].aac;
    console.log(`\n[${k}]`);
    let inkA = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (A[i] !== 255 || A[i + 1] !== 255 || A[i + 2] !== 255) inkA++;
    }
    inkA > 2000
      ? ok(`AAC renders (${inkA} non-white px)`)
      : bad(`AAC barely rendered (${inkA} px)`);
    // interior region [cx-16..+16]^2 must be byte-identical (both solid 1.0)
    let interiorMax = 0,
      interiorN = 0;
    for (let y = cy - 16; y < cy + 16; y++)
      for (let x = cx - 16; x < cx + 16; x++) {
        const j = (y * N + x) * 4;
        for (let c = 0; c < 3; c++)
          interiorMax = Math.max(interiorMax, Math.abs(S[j + c] - A[j + c]));
        interiorN++;
      }
    interiorMax === 0
      ? ok(`interior (${interiorN}px) byte-identical Slug==AAC`)
      : bad(`interior differs by ${interiorMax}`);
    // whole-image: only edge AA should differ; mean tiny
    let sum = 0,
      mx = 0,
      nEdge = 0;
    for (let i = 0; i < S.length; i++) {
      const dd = Math.abs(S[i] - A[i]);
      sum += dd;
      if (dd > 0) nEdge++;
      mx = Math.max(mx, dd);
    }
    const mean = sum / S.length;
    ok(
      `whole-image mean diff ${mean.toFixed(3)}/255, max ${mx}, ${nEdge} ch differ (exact-area vs box-filter AA)`,
    );
    mean < 2.0
      ? ok(`mean < 2/255 (sub-visible AA difference)`)
      : bad(`mean diff too large: ${mean.toFixed(2)}`);
  }
console.log(fail ? `\nAAC-SLICE FAIL (${fail})` : `\nAAC-SLICE PASS`);
process.exit(fail ? 1 : 0);

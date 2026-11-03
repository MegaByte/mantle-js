// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugQuadScaleSmoke — guards the Slug quad ray-solver's STABLE ROOT PAIR at large
// coordinates (_coverage.glsl slugSolveHorizQuad/slugSolveVertQuad).
//
// A symmetric quad (ctrl == chord midpoint) has a == 0 exactly, but the RAY-CENTERED
// float32 coordinates reintroduce a ≈ coordinate-ulp. At small viewports that noise sits
// below a 1/65536 linear-path test; at ≥ ~1000 em units it slips past, and the canceling
// combination (b ∓ d)/a loses every significant bit — the root lands anywhere in ±1 (t2 ==
// 1.0 exactly: the crossing reported at the far ENDPOINT). Winding miscounts render as
// WHITE SLITS hanging from a wide symmetric quad down to its corner row, plus near-apex
// under-coverage — SCALE-DEPENDENT, invisible at 192px, gross at 1536px (a fullscreen
// 2x-DPR shape size).
//
// Asserts: the bulged box rendered by Slug at 1536px, box-downsampled 8x, matches the
// same shape rendered at 192px to AA-residual level (the fixture renders identically at
// both scales by construction): at most a handful of corner pixels off, max well under 100
// (the canceling combination puts hundreds of pixels off by >0.1, max 255: full-white slits).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 192,
  SS = 8;
const f = (n) => {
  const a = 0.18 * n,
    b = 0.82 * n,
    bulge = 0.14 * n,
    m = n / 2;
  return `M ${a} ${a} Q ${m} ${a - bulge} ${b} ${a} L ${b} ${b} Q ${m} ${b + bulge} ${a} ${b} Z`;
};
const svg = (n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${f(n)}"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N * SS}" height="${N * SS}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('off');
const grab=(w,h)=>{const p=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a=new Float64Array(w*h); for(let i=0;i<w*h;i++) a[i]=p[i*4]; return a;};
window.__run = async (svgLo, svgHi) => {
  const render=async(txt,n)=>{const b=createBundle(gl, await importSvg(txt,{preserveViewport:true}));
    r.setViewport(n,n); gl.viewport(0,0,n,n);
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
    const a=grab(n,n); b.dispose(); return Array.from(a);};
  return { lo: await render(svgLo, ${N}), hi: await render(svgHi, ${N * SS}) };
};
window.__ready=true;</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
const o = await pg.evaluate((lo, hi) => window.__run(lo, hi), svg(N), svg(N * SS));
await br.close();
server.close();

// 8x box-downsample the hi render, diff against the lo render
const down = new Float64Array(N * N);
for (let y = 0; y < N; y++)
  for (let x = 0; x < N; x++) {
    let s = 0;
    for (let j = 0; j < SS; j++)
      for (let i = 0; i < SS; i++) s += o.hi[(y * SS + j) * N * SS + (x * SS + i)];
    down[y * N + x] = s / (SS * SS);
  }
let bad = 0,
  mx = 0;
for (let i = 0; i < N * N; i++) {
  const d = Math.abs(down[i] - o.lo[i]);
  if (d > 25) bad++;
  if (d > mx) mx = d;
}
let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
check(
  bad <= 12,
  `slug 1536px vs 192px: bad px (${bad} <= 12; the unstable root pair gives hundreds)`,
);
check(
  mx < 100,
  `slug 1536px vs 192px: max diff (${mx.toFixed(1)} < 100; the unstable root pair gives 255 — full-white slits)`,
);
if (fail) {
  console.error(`SLUG-QUAD-SCALE FAIL (${fail})`);
  process.exit(1);
}
console.log('SLUG-QUAD-SCALE PASS');

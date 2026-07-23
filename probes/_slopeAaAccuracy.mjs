#!/usr/bin/env node
// probes/_slopeAaAccuracy.mjs — default Slug combiner vs MANTLE_SLOPE_AA vs
// MANTLE_EXACT_EDGE, measured against an 8x supersampled reference, on straight
// edges swept through angles (the default two-ray blend is exact at 0/90 deg and
// weakest at 45 deg) plus a circle (curve chord behavior) and a thin sliver
// (multi-edge pixels must fall back to the blend, not corrupt).
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256, SS = 8;

const tri = (n, angDeg) => {
  // Big wedge with one edge at angDeg through the centre.
  const a = (angDeg * Math.PI) / 180, c = n / 2;
  const dx = Math.cos(a), dy = Math.sin(a);
  const L = n;
  const x1 = c - dx * L, y1 = c - dy * L, x2 = c + dx * L, y2 = c + dy * L;
  const nx = -dy, ny = dx;
  return `M ${x1} ${y1} L ${x2} ${y2} L ${x2 + nx * L} ${y2 + ny * L} L ${x1 + nx * L} ${y1 + ny * L} Z`;
};
const circle = (n) => { const c = n / 2, r = 0.36 * n; return `M ${c - r} ${c} A ${r} ${r} 0 1 0 ${c + r} ${c} A ${r} ${r} 0 1 0 ${c - r} ${c} Z`; };
const sliver = (n) => { const c = n / 2; return `M ${0.1 * n} ${c} L ${0.9 * n} ${c - 0.6} L ${0.9 * n} ${c + 0.6} Z`; };

const CASES = {
  deg45: tri(N, 45), deg30: tri(N, 30), deg60: tri(N, 60), deg15: tri(N, 15),
  deg0: tri(N, 0), circle: circle(N), sliver: sliver(N),
};
const wrap = (d, n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${n}" height="${n}"><path fill="#000" d="${d}"/></svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SS = ${SS};
const mk = (o) => { const r = createRenderer(gl, shaders, o); r.setLoopBlinnFill('off'); return r; };
const rDef = mk({}), rSlope = mk({ slopeAa: true }), rExact = mk({ exactEdgeAa: true });
const grab = (w, h) => { const p = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, p);
  const a = new Float64Array(w * h); for (let i = 0; i < w * h; i++) a[i] = p[i * 4]; return a; };
const render = async (r, svg, n) => {
  const sec = await importSvg(svg);
  const b = createBundle(gl, sec);
  r.setViewport(n, n); gl.viewport(0, 0, n, n);
  r.beginFrame([1, 1, 1, 1]); r.drawBundle(b); r.endFrame();
  return grab(n, n);
};
const down = (hi) => { const o = new Float64Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += hi[(y * SS + j) * N * SS + x * SS + i];
    o[y * N + x] = s / (SS * SS); } return o; };
const stat = (a, ref) => { let mean = 0, mx = 0, cnt = 0;
  for (let i = 0; i < N * N; i++) { if (ref[i] > 2 && ref[i] < 253) { const d = Math.abs(a[i] - ref[i]); mean += d; mx = Math.max(mx, d); cnt++; } }
  return { mean: +(mean / Math.max(cnt, 1)).toFixed(3), max: +mx.toFixed(1), n: cnt }; };
const CASES = ${JSON.stringify(CASES)};
const out = {};
for (const [name, d] of Object.entries(CASES)) {
  const svgLo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + N + ' ' + N + '" width="' + N + '" height="' + N + '"><path fill="#000" d="' + d + '"/></svg>';
  const svgHi = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + N + ' ' + N + '" width="' + (N * SS) + '" height="' + (N * SS) + '"><path fill="#000" d="' + d + '"/></svg>';
  const ref = down(await render(rDef, svgHi, N * SS));
  out[name] = {
    def: stat(await render(rDef, svgLo, N), ref),
    slope: stat(await render(rSlope, svgLo, N), ref),
    exact: stat(await render(rExact, svgLo, N), ref),
  };
}
document.title = 'DONE ' + JSON.stringify(out);
</${'script'}></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(HTML); return; }
  try {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    const ext = path.extname(p);
    res.setHeader('content-type', ext === '.js' || ext === '.mjs' ? 'text/javascript' : ext === '.glsl' ? 'text/plain' : 'application/octet-stream');
    res.end(readFileSync(p));
  } catch { res.statusCode = 404; res.end(); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => document.title.startsWith('DONE'), { timeout: 120000 });
const out = JSON.parse((await page.title()).slice(5));
for (const [k, v] of Object.entries(out)) {
  console.log(`${k.padEnd(7)} def mean=${v.def.mean} max=${v.def.max} | slope mean=${v.slope.mean} max=${v.slope.max} | exact mean=${v.exact.mean} max=${v.exact.max} (n=${v.def.n})`);
}
await browser.close(); server.close();

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Renders one open-subpath fixture (SVG=, default /tmp/openFill_min_open.svg) under Slug and prints its
// ink and grey-level histogram. It prepends one debug define to every shader (MANTLE_OPEN_FILL_DEBUG by
// default, MANTLE_OPEN_FILL_NOSECANT or MANTLE_OPEN_FILL_WIND=n on request, none with BASE=1); the current
// shaders read none of them, so every mode measures the plain Slug render.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
const ROOT = process.env.MANTLE_ROOT || new URL('../..', import.meta.url).pathname; // the package tree to probe (default: this one)
const { launchBrowser } = await import(ROOT + '/test/_launch.mjs');
const SVG = process.env.SVG || '/tmp/openFill_min_open.svg';
const N = +(process.env.N || 256);
// Built in NODE and interpolated: a `process.env` lookup inside the page script would be a
// ReferenceError there, and the page would silently fall back to no define at all.
const MODE = process.env.MODE || '';
const DRAWS = +(process.env.DRAWS || 1);
const DEFINE = process.env.BASE
  ? ''
  : process.env.NOSECANT
    ? '#define MANTLE_OPEN_FILL_NOSECANT 1\\n'
    : process.env.WIND
      ? `#define MANTLE_OPEN_FILL_WIND ${process.env.WIND}\\n`
      : '#define MANTLE_OPEN_FILL_DEBUG 1\\n';
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const base = await loadShaders(new URL('/src/shaders/', location.href).href);
const withDef = (srcs) => { const o = {};
  for (const k of Object.keys(srcs)) { const v = srcs[k];
    o[k] = typeof v === 'string' ? v.replace(/^(#version[^\\n]*\\n)/, (m)=>m+'${DEFINE}') : v; }
  return o; };
const R = createRenderer(gl, withDef(base), {}); if (R.ready) await R.ready;
window.__go = async (txt) => {
  // MODE=zz replicates _zzEnginePaint's slug arm EXACTLY (setLoopBlinnFill('off') on a renderer
  // built with default options); anything else is the direct pin.
  if ('${MODE}' === 'zz') { if (R.setLoopBlinnFill) R.setLoopBlinnFill('off'); }
  else R.setFillEngine({ route:'none', kernel:'slug' });
  const b = createBundle(gl, await importSvg(txt, { preserveViewport:true }));
  if (R.prepareBundle) R.prepareBundle(b);
  R.setViewport(${N},${N}); gl.viewport(0,0,${N},${N});
  // DRAWS=n repeats the frame, as _zzEnginePaint does (8 warm-up + FRAMES timed). If the clear
  // does not fully reset, repeated compositing inflates coverage and the ink climbs.
  for (let d = 0; d < ${DRAWS}; d++) { R.beginFrame([1,1,1,1]); R.drawBundle(b); R.endFrame(); }
  gl.finish();
  const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);
  const hist = {}; let ink = 0;
  for (let i=0;i<px.length;i+=4){ const v=px[i]; hist[v]=(hist[v]||0)+1; if (v < 250) ink++; }
  hist.__ink = ink;
  b.dispose(); return hist;
};
window.__ready = true;
</script></body></html>`;
const srv = http.createServer((q, res) => {
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
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'],
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 200)));
pg.on('console', (m) => {
  if (m.type() === 'error') console.error(' [console]', m.text().slice(0, 160));
});
await pg.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
const hist = await pg.evaluate((t) => window.__go(t), readFileSync(SVG, 'utf8'));
const ink = hist.__ink;
delete hist.__ink;
const tot = Object.values(hist).reduce((a, b) => a + b, 0);
console.log(
  `   INK (any non-white): ${ink} px = ${((100 * ink) / tot).toFixed(3)}%   [true area 10.350%]`,
);
console.log(`${path.basename(SVG)}: grey-level histogram of the render`);
for (const k of Object.keys(hist)
  .map(Number)
  .sort((a, b) => b - a))
  console.log(
    `   value ${String(k).padStart(3)} (${(k / 255).toFixed(2)}) : ${String(hist[k]).padStart(7)} px  ${((100 * hist[k]) / tot).toFixed(1)}%`,
  );
await br.close();
srv.close();

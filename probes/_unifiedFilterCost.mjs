// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _unifiedFilterCost.mjs — what the offscreen-filter SPLIT costs per frame.
//
// The unified route isolates a filtered shape through _morphShapeFilter, which is
// the morph path's machinery and has NO result cache — "a morph is dynamic, so the
// key would miss every frame anyway". renderer.js's classic drawList loop, by
// contrast, carries the tier-2b per-(filterId, shape) cache and renders into a
// rect-bounded RT rather than a canvas-sized one.
//
// So for a STATIC filtered bundle redrawn every frame, the split may be re-running
// the blur where the classic route skipped it. debugStats.filterEvalCount is the
// direct measure: it counts kernel evaluations, and a cache hit does not bump it.
//
// Reports evals per frame and GL draws per frame for both routes.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const S = 256,
  FRAMES = 30;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
<defs><filter id="b"><feGaussianBlur stdDeviation="1.2"/></filter></defs>
<circle cx="12" cy="12" r="7" fill="#c03030"/>
<circle cx="20" cy="14" r="7" fill="#3060c0" filter="url(#b)"/>
<circle cx="28" cy="26" r="6" fill="#30a040"/>
</svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${S}" height="${S}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = ${S}, FRAMES = ${FRAMES};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
let draws = 0;
for (const m of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) {
  const o = gl[m].bind(gl); gl[m] = (...a) => { draws++; return o(...a); };
}
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

async function run(mode) {
  const opts = { aacFill: false };
  if (mode === 'classic') opts.unifiedFillFilters = false;
  const r = createRenderer(gl, shaders, opts);
  const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
  r.setLoopBlinnFill('on');
  try { r.prepareBundle(b); } catch {}
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  const frame = () => { r.setViewport(S,S); r.beginFrame([0,0,0,1]); r.drawBundle(b, {}); r.endFrame(); };
  for (let i = 0; i < 6; i++) { frame(); if (r.precompileFills) { try { r.precompileFills(); } catch {} } }
  // Baseline AFTER warm-up: the warm frames legitimately evaluate the filter.
  const e0 = r.debugStats.filterEvalCount | 0;
  draws = 0;
  for (let i = 0; i < FRAMES; i++) frame();
  const st = r.debugStats;
  const out = { gate: st.unifiedFillGate || '?',
                evalsPerFrame: ((st.filterEvalCount | 0) - e0) / FRAMES,
                drawsPerFrame: draws / FRAMES,
                uniFilterDraws: st.unifiedFilterDraws | 0 };
  try { b.dispose(); } catch {}
  return out;
}
window.out = { unified: await run('unified'), classic: await run('classic') };
</script></body></html>`;

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, { 'content-type': mime(u.pathname) + '; charset=utf-8' });
    res.end(b);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerr]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
try {
  await page.waitForFunction('typeof window.out !== "undefined"', { timeout: 200000 });
} catch {
  console.log('page never finished');
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => window.out);
await browser.close();
server.close();

console.log('  route     gate               filter evals/frame   GL draws/frame');
for (const k of ['unified', 'classic']) {
  const v = r[k];
  console.log(
    `  ${k.padEnd(9)} ${String(v.gate).padEnd(18)} ${String(v.evalsPerFrame).padStart(18)} ` +
      `${String(v.drawsPerFrame).padStart(16)}`,
  );
}
const u = r.unified.evalsPerFrame,
  c = r.classic.evalsPerFrame;
console.log('');
console.log(
  u > c + 0.01
    ? `  UNCACHED: the split re-evaluates the filter ${(u - c).toFixed(2)} more times per frame than the` +
        ` classic route, whose tier-2b per-(filterId, shape) cache skips it on a static redraw.`
    : `  No per-frame filter-eval cost: ${u.toFixed(2)} vs ${c.toFixed(2)} evals/frame.`,
);

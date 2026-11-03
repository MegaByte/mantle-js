// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _morphDrawBreakdown.mjs — WHAT are a morph's GL draws, per engine?
//
// The unified route collapsed the LB side of a morph to one draw, but Slug still
// costs 3-4 and the LB side still pays for whatever is not the fill. "3 draws"
// is not actionable; this attributes each one to the function that issued it, by
// reading the call stack at the drawArrays/drawElements itself.
//
// Stack frames are the only attribution that works here: several passes share
// one program (the lerp pre-pass and its fixup), so CURRENT_PROGRAM cannot tell
// them apart, and the renderer does not tag its draws.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const A = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const B = 'M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z';
const svg = (d, attrs) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="${d}" ${attrs}/></svg>`;

const CASES = {
  solid: [svg(A, 'fill="#3060c0"'), svg(B, 'fill="#3060c0"')],
  stroked: [
    svg(A, 'fill="#3060c0" stroke="#102040" stroke-width="3"'),
    svg(B, 'fill="#3060c0" stroke="#102040" stroke-width="3"'),
  ],
  strokeOnly: [
    svg(A, 'fill="none" stroke="#3060c0" stroke-width="3"'),
    svg(B, 'fill="none" stroke="#3060c0" stroke-width="3"'),
  ],
};

const SIZE = 160;
const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const S = ${SIZE};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, depth: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
let log = null;
// Walk out of this wrapper to the first frame in renderer code and keep its
// function name — that is the pass, which is what we want to count.
const site = () => {
  const st = (new Error()).stack || '';
  const lines = st.split('\\n').slice(2, 14);
  for (const l of lines) {
    const m = l.match(/at ([A-Za-z_$][\\w$.]*)\\s/);
    if (m && !/^(site|Object\\.|Module\\.)/.test(m[1])) return m[1];
  }
  return '?';
};
for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  const o = gl[m].bind(gl);
  gl[m] = (...a) => { if (log) { const k = site(); log[k] = (log[k] | 0) + 1; } return o(...a); };
}
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

async function shoot(srcSvg, dstSvg, mode) {
  const r = createRenderer(gl, shaders, { aacFill: false });
  const morph = createShapeMorph(gl, createBundle(gl, await importSvg(srcSvg)),
                                     createBundle(gl, await importSvg(dstSvg)));
  r.setLoopBlinnFill(mode === 'slug' ? 'off' : 'on');
  const frame = (t) => { morph.setT(t); r.setViewport(S, S);
    r.beginFrame([0, 0, 0, 1]); r.drawBundle(morph, {}); r.endFrame(); };
  frame(0);
  if (mode !== 'slug' && r.awaitLbReady) { try { await r.awaitLbReady(morph, 20000); } catch {} }
  for (let i = 0; i < 30; i++) {
    frame(0.25);
    if (r.precompileFills) { try { r.precompileFills(); } catch {} }
    if (mode === 'slug' || (r.debugStats && r.debugStats.unifiedFillDraws | 0) > 0) break;
    await new Promise((res) => requestAnimationFrame(res));
  }
  log = {};
  frame(0.5);                       // a t that is neither endpoint: full work
  const byPass = log; log = null;
  try { morph.dispose(); } catch {}
  return byPass;
}

const out = {};
for (const [name, [sa, sb]] of Object.entries(${JSON.stringify(CASES)})) {
  out[name] = { slug: await shoot(sa, sb, 'slug'), lb: await shoot(sa, sb, 'lb') };
}
window.out = out;
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
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error') logs.push(m.text());
});
page.on('pageerror', (e) => logs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
try {
  await page.waitForFunction('typeof window.out !== "undefined"', { timeout: 280000 });
} catch {
  console.log('page never finished:\n  ' + (logs.join('\n  ') || '(none)'));
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => window.out);
await browser.close();
server.close();

for (const [k, v] of Object.entries(r)) {
  const tot = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  console.log(`\n${k}   slug ${tot(v.slug)} draws   lb ${tot(v.lb)} draws`);
  const keys = [...new Set([...Object.keys(v.slug), ...Object.keys(v.lb)])];
  for (const key of keys) {
    console.log(
      `   ${key.padEnd(34)} slug ${String(v.slug[key] || 0).padStart(3)}   lb ${String(v.lb[key] || 0).padStart(3)}`,
    );
  }
}

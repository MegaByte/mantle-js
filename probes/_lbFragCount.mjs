// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbFragCount.mjs — how many PARTIAL LB fragments land on one pixel, by kind?
//
// The unified draw composites with OVER. Two partial fragments on one pixel give
// 0.5 OVER 0.5 = 0.75 where MAX(0.5, 0.5) = 0.5 is exact, so the only thing that
// matters is the per-PIXEL fragment multiplicity — not whether the triangles
// partition the plane. They do; a pixel is an area, so disjoint triangles still
// both rasterize to it.
//
// Needs MANTLE_LB_FRAGDBG in mantle.frag.glsl (each partial fragment adds 1/64
// to alpha and to its kind's channel) and a `npm run build:shaders` — loadShaders
// PREFERS ./generated/, so an unbuilt edit is invisible.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function quadEllipse(cx, cy, rx, ry) {
  const N = 8,
    pt = (a) => [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  const tan = (a) => [-rx * Math.sin(a), ry * Math.cos(a)];
  let d = '';
  for (let i = 0; i < N; i++) {
    const a0 = (2 * Math.PI * i) / N,
      a1 = (2 * Math.PI * (i + 1)) / N;
    const p0 = pt(a0),
      p1 = pt(a1),
      t0 = tan(a0),
      t1 = tan(a1);
    const det = t0[0] * -t1[1] - t0[1] * -t1[0];
    const k = ((p1[0] - p0[0]) * -t1[1] - (p1[1] - p0[1]) * -t1[0]) / det;
    const c = [p0[0] + k * t0[0], p0[1] + k * t0[1]];
    d += (i ? '' : `M${p0[0]} ${p0[1]}`) + ` Q${c[0]} ${c[1]} ${p1[0]} ${p1[1]}`;
  }
  return d + ' Z';
}
const D = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const MULTI =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
  `<path fill="#3060c0" d="${quadEllipse(20, 20, 17, 11)}"/></svg>`;
const LONE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M14 70 Q50 8 86 70 Z" fill="#3060c0"/></svg>';
// The translucent case: with alpha < 1 a SATURATED fragment painted twice is
// visible (0.5 then 0.75), so multiplicity matters over the whole shape, not just
// on the AA rim. THRESH=0.004 counts every fragment the route actually paints.
const CUBIC =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
  `<path fill="#3060c0" fill-opacity="0.5" d="${D}"/></svg>`;
// The shape _aaSignedByEngine measures LB over-covering by +0.049 while line/quad/arc sit at
// +0.001: a closed contour of cubic segments. Built here so the two probes agree on the input.
function bulgeContour(n, kind) {
  const R = 44,
    CX = 64,
    CY = 64,
    P = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    P.push([CX + R * Math.cos(a), CY + R * Math.sin(a)]);
  }
  let d = 'M' + P[0][0].toFixed(4) + ' ' + P[0][1].toFixed(4);
  for (let i = 0; i < n; i++) {
    const p = P[i],
      q = P[(i + 1) % n],
      mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2;
    const bx = CX + (mx - CX) * 1.18,
      by = CY + (my - CY) * 1.18;
    if (kind === 'quad')
      d += ` Q${bx.toFixed(4)} ${by.toFixed(4)} ${q[0].toFixed(4)} ${q[1].toFixed(4)}`;
    else
      d += ` C${bx.toFixed(4)} ${by.toFixed(4)} ${bx.toFixed(4)} ${by.toFixed(4)} ${q[0].toFixed(4)} ${q[1].toFixed(4)}`;
  }
  return d + ' Z';
}
const BULGE_C =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
  `<path fill="#3060c0" d="${bulgeContour(16, 'cubic')}"/></svg>`;
const BULGE_Q =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
  `<path fill="#3060c0" d="${bulgeContour(16, 'quad')}"/></svg>`;

const SIZE = Number(process.env.SEAM_SIZE || 200);
const THRESH = process.env.FRAGDBG_THRESH || '0.004';
const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = ${SIZE};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

async function shoot(svg, defines) {
  // NO_CLAIM=1 disables the depth claim. The claim's whole job is to suppress the
  // SECOND fragment on a doubly-covered pixel, so measuring multiplicity with it ON
  // can only ever report 1 — which is exactly the trap the first run of this probe
  // fell into, and the basis of a 'LB has zero overdraw' claim that was wrong.
  const r = createRenderer(gl, shaders, { aacFill: false, fillDefines: defines,
    unifiedFillDepthClaim: ${JSON.stringify(!process.env.NO_CLAIM)} });
  const b = createBundle(gl, await importSvg(svg));
  r.setLoopBlinnFill('on');
  try { r.prepareBundle(b); } catch {}
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  // TRANSPARENT clear: an opaque clear pins alpha at 255 and the fragment count
  // (which lives in alpha) reads 64 on every pixel of the canvas.
  const frame = () => { r.setViewport(S, S); r.beginFrame([0, 0, 0, 0]); r.drawBundle(b, {}); r.endFrame(); };
  frame(); frame();
  const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  try { b.dispose(); } catch {}
  return px;
}

// 1/64 per fragment == 255/64 == 3.98 in 8-bit; round to the nearest count.
const n = (v) => Math.round(v / (255 / 64));
const out = {};
for (const [name, svg] of [['multi', ${JSON.stringify(MULTI)}], ['lone', ${JSON.stringify(LONE)}], ['cubicTrans', ${JSON.stringify(CUBIC)}], ['bulgeCubic', ${JSON.stringify(BULGE_C)}], ['bulgeQuad', ${JSON.stringify(BULGE_Q)}]]) {
  const px = await shoot(svg, ['MANTLE_LB_FILL', 'MANTLE_LB_FRAGDBG ${THRESH}']);
  const hist = {}, pairs = {}, kinds = {};
  let touched = 0, worstN = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4, tot = n(px[o + 3]);
    if (!tot) continue;
    touched++;
    if (tot > worstN) worstN = tot;
    hist[tot] = (hist[tot] | 0) + 1;
    // WHICH KIND paints each partial pixel. With multiplicity 1 — which is what these shapes
    // measure — R is dbgU*kind/15 for that single fragment, so the kind decodes exactly. The
    // multiplicity histogram says a pixel is painted ONCE; it does not say by what, and when the
    // over-coverage is per-fragment that is the question.
    if (tot === 1) {
      const k1 = Math.round(px[o] / (255 / 64) * 15);
      kinds[k1] = (kinds[k1] | 0) + 1;
    }
    if (tot > 1) {
      // R accumulates dbgU*kind/15 per fragment, so kindSum*15 is the sum of the
      // kinds that landed here; B counts kind-0 fragments and G the saturated ones.
      const kindSum = Math.round(px[o] / (255 / 64) * 15);
      const sat = n(px[o + 1]), k0 = n(px[o + 2]);
      const key = \`n=\${tot} kindSum=\${kindSum} kind0=\${k0} saturated=\${sat}\`;
      pairs[key] = (pairs[key] | 0) + 1;
    }
  }
  out[name] = { touched, worstN, hist, pairs, kinds };
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
  protocolTimeout: 180000,
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
  await page.waitForFunction('typeof window.out !== "undefined"', { timeout: 120000 });
} catch {
  console.log('page never finished:\n  ' + (logs.join('\n  ') || '(none)'));
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => window.out);
await browser.close();
server.close();

for (const [name, v] of Object.entries(r)) {
  console.log(`\n${name}: ${v.touched} partial-fragment pixels, worst multiplicity ${v.worstN}`);
  console.log('  fragments/pixel: ' + JSON.stringify(v.hist));
  if (v.kinds && Object.keys(v.kinds).length)
    console.log('  kind of the single fragment: ' + JSON.stringify(v.kinds));
  const top = Object.entries(v.pairs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [k, c] of top) console.log(`    ${c.toString().padStart(5)}  ${k}`);
}

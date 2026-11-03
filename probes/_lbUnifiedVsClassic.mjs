// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbUnifiedVsClassic.mjs — does the OVER route differ from the MAX route?
//
// The one comparison that answers step 3a, and it must hold the SHADER VARIANT
// fixed: MANTLE_LB_FILL is not output-neutral, so comparing "define on" against
// "define off" measures the variant and the route at once. Both renderers here
// compile with the define; only `_unifiedFillReady` differs, so the delta is the
// route and nothing else.
//
//   classic = LB coverage to an RT under blendEquation(MAX), then composite
//   unified = cover quads + LB triangles in one drawArrays under OVER

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
const SHAPES = {
  multi:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
    `<path fill="#3060c0" d="${quadEllipse(20, 20, 17, 11)}"/></svg>`,
  lone:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<path d="M14 70 Q50 8 86 70 Z" fill="#3060c0"/></svg>',
  sep:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
    '<path fill="#3060c0" d="M12 8 L28 8 Q36 8 36 20 L36 22 Q36 32 28 32 L12 32 Q4 32 4 22 L4 20 Q4 8 12 8 Z"/></svg>',
  cubic:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
    '<path fill="#3060c0" d="M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z"/></svg>',
};

const SIZE = Number(process.env.SEAM_SIZE || 200);
const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = ${SIZE};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
let draws = 0;
for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  const orig = gl[m].bind(gl);
  gl[m] = (...a) => { draws++; return orig(...a); };
}
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

async function shoot(svg, mode) {
  const opts = { aacFill: false };
  // 'unified' takes the DEFAULT path: no fillDefines at all, so MANTLE_LB_FILL
  // has to come from the per-bundle variant machinery. That is the thing being
  // verified — forcing the define would prove only that the shader works.
  if (mode === 'classic') opts.unifiedFill = false;
  const r = createRenderer(gl, shaders, opts);
  // Prove the route: count actual entries into the unified draw. A GL draw count
  // of 1 does NOT separate them — the classic combined route also emits one.
  // The wrapper must go on the PUBLIC facade's forwarder target, so count via a
  // debugStats counter the route itself bumps.
  let uniHits = 0;
  const b = createBundle(gl, await importSvg(svg));
  r.setLoopBlinnFill(mode === 'slug' ? 'off' : 'on');
  try { r.prepareBundle(b); } catch {}
  if (mode !== 'slug' && r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  if (r.prewarmBundle) { try { r.prewarmBundle(b); } catch {} }
  // Drain the variant + pipeline warm queues the way a load screen does. Without
  // it the unified route waits for 45 consecutive slack frames of PSO warm and a
  // probe measures the classic fallback forever.
  if (r.precompileFills) { try { r.precompileFills(); } catch {} }
  const frame = () => { r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); };
  // The unified route waits for its variant to LINK and for the Metal pipeline to
  // warm — both drain one item per frame off the critical path — so a two-frame
  // probe would always measure the classic fallback. Spin real frames until it
  // engages, which is what a running scene does anyway.
  const settle = async () => {
    for (let i = 0; i < 240; i++) {
      frame();
      if ((r.debugStats && r.debugStats.unifiedFillDraws | 0) > 0) return true;
      await new Promise((res) => requestAnimationFrame(res));
    }
    return false;
  };
  if (mode === 'unified') await settle(); else frame();
  const before = (r.debugStats && r.debugStats.unifiedFillDraws | 0) || 0;
  draws = 0; frame();
  const nDraws = draws;
  uniHits = ((r.debugStats && r.debugStats.unifiedFillDraws | 0) || 0) - before;
  const gate = (r.debugStats && r.debugStats.unifiedFillGate) || '?';
  const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  try { b.dispose(); } catch {}
  return { px, nDraws, uniHits, gate };
}

// Rim-only signed delta in COVERAGE units (value / solid value), as the seam
// smoke does: a mean over every ink pixel understates a local seam ~60x.
function cmp(a, b) {
  let full = 0;
  for (let i = 0; i < S * S; i++) { const v = (a[i*4] + a[i*4+1] + a[i*4+2]) / 3; if (v > full) full = v; }
  full = Math.max(full, 1);
  let n = 0, sum = 0, maxPos = 0, maxNeg = 0, diff = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    const ca = (a[o] + a[o+1] + a[o+2]) / 3 / full, cb = (b[o] + b[o+1] + b[o+2]) / 3 / full;
    if (a[o] !== b[o] || a[o+1] !== b[o+1] || a[o+2] !== b[o+2]) diff++;
    if (ca > 0.03 && ca < 0.97) {
      const d = cb - ca; sum += d; n++;
      if (d > maxPos) maxPos = d;
      if (d < maxNeg) maxNeg = d;
    }
  }
  return { bias: n ? +(sum / n).toFixed(4) : 0, maxPos: +maxPos.toFixed(3),
           maxNeg: +maxNeg.toFixed(3), band: n, diffPx: diff };
}

const out = {};
for (const [name, svg] of Object.entries(${JSON.stringify(SHAPES)})) {
  const slug = await shoot(svg, 'slug');
  const classic = await shoot(svg, 'classic');
  const unified = await shoot(svg, 'unified');
  out[name] = {
    draws: { classic: classic.nDraws, unified: unified.nDraws },
    uniHits: { classic: classic.uniHits, unified: unified.uniHits },
    gate: { classic: classic.gate, unified: unified.gate },
    'unified-vs-classic': cmp(classic.px, unified.px),
    'classic-vs-slug': cmp(slug.px, classic.px),
    'unified-vs-slug': cmp(slug.px, unified.px),
  };
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
  if (m.type() === 'error' || m.text().includes('[uniwhy]')) logs.push(m.text());
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
for (const l of logs) console.log(l);

for (const [name, v] of Object.entries(r)) {
  console.log(
    `\n${name}  draws classic=${v.draws.classic} unified=${v.draws.unified}` +
      `  unifiedRouteHits classic=${v.uniHits.classic} unified=${v.uniHits.unified}` +
      `  gate classic=${v.gate.classic} unified=${v.gate.unified}`,
  );
  for (const k of ['unified-vs-classic', 'classic-vs-slug', 'unified-vs-slug']) {
    const c = v[k];
    console.log(
      `  ${k.padEnd(20)} bias ${String(c.bias).padStart(8)}  maxPos ${String(c.maxPos).padStart(6)}` +
        `  maxNeg ${String(c.maxNeg).padStart(7)}  diffPx ${c.diffPx}`,
    );
  }
}

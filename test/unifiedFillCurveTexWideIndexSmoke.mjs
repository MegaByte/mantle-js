// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedFillCurveTexWideIndexSmoke.mjs -- the unified Loop-Blinn layout indexes shapes and curve blocks with 32-bit
// integers (a 16-bit index, UC_IDX_MAX 65,535, would send a bundle past it to the wide fallback). A bundle with MORE than 65,535
// distinct coefficient blocks stays on the narrow curve-texture layout and draws like Slug.
//
//   1. CPU: buildCurveTexStream builds the bundle (blocks > 65,535) in the 32-bit layout -- the 16-bit limit alone would return null.
//   2. GPU: no overflow, the bundle is NOT marked off the curve-texture layout, the program key keeps MANTLE_LB_CURVE_TEX,
//      one draw, and ink/AA equal Slug.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 3,000 distinct blobs (about 96,000 coefficient blocks) (4 cubics each, perturbed by a seeded generator so no two coefficient blocks coincide).
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const NB = 3000,
  COLS = 60;
const shapes = [];
for (let i = 0; i < NB; i++) {
  const cx = 0.5 + (i % COLS),
    cy = 0.5 + Math.floor(i / COLS),
    r = 0.3 + rnd() * 0.1;
  const p = (a, k) =>
    `${(cx + Math.cos(a) * r * k).toFixed(4)} ${(cy + Math.sin(a) * r * k * (0.8 + rnd() * 0.3)).toFixed(4)}`;
  const k = 0.5523,
    a0 = rnd() * 0.4;
  let d = `M${p(a0, 1)}`;
  for (let q = 0; q < 4; q++) {
    const a = a0 + (q * Math.PI) / 2,
      b = a + Math.PI / 2;
    d +=
      ` C${(cx + Math.cos(a) * r + -Math.sin(a) * r * k + rnd() * 0.03).toFixed(4)} ${(cy + Math.sin(a) * r + Math.cos(a) * r * k + rnd() * 0.03).toFixed(4)}` +
      ` ${(cx + Math.cos(b) * r + Math.sin(b) * r * k + rnd() * 0.03).toFixed(4)} ${(cy + Math.sin(b) * r - Math.cos(b) * r * k + rnd() * 0.03).toFixed(4)}` +
      ` ${(cx + Math.cos(b) * r).toFixed(4)} ${(cy + Math.sin(b) * r * (0.8 + rnd() * 0.3)).toFixed(4)}`;
  }
  shapes.push(`<path d="${d}Z" fill="#${(0x2040a0 + i * 0x010203).toString(16).slice(-6)}"/>`);
}
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 50">' + shapes.join('') + '</svg>';
const OLD_LIMIT = 65535;

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- 1. CPU ----
{
  const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
  globalThis.DOMParser = DP;
  globalThis.XMLSerializer = XS;
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
  const { curveRangeToContours } = await import('../src/renderer/loopBlinn.js');
  const UV = await import('../src/renderer/unifiedFillVerts.js');
  const b = await importSvg(SVG);
  const cf = new Float32Array(b.curves),
    entries = [];
  for (let s = 0; s < b.numShapes; s++) {
    const r = b.curveRangesByShape[s];
    const built = buildLbShape(curveRangeToContours(cf, r.begin, r.end), false, false);
    entries.push({
      kind: 'lb',
      verts: built.pk.verts,
      vertexCount: built.pk.vertexCount,
      shapeIdx: s,
    });
  }
  const u = UV.buildUnifiedFillVerts(entries, null, null, false);
  const t0 = UV.buildCurveTexStream(u.verts, u.vertexCount, false);
  ok(
    !!t0 && t0.blocks > OLD_LIMIT,
    `the 32-bit stream builds past the 16-bit limit (${t0 && t0.blocks} blocks, ${t0 && t0.coefW}x${t0 && t0.coefH} texels)`,
  );
  ok(!!t0 && t0.idx32 === true, 'it is the 32-bit layout');
}

// ---- 2. GPU ----
const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="600" height="500"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W = 600, H = 500;
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sec = await importSvg(${JSON.stringify(SVG)});
let draws = 0;
for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) { const o = gl[m].bind(gl); gl[m] = (...a) => { draws++; return o(...a); }; }
const read = () => { const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
console.log('stage: slug ref');
const rs = createRenderer(gl, shaders, { aacFill: false });
const bs = createBundle(gl, sec);
rs.setViewport(W, H); rs.beginFrame([0, 0, 0, 1]); rs.drawBundle(bs, {}); rs.endFrame();
const slug = read();

const ru = createRenderer(gl, shaders, { aacFill: false, fillDefines: ['MANTLE_LB_FILL'] });
const bu = createBundle(gl, sec);
ru.setLoopBlinnFill('on');
try { ru.prepareBundle(bu); } catch {}
if (ru.awaitLbReady) { try { await ru.awaitLbReady(bu, 120000); } catch {} }
console.log('stage: lb ready');
let served = 0, frames = 0, last = 0;
for (; frames < 600 && !served; frames++) {
  ru.setViewport(W, H); ru.beginFrame([0, 0, 0, 1]); draws = 0; ru.drawBundle(bu, {}); last = draws; ru.endFrame();
  if (['on', 'forced'].includes((ru.debugStats || {}).unifiedFillGate) && last === 1 && !bu._noCurveTex && ((((ru.debugStats || {}).engines || {}).viaRoute || {})['lb@unified'] | 0) > 0) served = 1;
  await new Promise((r) => setTimeout(r, 16));   // not rAF: a headless page does not tick it
}
const uni = read();
let diff = 0, n = 0, inkS = 0, inkU = 0;
for (let i = 0; i < W * H; i++) { const o = i * 4; const a = slug[o] + slug[o + 1] + slug[o + 2], b = uni[o] + uni[o + 1] + uni[o + 2];
  if (a > 24) inkS++; if (b > 24) inkU++; if (a > 24 || b > 24) { n++; for (let k = 0; k < 3; k++) diff += Math.abs(slug[o + k] - uni[o + k]); } }
window.out = { served, frames, last, noCurveTex: !!bu._noCurveTex, overflow: (ru.debugStats || {}).uniCurveTexOverflow | 0, idx32: (ru.debugStats || {}).uniCurveTexIdx32 | 0, gate: (ru.debugStats || {}).unifiedFillGate,
  key: (ru.debugStats || {}).drawnFillVariantKey || '', lbUnified: (((ru.debugStats || {}).engines || {}).viaRoute || {})['lb@unified'] | 0, inkS, inkU, meanDiff: n ? +(diff / (n * 3)).toFixed(2) : 0 };
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
  else if (process.env.SMOKE_VERBOSE) console.log('  [page] ' + m.text());
});
page.on('pageerror', (e) => logs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
try {
  await page.waitForFunction('typeof window.out !== "undefined"', {
    timeout: 150000,
    polling: 100,
  });
} catch {
  console.log('  page never finished:\n    ' + (logs.join('\n    ') || '(none)'));
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => window.out);
await browser.close();
server.close();
console.log(`  ${JSON.stringify(r)}`);
if (logs.length) console.log('  console errors:\n    ' + logs.join('\n    '));
ok(r.overflow === 0, `no overflow was counted (${r.overflow})`);
ok(r.noCurveTex === false, 'the bundle stays on the curve-texture layout');
ok(r.idx32 >= 1, `...in the 32-bit index layout (${r.idx32} build(s))`);
ok(r.key.includes('MANTLE_LB_CURVE_TEX'), 'the selected program key keeps MANTLE_LB_CURVE_TEX');
ok(
  r.key.includes('MANTLE_LB_FILL') && r.lbUnified > 0,
  `the drawn program is the Loop-Blinn unified variant and the engine ledger shows lb@unified (${r.lbUnified})`,
);
ok(
  r.served === 1 && r.last === 1,
  `served in one draw on the narrow layout after ${r.frames} frame(s)`,
);
ok(
  r.inkU > 3000 && Math.abs(r.inkU - r.inkS) / Math.max(r.inkS, 1) < 0.03,
  `ink within 3% of Slug (${r.inkU} vs ${r.inkS})`,
);
ok(r.meanDiff < 12, `mean channel difference vs Slug is AA-scale (${r.meanDiff})`);
console.log(`\nunifiedFillCurveTexWideIndexSmoke: ${fail ? 'FAIL' : 'PASS'}`);
process.exit(fail ? 1 : 0);

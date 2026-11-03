// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacCoverRunGpuSmoke -- the row gate's TINY-SHAPE class. A bundle whose rows are all under aacCoverExtMax px (>= aacPointsRowsMin rows) takes ONE class
// by its median row: points under aacCoverExtMin px, the cover pass from there.
//   (a) a drawing of mid rows is one cover run: the engine ledger says @cover (no points, no mesh), and its pixels match the pinned cover pass;
//   (b) a drawing mostly of small rows (median under aacCoverExtMin) is one points run, mid rows included, and matches the same twin;
//   (c) aacCoverExtMax:0 (off) cuts no cover run.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256;
function blobs(rows, cols, size, x0, y0, tag) {
  let out = '';
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = x0 + i * size + size * 0.05,
        y = y0 + j * size + size * 0.05,
        s = size * 0.9;
      out += `<path fill="#${(((i * 37 + j * 91 + tag) % 3000) + 500).toString(16).padStart(3, '0')}" d="M${x} ${y + s / 2}c0 -${s * 0.39} ${s * 0.22} -${s / 2} ${s / 2} -${s / 2}s${s / 2} ${s * 0.11} ${s / 2} ${s / 2}s-${s * 0.22} ${s / 2} -${s / 2} ${s / 2}s-${s / 2} -${s * 0.11} -${s / 2} -${s / 2}z"/>`;
    }
  return out;
}
// 256 px canvas, viewBox 0..128: 2 px per unit. 8 x 8 mid blobs of 15 units = 30 px; 10 x 30 small blobs of 4 units = 8 px.
const MID = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${blobs(8, 8, 15, 4, 4, 0)}</svg>`;
const MIX = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${blobs(8, 8, 15, 4, 4, 0)}${blobs(7, 30, 4, 4, 100, 7)}</svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const secs = { mid: await importSvg(${JSON.stringify(MID)}, { preserveViewport: true }), mix: await importSvg(${JSON.stringify(MIX)}, { preserveViewport: true }) };
window.__draw = async (doc, opts, pin) => {
  const r = createRenderer(gl, shaders, opts);
  if (pin) r.setFillEngine(pin);
  r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  const b = createBundle(gl, secs[doc]); r.prewarmBundle(b); r.precompileFills();   // the loading call: the point program is finished there, not at the first draw
  for (let i = 0; i < 4; i++) { r.beginFrame([0, 0, 0, 0]); r.drawBundle(b); r.endFrame(); await new Promise((ok) => setTimeout(ok, 30)); }
  const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const st = r.debugStats || {};
  const via = (st.engines && st.engines.viaRoute) || {};
  let ink = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 8) ink++;
  const out = { px: Array.from(px), via, ink, plan: st.rowGatePlan || null };
  b.dispose && b.dispose(); r.dispose && r.dispose();
  return out;
};
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
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: 'load',
    timeout: 15000,
  });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}
const draw = (doc, opts, pin) => page.evaluate((d, o, p) => window.__draw(d, o, p), doc, opts, pin);
const diff = (a, b) => {
  let mx = 0,
    n = 0;
  for (let i = 0; i < a.px.length; i++) {
    const d = Math.abs(a.px[i] - b.px[i]);
    if (d > mx) mx = d;
    if (d > 8) n++;
  }
  return { mx, n };
};
const n = (v, suffix) =>
  Object.entries(v).reduce((s, [k, c]) => s + (k.endsWith(suffix) ? c | 0 : 0), 0);
const COVER = { aacPointsRowsMin: 0, aacPointsBase: 1000 }; // a small base: the whole-bundle gate declines, the row gate cuts
const TWIN_PIN = { route: 'none', kernel: 'slug' };

const TWIN = await draw('mid', {}, TWIN_PIN);
const A = await draw('mid', COVER);
if (A.plan && A.plan.rowsCover === 64 && A.plan.rowsPts === 0)
  ok(`(a) all 64 mid rows (median 27 px) are one cover run (${JSON.stringify(A.plan)})`);
else fail(`(a) plan: ${JSON.stringify(A.plan)} via ${JSON.stringify(A.via)}`);
if (n(A.via, '@points') === 0 && n(A.via, '@unified') === 0 && n(A.via, '@cover') > 0)
  ok(`(a) the engine ledger says cover quads were shaded (${JSON.stringify(A.via)})`);
else fail(`(a) ledger: ${JSON.stringify(A.via)}`);
let d = diff(A, TWIN);
if (d.n === 0 && A.ink > 1000)
  ok(`(a) pixels match the pinned cover pass (max ${d.mx}, ink ${A.ink})`);
else fail(`(a) pixels differ from the pinned cover pass: ${JSON.stringify(d)} ink ${A.ink}`);

const TWIN2 = await draw('mix', {}, TWIN_PIN);
const B = await draw('mix', COVER);
if (B.plan && B.plan.rowsPts === 274 && !B.plan.rowsCover && B.plan.runs === 1)
  ok(`(b) median 7 px: all 274 rows on one points run (${JSON.stringify(B.plan)})`);
else fail(`(b) plan: ${JSON.stringify(B.plan)} via ${JSON.stringify(B.via)}`);
if (n(B.via, '@points') > 0 && n(B.via, '@cover') === 0)
  ok(`(b) the points drew (${JSON.stringify(B.via)})`);
else fail(`(b) ledger: ${JSON.stringify(B.via)}`);
d = diff(B, TWIN2);
if (d.n === 0) ok(`(b) pixels match the pinned cover pass (max ${d.mx})`);
else fail(`(b) pixels differ: ${JSON.stringify(d)}`);

const C = await draw('mid', { aacPointsRowsMin: 0, aacPointsBase: 1000, aacCoverExtMax: 0 });
if (!C.plan || !C.plan.rowsCover)
  ok(
    `(c) aacCoverExtMax:0 cuts no cover run (${JSON.stringify(C.plan)}; ${JSON.stringify(C.via)})`,
  );
else fail(`(c) a cover run with the option off: ${JSON.stringify(C.plan)}`);

await browser.close();
server.close();
if (failures) {
  console.error(`aacCoverRunGpuSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  'aacCoverRunGpuSmoke: the cover run draws the cover pass in painter order and matches its pinned twin',
);

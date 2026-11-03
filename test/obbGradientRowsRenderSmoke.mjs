// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// obbGradientRowsRenderSmoke -- on the GPU: objectBoundingBox gradients on rotated / skewed elements past 2048 gradient rows.
// Each cell renders three documents at 1 px per unit (60 x 44 cells of 8 units, a 6-unit square in each):
//   svg      N squares, each turned (or skewed) by its own transform, all filling with ONE shared objectBoundingBox gradient
//            (red to t=.35, blue from t=.65). Each carrier needs its own placement row, so the bundle has N+1 gradient rows;
//   control  the same art split into chunks of 400 squares, one bundle each, drawn in the same frame (each chunk is far below the
//            2048 rows, so even a capped importer would place it correctly);
//   old      what a 2048-row cap draws past row 2048: the same squares with the axis-aligned placement.
// The render must match the control to 1/255, the analytic probes (turned 90 degrees, local +x runs down: red on top, blue below)
// must read the stated colors at squares before, at and after row 2048, and `old` must differ somewhere (non-vacuous).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COLS = 60,
  W = 480,
  H = 352,
  CHUNK = 400;
const N = +(process.env.OBB_N || 2600);
// The documents are built INSIDE the page (a spec crosses to it): 2600 squares a document is too big to keep as a derived
// examples/smoke fixture, and scripts/genSmokeAssets.mjs derives a fixture from every <svg> string a smoke builds at module scope.
const CELLS = [
  {
    name: `${N} squares turned 90 degrees`,
    svg: [{ lo: 0, hi: N, how: 'r90' }],
    control: chunks('r90'),
    old: [{ lo: 0, hi: N, how: 'axis' }],
    analytic: true,
  },
  {
    name: `${N} squares, half skewed-and-turned, half turned`,
    svg: [{ lo: 0, hi: N, how: 'mix' }],
    control: chunks('mix'),
    old: null,
  },
];
function chunks(how) {
  const out = [];
  for (let lo = 0; lo < N; lo += CHUNK) out.push({ lo, hi: Math.min(N, lo + CHUNK), how });
  return out;
}

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, setDiagnostics } from '/src/index.js';
const warns = []; setDiagnostics({ onWarn: (...a) => warns.push(a.join(' ')) });
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const DEFS = '<defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset=".35" stop-color="#ff0000"/><stop offset=".65" stop-color="#0000ff"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs>';
const rect = (i, how) => {
  const cx = (i % ${COLS}) * 8 + 4, cy = Math.floor(i / ${COLS}) * 8 + 4;
  const t = how === 'r90' ? 'rotate(90 ' + cx + ' ' + cy + ') translate(' + (cx - 3) + ' ' + (cy - 3) + ')'
    : how === 'mix' ? (i % 2 ? 'rotate(90 ' + cx + ' ' + cy + ') translate(' + (cx - 3) + ' ' + (cy - 3) + ')' : 'translate(' + cx + ' ' + cy + ') skewX(25) rotate(90) translate(-3 -3)')
    : 'translate(' + (cx - 3) + ' ' + (cy - 3) + ')';
  return '<rect width="6" height="6" transform="' + t + '" fill="url(#g)"/>';
};
const docOf = (lo, hi, how) => { let b = ''; for (let i = lo; i < hi; i++) b += rect(i, how); return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">' + DEFS + b + '</svg>'; };
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__render = async (sources) => {
  R.setViewport(${W}, ${H}); R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const bundles = []; let rows = 0;
  for (const sp of sources) { const sec = await importSvg(docOf(sp.lo, sp.hi, sp.how), { preserveViewport: true }); const b = createBundle(gl, sec); rows += b.gradientCount; bundles.push(b); }
  const draw = () => { R.beginFrame([1, 1, 1, 1]); for (const b of bundles) R.drawBundle(b, {}); R.endFrame(); };
  const warmed = await R.warmScene([{ draw }], { maxPasses: 16, fenceTimeoutMs: 60000 });
  if (!warmed.complete) throw Error('scene did not finish warming');
  draw();
  const px = new Uint8Array(${W} * ${H} * 4); gl.readPixels(0, 0, ${W}, ${H}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const err = gl.getError();
  for (const b of bundles) b.dispose();
  return { px: Array.from(px), rows, err, warns: warns.splice(0) };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { launchBrowser } = await import('./_launch.mjs');
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const at = (px, x, y) => {
  const i = ((H - 1 - Math.floor(y)) * W + Math.floor(x)) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const near = (a, b, t) => a.every((v, k) => Math.abs(v - b[k]) <= t);
for (const c of CELLS) {
  let svg,
    control,
    old = null;
  try {
    svg = await page.evaluate((s) => window.__render(s), c.svg);
    control = await page.evaluate((s) => window.__render(s), c.control);
    if (c.old) old = await page.evaluate((s) => window.__render(s), c.old);
  } catch (e) {
    fail(c.name + ': ' + e.message);
    continue;
  }
  const vsControl = maxDiff(svg.px, control.px),
    vsOld = old ? maxDiff(svg.px, old.px) : 999;
  const bad = [];
  if (c.analytic)
    for (const i of [0, 1, 1000, 2046, 2047, 2048, 2049, 2050, 2400, N - 1]) {
      if (i >= N) continue;
      const cx = (i % COLS) * 8 + 4,
        cy = Math.floor(i / COLS) * 8 + 4;
      const top = at(svg.px, cx, cy - 2),
        bot = at(svg.px, cx, cy + 1.5);
      if (!near(top, [255, 0, 0], 3) || !near(bot, [0, 0, 255], 3))
        bad.push(`#${i} top [${top}] bottom [${bot}]`);
    }
  const line = `${c.name}: gradient rows svg ${svg.rows} / control ${control.rows}, control maxByte ${vsControl}, old differs by ${vsOld}, warns ${svg.warns.length}`;
  if (svg.err || control.err) fail(line + ` -- GL error ${svg.err} ${control.err}`);
  else if (svg.warns.some((w) => /gradient rows|axis-aligned/.test(w)))
    fail(line + ' -- importer warned about placement: ' + svg.warns[0]);
  else if (svg.rows < N) fail(line + ` -- fewer than ${N} placement rows`);
  else if (vsControl > 1) fail(line + ' -- render differs from the chunked control');
  else if (vsOld < 48) fail(line + " -- vacuous: the capped importer's picture is the same");
  else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
  else ok(line);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nobbGradientRowsRenderSmoke: objectBoundingBox gradients on turned/skewed squares render as their chunked controls past 2048 gradient rows',
);

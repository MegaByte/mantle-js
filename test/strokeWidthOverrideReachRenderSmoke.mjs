// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeWidthOverrideReachRenderSmoke — a strokeWidth override WIDER than the authored width draws the same picture as
// the stroke authored at that width, on every route.
//
// The stroke cover, bands and strips are baked from the authored width. An override that widens the stroke has to
// widen that reach too, or the extra width is clipped to the authored envelope. Five stroked targets (a miter-joined
// rect, a round-joined curve, an open square-capped path, a dashed line, a line just outside the viewport), each authored at width 2 and overridden to
// 12, against the same Mantle draw of the targets authored at 12 (same route, same kernel, no override).
// HELD: at most 6 pixels differ by more than 32/255 per route.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 80,
  NC = 5,
  W = NC * CELL,
  H = CELL;
const TARGETS = [
  (w, k, cx, cy) =>
    `<rect id="t${k}" x="${cx - 20}" y="${cy - 14}" width="40" height="28" fill="none" stroke="#000" stroke-width="${w}" stroke-linejoin="miter"/>`,
  (w, k, cx, cy) =>
    `<path id="t${k}" d="M${cx - 20} ${cy} C${cx - 10} ${cy - 30} ${cx + 10} ${cy + 30} ${cx + 20} ${cy}" fill="none" stroke="#000" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`,
  (w, k, cx, cy) =>
    `<path id="t${k}" d="M${cx - 18} ${cy + 10} L${cx} ${cy - 14} L${cx + 18} ${cy + 10}" fill="none" stroke="#000" stroke-width="${w}" stroke-linecap="square" stroke-linejoin="miter"/>`,
  (w, k, cx, cy) =>
    `<path id="t${k}" d="M${cx - 24} ${cy} L${cx + 24} ${cy}" fill="none" stroke="#000" stroke-width="${w}" stroke-dasharray="8 6"/>`,
  // Outside the viewport at its authored width; the widened stroke reaches 2 px into it. A view cull that keeps the authored box would drop it.
  (w, k, cx, cy) =>
    `<path id="t${k}" d="M${cx - 30} -4 L${cx + 30} -4" fill="none" stroke="#000" stroke-width="${w}"/>`,
];
const body = (w) => TARGETS.map((mk, k) => mk(w, k, CELL * k + CELL / 2, CELL / 2)).join('');
const DOTS = `<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/><rect x="${W - 0.5}" y="${H - 0.5}" width="0.5" height="0.5" fill="#000"/>`;
const svgOf = (w) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${DOTS}${body(w)}</svg>`;
const SVG_NARROW = svgOf(2),
  SVG_WIDE = svgOf(12);

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
window.addEventListener('error', (e) => { window.__err = String(e.message || e); window.__ready = true; });
window.addEventListener('unhandledrejection', (e) => { window.__err = String(e.reason && e.reason.stack || e.reason); window.__ready = true; });
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (svg, route, kernel, widen) => {
  R.setFillEngine({ route, kernel });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  const ov = createOverrideTable(gl, b);
  let set = 0;
  if (widen) for (const id of new Set(b.shapeIds || [])) if (/^t[0-4]/.test(id) && ov.set(id, { strokeWidth: 12 })) set++;
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady && route !== 'none') { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${W}, ${H}); gl.viewport(0, 0, ${W}, ${H});
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b, widen ? { overrides: ov } : {}); R.endFrame(); await new Promise((q) => setTimeout(q, 16)); }
  const px = new Uint8Array(${W} * ${H} * 4);
  gl.readPixels(0, 0, ${W}, ${H}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  ov.dispose && ov.dispose(); b.dispose && b.dispose();
  return { px: Array.from(px), set };
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
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  const err0 = await page.evaluate(() => window.__err || null);
  if (err0) throw new Error(`page script: ${err0}`);
  for (const [route, kernel] of [
    ['none', 'slug'],
    ['none', 'aac'],
    ['lb', 'slug'],
    ['cpatch', 'slug'],
    ['auto', 'slug'],
  ]) {
    const ref = await page.evaluate(
      (s, r, k) => window.__case(s, r, k, false),
      SVG_WIDE,
      route,
      kernel,
    );
    const ovr = await page.evaluate(
      (s, r, k) => window.__case(s, r, k, true),
      SVG_NARROW,
      route,
      kernel,
    );
    if (ovr.set !== NC) {
      fail(`route ${route}/${kernel}: ${ovr.set} of ${NC} rows took the override`);
      continue;
    }
    const cells = Array.from({ length: NC }, () => ({ bad: 0, ink: 0, ex: '' }));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if ((x < 2 && y < 2) || (x >= W - 2 && y >= H - 2)) continue;
        const i = (y * W + x) * 4,
          c = cells[Math.floor(x / CELL)];
        const d = Math.max(
          Math.abs(ovr.px[i] - ref.px[i]),
          Math.abs(ovr.px[i + 1] - ref.px[i + 1]),
          Math.abs(ovr.px[i + 2] - ref.px[i + 2]),
        );
        if (ref.px[i] < 128) c.ink++;
        if (d > 32) {
          c.bad++;
          if (!c.ex) c.ex = `(${x},${y}) ${d}`;
        }
      }
    cells.forEach((c, k) => {
      const line = `route ${route}/${kernel}, target ${k}: ${c.bad} px differ by more than 32/255 from the authored-12 stroke (${c.ink} inked)`;
      if (c.ink > (k === 4 ? 60 : 200) && c.bad <= 6) ok(line);
      else fail(line + (c.ex ? ' e.g. ' + c.ex : ''));
    });
  }
} finally {
  await browser.close();
  server.close();
}
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nstrokeWidthOverrideReachRenderSmoke: a widened strokeWidth override draws like the authored width',
);

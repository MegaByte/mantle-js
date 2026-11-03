// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbHoleOrientScaleRenderSmoke -- Loop-Blinn draws the same picture at every size of the art.
//
// A bundle is fit to the canvas, so the art's own size must not change the picture. Each drawing is compared with the same art at size 1, on the
// Loop-Blinn route (the draw tally says so). Absolute lengths in the analytic route would break that from about 2^-34: a disc or ring fragment's distance floored at 1e-9
// reads as outside below that radius and the shape draws nothing; em-per-pixel floors of 1e-12 and 1e-9 rescale every kernel below them; straight edges under 1e-9 drop out
// of a partition; and a fixed-length probe that turns a same-wound even-odd hole around steps past the ring's wall.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256;
const k = 0.5523;
const circle = (c, r) =>
  `M${c + r} ${c}C${c + r} ${c + r * k} ${c + r * k} ${c + r} ${c} ${c + r}C${c - r * k} ${c + r} ${c - r} ${c + r * k} ${c - r} ${c}C${c - r} ${c - r * k} ${c - r * k} ${c - r} ${c} ${c - r}C${c + r * k} ${c - r} ${c + r} ${c - r * k} ${c + r} ${c}Z`;
const RING = `<path fill="#000" fill-rule="evenodd" d="${circle(22, 18)}${circle(22, 12)}"/>`;
const svgAt = (body, size, s) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size * s} ${size * s}"><g transform="scale(${s})">${body}</g></svg>`;
const SCALES = [-8, -20, -30, -36, -40, -44, -48, 8, 20];
const CASES = [
  { name: 'ring', body: RING, size: 44 },
  { name: 'disc', body: `<path fill="#000" d="${circle(22, 18)}"/>`, size: 44 },
  {
    name: 'lines and quads',
    body: '<path fill="#000" fill-rule="evenodd" d="M6 6H38V38H6ZM14 14Q30 10 30 22Q30 34 14 30Z"/>',
    size: 44,
  },
  {
    name: 'cubic outline',
    body: '<path fill="#000" d="M6 22C6 6 20 2 30 8C42 16 40 30 30 36C20 42 6 38 6 22Z"/>',
    size: 44,
  },
];
// A list of further art, for checking a whole corpus by hand: one file per line, relative to the package.
if (process.env.LB_SCALE_ASSETS) {
  for (const f of readFileSync(process.env.LB_SCALE_ASSETS, 'utf8').split('\n').filter(Boolean)) {
    const t = readFileSync(path.join(ROOT, f), 'utf8');
    const vb = /viewBox="([^"]*)"/
      .exec(t)[1]
      .split(/[\s,]+/)
      .map(Number);
    CASES.push({
      name: path.basename(f),
      body: t
        .replace(/<\?xml[^>]*>/, '')
        .replace(/^\s*<svg[^>]*>/, '')
        .replace(/<\/svg>\s*$/, ''),
      size: Math.max(vb[2], vb[3]),
    });
  }
}

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const R = createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href), {}); if (R.ready) await R.ready;
R.setViewport(${N}, ${N}); R.setLoopBlinnFill('on');
const BUDGET = ${pageTimeoutFor(120000, 30000)}, DEADLINE = performance.now() + BUDGET;
window.__draw = async (svg) => {
  const b = createBundle(gl, await importSvg(svg));
  R.prepareBundle(b); await R.awaitLbReady(b, BUDGET);
  const frame = () => { const r0 = R.debugStats.loopBlinnRouteCount; R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); return R.debugStats.loopBlinnRouteCount - r0; };
  let routed = frame();
  while (!routed && performance.now() < DEADLINE) { if (R.precompileFills) { try { R.precompileFills(); } catch {} } await new Promise((r) => setTimeout(r, 25)); routed = frame(); }
  routed = frame();
  const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (b.dispose) b.dispose();
  return { routed, px: Array.from(px) };
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
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await openReady(page, `http://127.0.0.1:${server.address().port}/`, { ready: 'flag' });
let failures = 0,
  compared = 0;
const report = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) failures++;
};
for (const c of CASES) {
  const ref = await page.evaluate((s) => window.__draw(s), svgAt(c.body, c.size, 1));
  let inkRef = 0;
  for (let i = 0; i < ref.px.length; i += 4) if (ref.px[i] < 250) inkRef++;
  report(
    ref.routed > 0 && inkRef > 0,
    `${c.name}: size 1 routes through Loop-Blinn (${inkRef} px of ink)`,
  );
  for (const k2 of SCALES) {
    const o = await page.evaluate((s) => window.__draw(s), svgAt(c.body, c.size, 2 ** k2));
    let off = 0,
      worst = 0;
    for (let i = 0; i < o.px.length; i++) {
      const d = Math.abs(o.px[i] - ref.px[i]);
      if (d > worst) worst = d;
      if (d > 2) off++;
    }
    compared++;
    report(
      o.routed > 0 && off === 0,
      `${c.name} at 2^${k2}: ${off} channel values differ from size 1 by more than 2/255 (worst ${worst}, routed ${o.routed})`,
    );
  }
}
await browser.close();
server.close();
if (failures) {
  console.error(`lbHoleOrientScaleRenderSmoke: ${failures} failed of ${compared} sizes`);
  process.exit(1);
}
console.log(`lbHoleOrientScaleRenderSmoke: ${compared} sizes match size 1`);

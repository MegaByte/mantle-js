// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDashSeamMorphRenderSmoke -- a morph of a closed dashed contour draws the seam as the pose's own import does, on the CPU lerp and on the GPU lerp.
//
// A square -> quadrilateral morph (one closed dashed path, round caps, miter joins) is drawn at t = 0.3, 0.5 and 0.8 two ways -- the CPU lerp (createShapeMorph
// cpuLerp) and the GPU lerp with its fixup pass (gpuSmallPlanes forces it on this small plane: shapeMorph.js FIX_DASH writes each segment's startDist and, on the
// contour's first and last segment, its length -L) -- and compared with the STATIC bundle of that pose's geometry (the control points' lerp, exact for lines).
// HELD: both morph draws are within 6/255 of the static pose everywhere, and the picture is not blank. SMOKE_SRC_DIR=<a src tree> runs another tree.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.SMOKE_SRC_DIR || null;
const SQUARE = [
    [25, 25],
    [75, 25],
    [75, 75],
    [25, 75],
  ],
  RECT = [
    [15, 35],
    [85, 30],
    [90, 65],
    [20, 70],
  ];
const doc = (P) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="white"/>` +
  `<path d="M${P[0]} ${P.slice(1)
    .map((p) => `L${p}`)
    .join(
      ' ',
    )} Z" fill="none" stroke="black" stroke-width="8" stroke-linecap="round" stroke-linejoin="miter" stroke-dasharray="${14} ${11}" stroke-dashoffset="3"/></svg>`;
const lerpP = (A, B, t) =>
  A.map((p, i) => [
    +(p[0] * (1 - t) + B[i][0] * t).toPrecision(12),
    +(p[1] * (1 - t) + B[i][1] * t).toPrecision(12),
  ]);
const TS = [0.3, 0.5, 0.8];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' }); R.setViewport(128, 128);
async function frame(draw) {
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); draw(); R.endFrame(); await new Promise((r) => setTimeout(r, 20)); }
  const px = new Uint8Array(128 * 128 * 4); gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px); return Array.from(px);
}
window.__run = async (srcSvg, dstSvg, poses, ts) => {
  const A = createBundle(gl, await importSvg(srcSvg, { preserveViewport: true, compat: 'chrome' })), B = createBundle(gl, await importSvg(dstSvg, { preserveViewport: true, compat: 'chrome' }));
  const out = { cpu: [], gpu: [], stat: [] };
  for (const mode of ['cpu', 'gpu']) {
    const m = createShapeMorph(gl, A, B, { cpuLerp: mode === 'cpu' });
    if (mode === 'gpu') m.bundle._morphSrc.gpuSmallPlanes = true;
    for (const t of ts) { m.setT(t); out[mode].push(await frame(() => R.drawBundle(m))); }
    m.dispose();
  }
  for (const s of poses) { const b = createBundle(gl, await importSvg(s, { preserveViewport: true, compat: 'chrome' })); out.stat.push(await frame(() => R.drawBundle(b))); b.dispose(); }
  A.dispose(); B.dispose();
  return out;
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
    res.end(
      readFileSync(
        SRC && p.startsWith('/src/') ? path.join(SRC, p.slice('/src/'.length)) : path.join(ROOT, p),
      ),
    );
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
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
const r = await page.evaluate(
  (a, b, p, t) => window.__run(a, b, p, t),
  doc(SQUARE),
  doc(RECT),
  TS.map((t) => doc(lerpP(SQUARE, RECT, t))),
  TS,
);
await browser.close();
server.close();
let failures = 0;
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const ink = (px) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 128) n++;
  return n;
};
TS.forEach((t, k) => {
  for (const mode of ['cpu', 'gpu']) {
    const d = maxDiff(r[mode][k], r.stat[k]),
      n = ink(r.stat[k]);
    const line = `t=${t} ${mode} lerp: max byte vs the static pose ${d} (ink ${n} px)`;
    if (!(n > 500) || d > 6) {
      failures++;
      console.error('FAIL: ' + line);
    } else console.log('ok ' + line);
  }
});
if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nstrokeDashSeamMorphRenderSmoke: a closed dashed contour morphs through its seam like a static import of each pose',
);

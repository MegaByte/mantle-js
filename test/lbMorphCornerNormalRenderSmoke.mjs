// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbMorphCornerNormalRenderSmoke -- an LB morph of an image under a rotating/reflecting affine draws its corners right at every pose.
// The prepared LB mesh holds each corner's two neighbor edge NORMALS in a kind-10 record, and the vertex shader lerps the two endpoint packs.
// A lerp of unit vectors is shorter than unit between them (|n| = 0.707 halfway through a quarter turn); read as unit plane normals by the
// coverage kernel they put the corner strips off their planes (5-7 bytes off the polygon-area reference at mid-pose, exact at both ends). So
// the vertex shader renormalizes a kind-10 record after the lerp. The reference is test/_imageAffineReference.mjs (exact polygon area per
// pixel, nearest texel), and a sub-pixel placement (+0.137, +0.219) keeps every corner off the pixel grid.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="96" height="96"></canvas><script type="module">
import { compareAffineBitmap } from '/test/_imageAffineReference.mjs';
import * as M from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
const shaders = await M.loadShaders(new URL('/src/shaders/', location.href).href);
const r = M.createRenderer(gl, shaders, { aacFill: true, aacPoints: false });
await r.ready; r.setViewport(96, 96); r.setFillEngine({ route: 'lb', kernel: 'aac', primitives: 'off' });
const base = { translation: '1 0 0 1 8 8', rotate90: '0 1 -1 0 32 8', rotate90center: '0 1 -1 0 24 8', rotate180: '-1 0 0 -1 32 32', reflectX: '-1 0 0 1 32 8', reflectY: '1 0 0 -1 8 32' };
const matrices = {};
for (const k of Object.keys(base)) { const v = base[k].split(' ').map(Number); v[4] += .137; v[5] += .219; matrices[k] = v.join(' '); }
const svg = (matrix) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><image x="0" y="0" width="16" height="16" image-rendering="pixelated" transform="matrix(' + matrix + ')" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwHwyBNBAw/AcAR8oI+ItOQ4UAAAAASUVORK5CYII="/></svg>';
const cases = [['rotate90', [0.25, 0.5, 0.75, 1]], ['rotate180', [0.75, 1]], ['reflectX', [0.75, 1]], ['reflectY', [0.75, 1]], ['rotate90center', [0.25, 0.5, 0.75, 1]]];
const rows = [];
for (const [name, poses] of cases) for (const pose of poses) {
  const a = M.createBundle(gl, await M.importSvg(svg(matrices.translation), { preserveViewport: true }), { occlusionCull: false });
  const z = M.createBundle(gl, await M.importSvg(svg(matrices[name]), { preserveViewport: true }), { occlusionCull: false });
  const m = M.createShapeMorph(gl, a, z); m.setT(pose);
  const draw = () => { r.beginFrame([0, 0, 0, 0]); r.drawBundle(m, { overrides: m.overrides }); r.endFrame(); };
  let warm = await r.warmScene([{ bundle: m.bundle, engine: 'lb', draw }], { maxPasses: 64, fenceTimeoutMs: 60000 });
  if (!warm.complete && warm.states.every((s) => !s.error && s.fenced && s.stable)) warm = await r.warmScene([{ draw }], { maxPasses: 64, fenceTimeoutMs: 60000 });
  const before = structuredClone(r.debugStats.engines?.draws || {});
  draw(); if (window.__gpuFence) await window.__gpuFence(gl, 60000);
  const px = new Uint8Array(96 * 96 * 4); gl.readPixels(0, 0, 96, 96, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const s = matrices.translation.split(' ').map(Number), t = matrices[name].split(' ').map(Number);
  const ref = compareAffineBitmap(px, s.map((v, i) => v * (1 - pose) + t[i] * pose), 1);
  const lb = (r.debugStats.engines?.draws?.lb || 0) - (before.lb || 0);
  rows.push({ name, pose, maxByte: ref.maxByte, over1: ref.pixelsOver1, lb });
  m.dispose(); a.dispose(); z.dispose();
}
window.__rows = rows; window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(req.url.split('?')[0])));
    res.writeHead(200, {
      'content-type': req.url.endsWith('.glsl') ? 'text/plain' : 'text/javascript; charset=utf-8',
    });
    res.end(b);
  } catch {
    res.writeHead(404);
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
let failures = 0;
try {
  await openReady(page, `http://127.0.0.1:${server.address().port}/`, { ready: 'flag' });
} catch (e) {
  console.error('FAIL setup: ' + e.message);
  process.exit(1);
}
const rows = await page.evaluate(() => window.__rows);
for (const r of rows) {
  const good = r.maxByte <= 1 && r.lb > 0;
  console.log(
    `${good ? 'ok' : 'FAIL'} ${r.name} t=${r.pose}: max ${r.maxByte.toFixed(1)} byte, ${r.over1} px over 1, LB draws ${r.lb}`,
  );
  if (!good) failures++;
}
await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nlbMorphCornerNormalRenderSmoke: all ok');
process.exit(failures ? 1 : 0);

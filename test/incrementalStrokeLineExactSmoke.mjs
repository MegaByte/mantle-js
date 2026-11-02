// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// incrementalStrokeLineExactSmoke — a paint stroke's LINE segments are solved as lines.
//
// Lines take the clamped projection. Solved through strokeQuadAccum on a recovered midpoint,
// rounding leaves the quadratic term slightly nonzero and quadClosestT takes its degenerate
// branch: on a jittered spiral gesture that is up to 29/255 off the true coverage at a joint on
// the stroke's outer edge.
//
// THE REFERENCE IS exact: the stroke is a union of round-capped capsules, so each pixel's coverage
// is the fraction of its box within halfW of the polyline, supersampled here on the CPU. Scored on
// every pixel near the joints of a 31-point stretch of that gesture around its worst joint.
//
// NOT ZERO, AND WHY. The AA edge is one half-plane per pixel, and a pixel holding the concave
// corner where two capsules meet is not a half-plane: those read up to 13.9/255 off with either
// solve. The quadratic solve adds its own error on top (worst 29.5/255), so the bar sits between
// the two.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 1024,
  HW = 4.5;
const all = [];
let s = 12345;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < 2000; i++) {
  const a = i * 0.05,
    r = 60 + i * 0.2;
  all.push([512 + r * Math.cos(a) + rnd() * 3, 512 + r * Math.sin(a) + rnd() * 3]);
}
const PTS = all.slice(860, 891);

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, { psoWarmIdle: () => true }); R.setViewport(${N}, ${N});
const st = R.createIncrementalStroke({ color: [0, 0, 0, 1], width: ${2 * HW}, bbox: [0, 0, ${N}, ${N}] });
st.appendPoints(${JSON.stringify(PTS)});
R.beginFrame([1, 1, 1, 1]); R.drawBundle(st.bundle, {}); R.endFrame();
const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
const cov = [];
for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) cov.push(px[((${N} - 1 - y) * ${N} + x) * 4]);
window.__red = cov; window.__ready = true;
</script></body></html>`;

// Exact coverage by supersampling the distance to the polyline.
function dist(x, y) {
  let m = Infinity;
  for (let k = 0; k + 1 < PTS.length; k++) {
    const [ax, ay] = PTS[k],
      [bx, by] = PTS[k + 1],
      dx = bx - ax,
      dy = by - ay,
      dd = dx * dx + dy * dy;
    let t = dd > 0 ? ((x - ax) * dx + (y - ay) * dy) / dd : 0;
    t = Math.max(0, Math.min(1, t));
    m = Math.min(m, Math.hypot(ax + dx * t - x, ay + dy * t - y));
  }
  return m;
}
const S = 32;
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
page.on('pageerror', (e) => fail('page: ' + e.message));
let red = null;
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  red = await page.evaluate(() => window.__red);
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (red) {
  // Every pixel within halfW + 2 of an interior joint: the edge ring where the two solves differ.
  let n = 0,
    max = 0,
    worst = null,
    over = 0;
  const hist = [0, 0, 0, 0];
  const seen = new Set();
  for (let k = 1; k + 1 < PTS.length; k++) {
    const [jx, jy] = PTS[k],
      R = Math.ceil(HW + 2);
    for (let y = Math.floor(jy) - R; y <= Math.floor(jy) + R; y++)
      for (let x = Math.floor(jx) - R; x <= Math.floor(jx) + R; x++) {
        const key = y * N + x;
        if (seen.has(key)) continue;
        seen.add(key);
        let c = 0;
        for (let i = 0; i < S; i++)
          for (let j = 0; j < S; j++) if (dist(x + (i + 0.5) / S, y + (j + 0.5) / S) <= HW) c++;
        const want = 255 * (1 - c / (S * S)),
          got = red[key],
          d = Math.abs(got - want);
        if (c === 0 || c === S * S) continue; // edge pixels only
        n++;
        if (d > 4) over++;
        hist[d > 20 ? 3 : d > 12 ? 2 : d > 8 ? 1 : 0]++;
        if (d > max) {
          max = d;
          worst = `(${x},${y}) exact ${want.toFixed(1)} drawn ${got}`;
        }
      }
  }
  console.log(
    `   ${n} edge pixels near ${PTS.length - 2} joints; worst ${max.toFixed(1)}/255 at ${worst}; ${over} off by more than 4; <=8 / 8-12 / 12-20 / >20: ${hist.join(' / ')}`,
  );
  if (n > 500) ok(`${n} edge pixels scored`);
  else fail(`only ${n} edge pixels scored`);
  if (max <= 16)
    ok(
      `no edge pixel is further from exact than the corner model allows (worst ${max.toFixed(1)}/255, bar 16)`,
    );
  else
    fail(
      `an edge pixel is ${max.toFixed(1)}/255 off the exact coverage at ${worst} — past the corner model's 13.9`,
    );
}
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nincrementalStrokeLineExactSmoke: paint-stroke lines are solved as lines');

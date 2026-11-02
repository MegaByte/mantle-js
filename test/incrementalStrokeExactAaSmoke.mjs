// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// incrementalStrokeExactAaSmoke — the paint stroke draws the exact-area AA edge the static stroke
// does, and follows the renderer's setStrokeExactAa toggle.
//
// The split-stroke frag has mantle.frag's exact-area branch behind uStrokeExactAa, "so a single
// renderer toggle moves both stroke paths". incrementalStroke, its one caller, must set the
// uniform on every draw: unset, it reads 0 and the paint stroke falls back to the isotropic ramp
// (morphDraw's composed program has the same trap).
//
// THE REFERENCE IS exact: a straight 30-degree butt-capped stroke, whose coverage of each pixel is
// the area of the unit box inside the stroke's strip, computed here by clipping the box. Scored on
// edge pixels away from the caps. Two arms: the default (exact area, must match the box to within
// quantization) and setStrokeExactAa(false) (the ramp, which must NOT -- or the arms are the same
// program and the first one proves nothing).
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 256,
  WIDTH = 12;
const A = [40, 60],
  B = [216, 60 + 176 * Math.tan(Math.PI / 6)];

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders, { psoWarmIdle: () => true, strokeExactEdges: true });
r.setViewport(${N}, ${N});
const s = r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}], capStyle: 'butt' });
s.appendPoints([${JSON.stringify(A)}, ${JSON.stringify(B)}]);
const shot = () => { r.beginFrame([1,1,1,1]); r.drawBundle(s.bundle, {}); r.endFrame();
  const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);
  // coverage per pixel, rows top-down to match em y
  const cov = new Float32Array(${N}*${N});
  for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) cov[y*${N}+x] = (255 - px[((${N}-1-y)*${N}+x)*4]) / 255;
  return Array.from(cov); };
const exact = shot();
r.setStrokeExactAa(false);
const ramp = shot();
window.__out = { exact, ramp };
window.__ready = true;
</script></body></html>`;

// Area of the unit box [x,x+1]x[y,y+1] where lo <= n.p <= hi: clip the box polygon by both lines.
function clip(poly, n, c, keepBelow) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length];
    const dp = n[0] * p[0] + n[1] * p[1] - c,
      dq = n[0] * q[0] + n[1] * q[1] - c;
    const ip = keepBelow ? dp <= 0 : dp >= 0,
      iq = keepBelow ? dq <= 0 : dq >= 0;
    if (ip) out.push(p);
    if (ip !== iq) {
      const t = dp / (dp - dq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out;
}
const area = (poly) => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
};
const L = Math.hypot(B[0] - A[0], B[1] - A[1]),
  T = [(B[0] - A[0]) / L, (B[1] - A[1]) / L],
  Nrm = [-T[1], T[0]];
const c0 = Nrm[0] * A[0] + Nrm[1] * A[1];
function score(cov) {
  let n = 0,
    max = 0,
    sum = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const cx = x + 0.5,
        cy = y + 0.5,
        along = (cx - A[0]) * T[0] + (cy - A[1]) * T[1];
      if (along < 15 || along > L - 15) continue; // away from the butt caps
      let poly = [
        [x, y],
        [x + 1, y],
        [x + 1, y + 1],
        [x, y + 1],
      ];
      poly = clip(poly, Nrm, c0 + WIDTH / 2, true);
      poly = clip(poly, Nrm, c0 - WIDTH / 2, false);
      const want = area(poly);
      if (want <= 0 || want >= 1) continue; // edge pixels only
      const d = Math.abs(cov[y * N + x] - want);
      n++;
      sum += d;
      if (d > max) max = d;
    }
  return { n, max: +(max * 255).toFixed(2), mean: +((sum / Math.max(n, 1)) * 255).toFixed(3) };
}

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
page.on('pageerror', (e) => fail('page: ' + e.message));
let o = null;
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: 'load',
    timeout: 20000,
  });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  o = await page.evaluate(() => window.__out);
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (o) {
  const ex = score(o.exact),
    rp = score(o.ramp);
  console.log(
    `   default: ${JSON.stringify(ex)}   setStrokeExactAa(false): ${JSON.stringify(rp)}   (max and mean in /255)`,
  );
  if (ex.n > 300) ok(`${ex.n} edge pixels scored`);
  else fail(`only ${ex.n} edge pixels scored — the stroke did not draw where expected`);
  // 2/255: one unit of 8-bit quantization each way, plus float rounding in the box area.
  if (ex.max <= 2)
    ok(`by default the paint stroke's edge is the exact box coverage (max ${ex.max}/255)`);
  else
    fail(
      `by default the paint stroke's edge is off the exact box coverage by up to ${ex.max}/255 — it is drawing the ramp`,
    );
  if (rp.max > ex.max + 3)
    ok(`setStrokeExactAa(false) moves this pass to the ramp (max ${rp.max}/255)`);
  else
    fail(
      `setStrokeExactAa(false) left the edge at max ${rp.max}/255 — the toggle does not reach this pass, or the arms are one program`,
    );
}
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nincrementalStrokeExactAaSmoke: the paint stroke draws the exact-area edge and follows the toggle',
);

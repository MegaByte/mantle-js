// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbRibbonGateRenderSmoke — on the GPU: Loop-Blinn's even-odd ring morph keeps the antialiasing just
// outside its outer ring's extreme points.
//
// A counter-hole ribbon gate in _lbCoverage.glsl that measures a curve band fragment's distance to the
// piece's CHORD meets the negative sign it keys on in an even-odd ring's OUTER bowl, so a pixel a tenth
// of a pixel outside the arc near its end reads 1.8 px "from the curve" and is discarded: lbMorphEvenOdd
// at t = 0.03 would paint 0 where the pixel is 0.375 covered, 100 levels off Slug. The gate measures to
// the triangle the arc lies in. The CPU model and the mechanism are test/lbRibbonGateSmoke.mjs.
//
// Scored against exact even-odd coverage of the lerped pose (12 x 12 supersampled), on the frame the
// morph bundle's own box maps onto a 512 px canvas: no pixel may be painted LIGHTER than exact by more
// than 32 levels. The model predicts 0 at every t below; a chord gate loses 80 / 72 / 56 / 56 / 48 px.
// The frame must be Loop-Blinn's -- a Slug fallback passes this too -- so the LB route count is asserted:
// the MORPH route's (debugStats.loopBlinnMorphRouteCount). A morph never bumps loopBlinnRouteCount, the
// static route's, so reading that one would make every frame "take no Loop-Blinn route" on the GPU while
// the fake GL shows the morph route taken on each one. The morph's mesh builds off-thread once a draw
// asks for it, so a frame is drawn BEFORE awaitLbReady (as lbGpuMorphSmoke does); awaiting first could
// return with nothing yet in flight.
// Over-paint is not asserted: interior triangles on the INNER ring's extreme tangent still paint up to
// 48 levels over at t = 0.03 (a separate case; see test/lbRibbonGateSmoke.mjs).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours, rayWinding } = await import('../src/geom/lbContour.js');

const N = 512,
  TS = [0, 0.03, 0.09, 0.12, 0.75],
  LOST = 32;
const S = readFileSync(path.join(ROOT, 'examples/smoke/lbMorphEvenOdd__SRC.svg'), 'utf8');
const D = readFileSync(path.join(ROOT, 'examples/smoke/lbMorphEvenOdd__DST.svg'), 'utf8');

// The exact reference, in node: the lerped pose's even-odd coverage over the bundle's box.
const A = await importSvg(S, { preserveViewport: true }),
  B = await importSvg(D, { preserveViewport: true });
const sc = curveRangeToContours(
  new Float32Array(A.curves),
  A.curveRangesByShape[0].begin,
  A.curveRangesByShape[0].end,
);
const dc = curveRangeToContours(
  new Float32Array(B.curves),
  B.curveRangesByShape[0].begin,
  B.curveRangesByShape[0].end,
);
const bb = Array.from(A.globalBBox);
function exactAt(t) {
  const segs = sc
    .map((c, ci) =>
      c.map((g, si) => {
        const d = dc[ci][si],
          lp = (p, q) => p && [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        return {
          type: g.type,
          w: g.w,
          p1: lp(g.p1, d.p1),
          p2: lp(g.p2, d.p2),
          p3: lp(g.p3, d.p3),
          p4: lp(g.p4, d.p4),
        };
      }),
    )
    .flat();
  const inside = (x, y) =>
    (rayWinding(segs, bb[0] + (x / N) * bb[2], bb[1] + (y / N) * bb[3]) & 1) !== 0;
  const cov = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const c = inside(x + 0.5, y + 0.5);
      if (
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].every(([a, b]) => inside(x + a, y + b) === c)
      ) {
        cov[y * N + x] = c ? 1 : 0;
        continue;
      }
      let n = 0;
      for (let a = 0; a < 12; a++)
        for (let b = 0; b < 12; b++) if (inside(x + (a + 0.5) / 12, y + (b + 0.5) / 12)) n++;
      cov[y * N + x] = n / 144;
    }
  return cov;
}

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
R.setLoopBlinnFill('on');
const bSrc = createBundle(gl, await importSvg(${JSON.stringify(S)}, { preserveViewport: true }));
const bDst = createBundle(gl, await importSvg(${JSON.stringify(D)}, { preserveViewport: true }));
const m = createShapeMorph(gl, bSrc, bDst);
R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
m.setT(0); R.beginFrame([1, 1, 1, 1]); R.drawBundle(m); R.endFrame();   // asks for the off-thread morph build
if (R.awaitLbReady) { try { await R.awaitLbReady(m, 20000); } catch {} }
const lbRoutes = () => { const d = R.debugStats || {}; return ((d.loopBlinnMorphRouteCount | 0) + (d.loopBlinnRouteCount | 0)); };
window.__frame = (t) => {
  m.setT(t);
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(m); R.endFrame(); }
  const lb0 = lbRoutes();
  R.beginFrame([1, 1, 1, 1]); R.drawBundle(m); R.endFrame(); gl.finish();
  const lb = lbRoutes() - lb0;
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { lb, red: Array.from(px.filter((_, i) => i % 4 === 0)) };
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
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const t of TS) {
    const r = await page.evaluate((tt) => window.__frame(tt), t);
    if (!(r.lb > 0)) {
      fail(
        `t = ${t}: the frame took no Loop-Blinn route (${r.lb}) -- a Slug fallback would pass the ink test`,
      );
      continue;
    }
    const ex = exactAt(t);
    let lost = 0,
      worst = 0,
      at = '';
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const got = 1 - r.red[(N - 1 - y) * N + x] / 255,
          d = Math.round((ex[y * N + x] - got) * 255); // black ink on white
        if (d > LOST) {
          lost++;
          if (d > worst) {
            worst = d;
            at = `(${x},${y}) got ${got.toFixed(3)} exact ${ex[y * N + x].toFixed(3)}`;
          }
        }
      }
    const msg = `t = ${t}: ${lost} px painted lighter than exact by more than ${LOST} levels${lost ? `, worst ${worst} at ${at}` : ''} (Loop-Blinn route x${r.lb})`;
    if (lost === 0) ok(msg);
    else fail(msg);
  }
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nlbRibbonGateRenderSmoke: the even-odd ring morph keeps its outer antialiasing at every t',
);

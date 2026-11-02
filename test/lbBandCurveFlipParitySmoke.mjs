// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBandCurveFlipParitySmoke.mjs — a streamed band reuses a triangulation only for the same rim structure.
//
// A road band's LB rim inserts a curved edge's CONTROL POINT only when that
// edge is CONCAVE to the fill. Curving right ⇒ the LEFT edge is concave (rim =
// [p1L, p2L, capF, p1R, capN]); curving left ⇒ the RIGHT edge is concave (rim =
// [p1L, capF, p1R, p2R, capN]). Both rims are length 5 but have DIFFERENT
// structure — the inserted control point sits on a different edge.
//
// refreshLoopBlinnMesh (the streaming fast path after frame 1) reuses the
// cached earcut triangulation when the rim LENGTHS match. Streaming from a
// curve-right frame to a curve-left frame keeps every length identical, so a
// length check alone would reuse the stale triangulation, whose vertex indices
// then connect the wrong rim points → a folded / wrong-wedge interior. This
// asserts the streamed band matches a freshly-built band of the same geometry.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, buildStreamableSections, updateBundleGeometry } from '/src/index.js';
import { mkQuad } from '/src/primitives/seg.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const W = 200, H = 200, VBOX = [0, 0, W, H];

const straightQ = (a, b) => mkQuad(a, a, b);
const quadEdge = (n, m, f) => mkQuad(n, [2*m[0]-(n[0]+f[0])/2, 2*m[1]-(n[1]+f[1])/2], f);
const band = (nL, mL, fL, nR, mR, fR) =>
  [quadEdge(nL, mL, fL), straightQ(fL, fR), quadEdge(fR, mR, nR), straightQ(nR, nL)];

// A perspective band whose centerline mid is pushed by sway. sway>0 curves
// the road right (left edge concave); sway<0 curves left (right edge concave).
const yN=180, yM=110, yF=50, rwN=60, rwM=30, rwF=12, cx=100;
const makeBand = (sway) => {
  const cxN=cx, cxM=cx+sway, cxF=cx;
  return band([cxN-rwN,yN],[cxM-rwM,yM],[cxF-rwF,yF],[cxN+rwN,yN],[cxM+rwM,yM],[cxF+rwF,yF]);
};
const shapes = (sway) => [{ segs: makeBand(sway), fill: [0.85,0.85,0.85,1] }];

const draw = (b) => { renderer.setViewport(W,H); renderer.beginFrame([0,0,0,1]); renderer.drawBundle(b,{}); renderer.endFrame(); };
const mask = () => { const px=new Uint8Array(W*H*4); gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const m=new Uint8Array(W*H); let c=0; for(let i=0;i<W*H;i++){ if(px[i*4]>100&&px[i*4+1]>100&&px[i*4+2]>100){m[i]=1;c++;} } return {m,c}; };
const iou=(a,b)=>{let it=0,u=0;for(let i=0;i<a.length;i++){const uu=a[i]||b[i];u+=uu;it+=(a[i]&&b[i])?1:0;}return u?it/u:1;};

renderer.setLoopBlinnFill(false);
const SWAY_R = +45, SWAY_L = -45;   // curve right, then curve left

// Ground truth: a FRESH lightweight bundle at the curve-LEFT geometry (no
// refresh — built from scratch, always correct).
const truth = createBundle(gl, buildStreamableSections(shapes(SWAY_L), VBOX, { lightweight:true }));
updateBundleGeometry(gl, truth, [makeBand(SWAY_L)]);
truth.globalBBox = VBOX.slice(); draw(truth); const gt = mask();

// Streamed: build, stream curve-RIGHT (seeds prev mesh + topology), then stream
// curve-LEFT — the rim lengths match across the flip, so refreshLoopBlinnMesh
// reuses the curve-right triangulation for curve-left geometry.
const streamed = createBundle(gl, buildStreamableSections(shapes(SWAY_R), VBOX, { lightweight:true }));
updateBundleGeometry(gl, streamed, [makeBand(SWAY_R)]);   // frame 1: curve right
updateBundleGeometry(gl, streamed, [makeBand(SWAY_L)]);   // frame 2: FLIP to curve left
streamed.globalBBox = VBOX.slice(); draw(streamed); const st = mask();

window.__out = { truthCount: gt.c, streamCount: st.c, iou: iou(gt.m, st.m), delta: st.c - gt.c };
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
const port = server.address().port;

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
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
if (o.iou > 0.98)
  ok('streamed curve-flip band matches a fresh build (IoU ' + o.iou.toFixed(4) + ')');
else
  fail(
    'streamed curve-flip band is WRONG (IoU ' +
      o.iou.toFixed(4) +
      ', delta ' +
      o.delta +
      'px) — stale triangulation reused across a concave-edge flip',
  );

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\\nlbBandCurveFlipParitySmoke: refreshLoopBlinnMesh rebuilds when the concave edge moves',
);

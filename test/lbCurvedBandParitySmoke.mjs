// lbCurvedBandParitySmoke.mjs — FAITHFUL Highway-Hazards road repro.
//
// The road's "wrong wedges" / blank-and-fragment bug only shows on the REAL
// band geometry, which the convex-rect sentinel test never exercises: each
// road band is a CLOSED contour with two CURVED quad edges (left + right) that
// bow the SAME direction when the road curves — so one edge is convex and the
// other is concave to the fill. The lightweight stream routes such an all-solid
// bundle through the ONE-DRAW combined route (uDirect=1, single-pass OVER).
//
// This test pins BOTH the LB-streamed bundle and the Slug ground-truth bundle
// to the SAME globalBBox (the confound that produced a bogus "2× over-fill" in
// an earlier debugging pass) and compares them directly. A correct fill must
// match Slug within tight IoU; over-fill (extra wedge area), under-fill (gaps),
// or seams between adjacent bands all drop the IoU.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

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
renderer.setLoopBlinnFill(false);   // OFF → lightweight stream must self-route; Slug bundle stays Slug
const W = 200, H = 200, VBOX = [0, 0, W, H];

// ── Faithful road-band geometry (roadRing.ts band/quadEdge/straightQ) ──
const straightQ = (a, b) => mkQuad(a, a, b);
const quadEdge = (n, m, f) => mkQuad(n, [2*m[0]-(n[0]+f[0])/2, 2*m[1]-(n[1]+f[1])/2], f);
const band = (nL, mL, fL, nR, mR, fR) =>
  [quadEdge(nL, mL, fL), straightQ(fL, fR), quadEdge(fR, mR, nR), straightQ(nR, nL)];

// A CURVING perspective road: near (wide, bottom) → far (narrow, top), with the
// centerline pushed to the right at mid-depth so both edges bow (left edge
// concave to the fill, right edge convex). One band, but enough to exercise the
// concave-edge case the combined route mishandles.
//   y: near=180 (bottom), mid=110, far=60 (top).   x grows right with curve.
const cxN = 100, cxM = 130, cxF = 120;        // centerline near/mid/far (curve)
const rwN = 70,  rwM = 34,  rwF = 14;         // half-width near/mid/far (perspective)
const yN = 180,  yM = 110,  yF = 60;
const roadBand = band(
  [cxN - rwN, yN], [cxM - rwM, yM], [cxF - rwF, yF],   // left  edge near→mid→far
  [cxN + rwN, yN], [cxM + rwM, yM], [cxF + rwF, yF]);  // right edge near→mid→far
const shapes = [{ segs: roadBand, fill: [0.85, 0.85, 0.85, 1] }];

const draw = (b, opts) => {
  renderer.setViewport(W, H);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(b, opts || {});
  renderer.endFrame();
};
const grayMask = () => {
  const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const mask = new Uint8Array(W * H); let count = 0;
  for (let i = 0; i < W * H; i++) { if (px[i*4] > 100 && px[i*4+1] > 100 && px[i*4+2] > 100) { mask[i] = 1; count++; } }
  return { mask, count };
};
const iou = (a, b) => { let inter=0, uni=0; for (let i=0;i<a.length;i++){ const u=a[i]||b[i]; uni+=u; inter+=(a[i]&&b[i])?1:0; } return uni?inter/uni:1; };

const out = {};

// (1) Slug ground truth — non-lightweight bundle, global toggle OFF → Slug fill.
const slugB = createBundle(gl, buildStreamableSections(shapes, VBOX));
slugB.globalBBox = VBOX.slice();
draw(slugB);
const slug = grayMask(); out.slugCount = slug.count;

// (2) Lightweight LB stream → renders through the combined (all-solid) route.
const lbB = createBundle(gl, buildStreamableSections(shapes, VBOX, { lightweight: true }));
const r0 = renderer.debugStats.loopBlinnRouteCount;
const res = updateBundleGeometry(gl, lbB, [roadBand]);   // auto-lightweight (no cover quads)
out.streamOk = res.ok === true;
out.lbStream = !!lbB._lbStream;
lbB.globalBBox = VBOX.slice();      // PIN identical bbox (the prior-session confound)
draw(lbB);
out.lbRouted = renderer.debugStats.loopBlinnRouteCount > r0;
const lb = grayMask(); out.lbCount = lb.count;

out.iou = iou(slug.mask, lb.mask);
out.overfill = lb.count - slug.count;    // +ve = combined route paints extra (wrong wedges)

window.__out = out; window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, p)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));

if (o.streamOk && o.lbStream) ok('curved band streamed through the lightweight LB path'); else fail('did not stream LB: ' + JSON.stringify(o));
if (o.lbRouted) ok('rendered via the analytic combined route'); else fail('did not route to analytic fill');
if (o.iou > 0.97) ok('curved-band fill matches Slug (IoU ' + o.iou.toFixed(4) + ')');
else fail('curved-band fill DIVERGES from Slug (IoU ' + o.iou.toFixed(4) + ', overfill ' + o.overfill + 'px) — the "wrong wedges" bug');

await browser.close();
server.close();
if (failures) { console.error('\\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\\nlbCurvedBandParitySmoke: curved road band fills correctly through the combined route');

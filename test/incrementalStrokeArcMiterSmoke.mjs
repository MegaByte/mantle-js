// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// incrementalStrokeArcMiterSmoke — a miter join at a NATIVE arc keeps its tip on the paint stroke.
//
// The split-stroke vertex stage sizes each segment's band quad by the miter its joins actually
// need, from the segment's end directions P1 - P0 and P3 - P2. For an arc those four slots are
// not a hull: they carry the center, the radii, (phi, th0) and (th1, 0). Read as directions they
// give (radii - center) and (th1 - phi, -th0) -- whatever angle those make with the neighbor
// would decide the quad, and a sharp miter could run past it and be cut off.
//
// The case: two arcs meeting at a 7.3-degree peak with miter limit 20, so the miter (15.8 x the
// half-width) is drawn and its tip sits ~90 px outside both arcs' whole-ellipse boxes. The
// reference is the same two arcs sampled as a dense polyline through the same API and bbox, whose
// line segments size their quads from true directions (the incrementalStrokeTypesSmoke method: the
// same path, the same framing, only the thing under test differs). Measured in the band above the
// ellipse boxes, where only the miter spike paints.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 256,
  WIDTH = 20,
  LIMIT = 20;

// Two circles of radius 50 whose centers are 99.8 apart meet at J = (128, 183.16). Arc A runs
// along circle A's bottom from its left end up into J; arc B leaves J down along circle B's bottom.
// J is a peak: the interior angle is 2 asin(3.16 / 50) = 7.3 degrees.
const R = 50,
  CY = 180,
  CA = [128 - 49.9, CY],
  CB = [128 + 49.9, CY];
const H = Math.sqrt(R * R - 49.9 * 49.9);
const thA = [Math.PI, Math.atan2(H, 49.9)]; // decreasing through the bottom (y down)
const thB = [Math.atan2(H, -49.9), 0]; // likewise, from J to the right end
const ARCS = [
  { type: 'arc', center: CA, radii: [R, R], theta: thA },
  { type: 'arc', center: CB, radii: [R, R], theta: thB },
];
// The miter tip: J minus 15.8 half-widths straight up; the ellipse boxes end at CY - R.
const TOP_OF_BOXES = CY - R;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders, { psoWarmIdle: () => true });
r.setViewport(${N}, ${N});
const read = () => { const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const ARCS = ${JSON.stringify(ARCS)};
const at = (a, th) => [a.center[0] + a.radii[0] * Math.cos(th), a.center[1] + a.radii[1] * Math.sin(th)];
const mk = () => r.createIncrementalStroke({ color: [0,0,0,1], width: ${WIDTH}, bbox: [0,0,${N},${N}],
                                             capStyle: 'butt', joinStyle: 'miter', miterLimit: ${LIMIT} });
const draw = (s) => { r.beginFrame([1,1,1,1]); r.drawBundle(s.bundle, {}); r.endFrame(); return read(); };

const nat = mk();
nat.appendPoints([at(ARCS[0], ARCS[0].theta[0])]);
nat.appendSegments(ARCS);
const natPx = draw(nat);
const poly = mk();
const pts = [];
// Uniform samples, stopped 1.5 px short of J on each side, and J approached along the exact
// tangent from 1 px out. The chords at the joint then point exactly along the arcs' tangents: a
// uniform chord at J turns the polyline's joint by half its own angle, and a clustered one ~1e-3 px
// long takes a fp32 direction error of ~0.3 degrees -- either moves a 15.8x miter's tip by pixels.
const dirAt = (a, th) => { const s = Math.sign(a.theta[1] - a.theta[0]);
  return [-Math.sin(th) * a.radii[0] * s, Math.cos(th) * a.radii[1] * s].map((v, _, w) => v / Math.hypot(w[0], w[1])); };
const J = at(ARCS[0], ARCS[0].theta[1]), tA = dirAt(ARCS[0], ARCS[0].theta[1]), tB = dirAt(ARCS[1], ARCS[1].theta[0]);
const M = 400, SKIP = 4;                                    // 4 of 400 samples: 1.5 px of arc
for (let i = 0; i <= M - SKIP; i++) pts.push(at(ARCS[0], ARCS[0].theta[0] + (ARCS[0].theta[1] - ARCS[0].theta[0]) * i / M));
pts.push([J[0] - tA[0], J[1] - tA[1]], J, [J[0] + tB[0], J[1] + tB[1]]);
for (let i = SKIP; i <= M; i++) pts.push(at(ARCS[1], ARCS[1].theta[0] + (ARCS[1].theta[1] - ARCS[1].theta[0]) * i / M));
poly.appendPoints(pts);
const refPx = draw(poly);

// Ink above the ellipse boxes (canvas rows are bottom-up), and ink overall.
let spikeNat = 0, spikeRef = 0, inkNat = 0, inkRef = 0, hard = 0;
for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) {
  const i = ((${N} - 1 - y) * ${N} + x) * 4, a = 255 - natPx[i], c = 255 - refPx[i];
  if (a > 127) inkNat++; if (c > 127) inkRef++;
  if (Math.abs(a - c) > 64) hard++;
  if (y < ${TOP_OF_BOXES - WIDTH / 2 - 4}) { if (a > 127) spikeNat++; if (c > 127) spikeRef++; }
}
window.__out = { spikeNat, spikeRef, inkNat, inkRef, hard, svg: nat.bundle.svgSource };
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
  console.log('  ', JSON.stringify({ ...o, svg: undefined }));
  // Not vacuous: the reference has to paint the spike, or agreement proves nothing.
  if (o.spikeRef > 150)
    ok(`the sampled reference paints the miter spike above the arcs' boxes (${o.spikeRef} px)`);
  else
    fail(
      `the reference paints no spike above the boxes (${o.spikeRef} px) — the case proves nothing`,
    );
  if (Math.abs(o.spikeNat - o.spikeRef) <= Math.max(8, 0.05 * o.spikeRef))
    ok(`native arcs paint the same spike (${o.spikeNat} vs ${o.spikeRef} px)`);
  else
    fail(
      `native arcs paint ${o.spikeNat} spike px where the sampled arcs paint ${o.spikeRef} — the miter is cut off`,
    );
  if (o.hard < 0.02 * o.inkRef)
    ok(`hard disagreements overall ${o.hard} < 2% of ${o.inkRef} ink px`);
  else fail(`${o.hard} hard disagreements against ${o.inkRef} ink px`);
  // finalize()/svgSource re-hosts the stroke through importSvg. Without its miter limit it comes
  // back at SVG's default 4, and this 15.8x miter becomes a bevel.
  if (o.svg.includes(`stroke-miterlimit="${LIMIT}"`))
    ok(`svgSource carries the miter limit (stroke-miterlimit="${LIMIT}")`);
  else
    fail(
      `svgSource drops the miter limit — a re-hosted stroke bevels this join: ${o.svg.slice(o.svg.indexOf('stroke='), o.svg.indexOf('/>'))}`,
    );
}
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nincrementalStrokeArcMiterSmoke: a miter join at a native arc keeps its tip');

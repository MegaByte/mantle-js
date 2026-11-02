// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbAnnulusSdfSmoke.mjs — a CONCENTRIC circular RING built from CUBIC beziers (like
// the pause-menu how-to-play "?" ring) renders through the exact annulus SDF (kind
// 7), NOT per-≤90° cubic crescents: at SMALL render scale it's seam-free AND free of
// the same, for a ring that is only a ring because of the FILL RULE.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// cubic-bezier circle (4×90° arcs), CCW; k = r·4/3·tan(π/8).
function circlePath(cx, cy, r, ccw) {
  const k = r * 0.5522847498,
    dirs = ccw ? [0, 1, 2, 3] : [0, 3, 2, 1];
  const pt = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const tan = (a) => [(ccw ? -1 : 1) * Math.sin(a), (ccw ? 1 : -1) * Math.cos(a)];
  let d = '';
  for (let i = 0; i < 4; i++) {
    const a0 = (dirs[i] * Math.PI) / 2,
      a1 = (dirs[(i + 1) % 4] * Math.PI) / 2 + (ccw ? 0 : i === 3 ? -2 * Math.PI : 0);
    const p0 = pt(a0),
      p3 = pt(a1),
      t0 = tan(a0),
      t1 = tan(a1);
    const p1 = [p0[0] + k * t0[0], p0[1] + k * t0[1]],
      p2 = [p3[0] - k * t1[0], p3[1] - k * t1[1]];
    d +=
      (i === 0 ? `M${p0[0].toFixed(2)} ${p0[1].toFixed(2)} ` : '') +
      `C${p1[0].toFixed(2)} ${p1[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)} ${p3[0].toFixed(2)} ${p3[1].toFixed(2)} `;
  }
  return d + 'Z';
}
const R = 96;
// TWO POSES, both rings only because of the fill rule. Same topology (two same-wound circles,
// four cubics each), different radii — so the morph pairs one to one and every intermediate pose
// is a ring too.
const ringSvg = (ro, ri) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44"><path fill="#000000" fill-rule="evenodd" d="${circlePath(22, 22, ro, true)} ${circlePath(22, 22, ri, true)}"/></svg>`;
const SRC = ringSvg(18, 12),
  DST = ringSvg(15, 5);
emitFixture('lbMorphEvenOdd__SRC', SRC);
emitFixture('lbMorphEvenOdd__DST', DST);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${R}" height="${R}"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, depth:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(${R}, ${R});
renderer.setLoopBlinnFill('on');
const bSrc = createBundle(gl, await importSvg(${JSON.stringify(SRC)}));
const bDst = createBundle(gl, await importSvg(${JSON.stringify(DST)}));
const morph = createShapeMorph(gl, bSrc, bDst);
if (renderer.awaitLbReady) await renderer.awaitLbReady(morph);
// WHAT THIS DOES AND DOES NOT CATCH. It asserts an even-odd morph keeps its hole at every t, which
// nothing else covers. It does NOT discriminate the fill-rule threading in buildEarcutPair:
// without that threading it stays green, because a failed earcut pair falls through to
// buildLoopBlinnPartitionPair, which is handed the rule. Every such omission is masked the same
// way -- by a fallback that carries the rule -- so it is latent, and threading the rule removes
// wasted work rather than wrong pixels.
//
// THE HOLE IS THE ASSERTION. A pose built as nonzero fills the ring solid, because two same-wound
// circles are only a hole under even-odd — so a centre pixel that goes dark at ANY t means a pose
// lost the rule. Checked across t, since the two poses are built by different code paths (src
// builds, dst refreshes off it).
const out = [];
for (const t of [0, 0.25, 0.5, 0.75, 1]) {
  morph.setT(t);
  gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  renderer.drawBundle(morph);
  const px = new Uint8Array(${R}*${R}*4);
  gl.readPixels(0,0,${R},${R},gl.RGBA,gl.UNSIGNED_BYTE,px);
  const at = (x,y) => { const i = ((${R}-1-y)*${R}+x)*4; return 1 - px[i]/255; };
  let ink = 0; for (let i=0;i<px.length;i+=4) if (px[i] < 128) ink++;
  out.push({ t, hole: +at(${R}>>1, ${R}>>1).toFixed(3), ink });
}
window.__out = { poses: out };
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
page.on('pageerror', (e) => fail('page: ' + e.message));
let o = null;
try {
  await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load' });
  // POLL ON A TIMER, NOT ON rAF. waitForFunction defaults to polling inside requestAnimationFrame,
  // and a headless page that is not presenting frames never runs one -- so the predicate is never
  // evaluated and this waits out the full timeout however well the render went: a page that has
  // drawn all five poses, counted their ink and set window.__ready still reads as a timeout.
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  o = await page.evaluate(() => window.__out);
  console.log('  ' + JSON.stringify(o.poses));
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}
await browser.close();
server.close();

for (const p of o.poses) {
  if (p.ink > 0) ok('t=' + p.t + ' draws (' + p.ink + ' ink px)');
  else fail('t=' + p.t + ' drew nothing');
  if (p.hole < 0.05) ok('t=' + p.t + ' hole stays empty (' + p.hole + ')');
  else fail('t=' + p.t + ' hole FILLED (' + p.hole + ') — a pose lost the even-odd rule');
}
console.log('\\nlbMorphEvenOddSmoke: both morph poses keep the even-odd hole');
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}

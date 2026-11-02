// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// maskCacheSmoke.mjs — mask result cache proof.
// A bundle with a MULTI-shape <mask> (forces the offscreen region bake,
// maskRegions.length > 0) is rendered several frames. Asserts:
//   1. The masked output is correct (blue shows only inside the mask).
//   2. The mask is baked ONCE — re-renders reuse _maskRTArray
//      (renderer.debugStats.maskBakeCount stays 1), proving the bake is
//      skipped when geometry + canvas are unchanged (a sibling animating
//      would re-render but not re-bake the mask).
//   3. A canvas resize re-bakes (key includes canvas size).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Multi-shape mask: two white rects in the mask → a real mask region.
// Masked blue square; mask reveals the left+right thirds (a gap in the
// middle), so center is hidden, sides shown.
const SVG = readFileSync(new URL('../examples/smoke/maskCache__SVG.svg', import.meta.url), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { aacPoints: false });
const sections = await importSvg(${JSON.stringify(SVG)});
const bundle = createBundle(gl, sections);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
window.__gl = gl; window.__renderer = renderer; window.__bundle = bundle; window.__id = id;
window.__frame = (w, h) => {
  if (w) { cnv.width = w; cnv.height = h; }
  renderer.setViewport(cnv.width, cnv.height);
  renderer.beginFrame([0.5,0.5,0.5,1]);
  renderer.drawBundle(bundle, { worldMatrix: id });
  renderer.endFrame();
};
window.__sample = (x, yTop) => {
  const b = new Uint8Array(4);
  gl.readPixels(x, cnv.height - 1 - yTop, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
  return [b[0], b[1], b[2], b[3]];
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try {
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' });
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
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

// Render frame 1, check correctness + bake happened once. (If the
// fixture produced no mask region the bake count would stay 0 — the
// `bakes === 1` assertion below doubles as the not-vacuous guard.)
const r1 = await page.evaluate(() => {
  window.__frame();
  return {
    left: window.__sample(30, 100), // inside left mask reveal → blue
    center: window.__sample(100, 100), // mask gap → hidden → backdrop gray
    right: window.__sample(170, 100), // inside right reveal → blue
    bakes: window.__renderer.debugStats.maskBakeCount,
  };
});
const isBlue = (c) => c[2] > 180 && c[0] < 80 && c[1] < 80;
const isGray = (c) =>
  Math.abs(c[0] - 128) < 40 && Math.abs(c[1] - 128) < 40 && Math.abs(c[2] - 128) < 40;
if (isBlue(r1.left) && isBlue(r1.right)) ok('mask reveals left+right (blue)');
else fail('reveal wrong: L=' + r1.left + ' R=' + r1.right);
if (isGray(r1.center)) ok('mask hides center (backdrop)');
else fail('center not hidden: ' + r1.center);
if (r1.bakes === 1) ok('frame 1 baked the mask once (count=1)');
else fail('unexpected bake count after frame 1: ' + r1.bakes);

// Render 4 more frames at the same canvas size → no additional bakes
// (re-render reuses the baked mask).
const r2 = await page.evaluate(() => {
  for (let i = 0; i < 4; i++) window.__frame();
  return {
    center: window.__sample(100, 100),
    left: window.__sample(30, 100),
    bakes: window.__renderer.debugStats.maskBakeCount,
  };
});
if (r2.bakes === 1) ok('4 more frames: mask NOT re-baked (count still 1 — cache hit)');
else fail('mask re-baked on static re-render: ' + r2.bakes);
if (isBlue(r2.left) && isGray(r2.center)) ok('output still correct after cache hits');
else fail('cached output wrong: L=' + r2.left + ' C=' + r2.center);

// Resize the canvas → the key (canvas size) changes → re-bake.
const r3 = await page.evaluate(() => {
  window.__frame(300, 300);
  return { bakes: window.__renderer.debugStats.maskBakeCount, left: window.__sample(45, 150) };
});
if (r3.bakes === 2) ok('canvas resize re-bakes (count=2)');
else fail('resize did not re-bake: ' + r3.bakes);

const collapsed = await page.evaluate(async () => {
  const r = window.__renderer,
    b = window.__bundle,
    g = window.__gl;
  const draw = () => {
    r.beginFrame([0.5, 0.5, 0.5, 1]);
    r.drawBundle(b, { worldMatrix: window.__id });
    r.endFrame();
  };
  await r.awaitLbReady(b);
  const warm = await r.warmScene([{ name: 'mask-cache-controls', draw }], {
    maxPasses: 128,
    fenceTimeoutMs: 60000,
  });
  if (!warm.complete) throw Error('Incomplete warm');
  const h = r.createBundleHandle(b),
    zero = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 1]);
  const paths = [
    ['bundle', () => r.drawBundle(b, { worldMatrix: zero })],
    ['instance', () => r.drawInstance(b, { worldMatrix: zero })],
    ['handle', () => h.draw({ worldMatrix: zero })],
    ['instanced', () => r.drawBundleInstanced(b, [{ worldMatrix: zero }, { worldMatrix: zero }])],
    [
      'provider',
      () =>
        r.drawBundle(
          {
            get bundle() {
              return b;
            },
          },
          { worldMatrix: zero },
        ),
    ],
  ];
  const cases = [];
  let parkedX = 0;
  for (const [name, paint] of paths) {
    zero[6] = ++parkedX;
    r.beginFrame([0.5, 0.5, 0.5, 1]);
    const before = r.debugStats.maskBakeCount;
    paint();
    r.endFrame();
    cases.push({
      name,
      bakes: r.debugStats.maskBakeCount - before,
      pixel: window.__sample(45, 150),
    });
  }
  const tiny = new Float32Array([1e-12, 0, 0, 0, 1e-12, 0, 0, 0, 1]);
  r.beginFrame([0.5, 0.5, 0.5, 1]);
  const before = r.debugStats.maskBakeCount;
  r.drawBundle(b, { worldMatrix: tiny });
  r.endFrame();
  const tinyControl = {
    bakes: r.debugStats.maskBakeCount - before,
    left: window.__sample(45, 150),
    center: window.__sample(150, 150),
  };
  draw();
  const restored = { left: window.__sample(45, 150), center: window.__sample(150, 150) };
  const { importSvg, createBundle } = await import('/src/index.js');
  const veSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10H90V90H10Z" fill="#00f" vector-effect="non-scaling-size non-rotation fixed-position"/></svg>';
  const ve = createBundle(g, await importSvg(veSvg));
  await r.awaitLbReady(ve);
  const vh = r.createBundleHandle(ve),
    parked = new Float32Array([0, 0, 0, 0, 0, 0, 20001, 20001, 1]);
  const vectorCases = [];
  for (const [name, paint] of [
    ['bundle', () => r.drawBundle(ve, { worldMatrix: parked })],
    ['instance', () => r.drawInstance(ve, { worldMatrix: parked })],
    ['handle', () => vh.draw({ worldMatrix: parked })],
    [
      'instanced',
      () => r.drawBundleInstanced(ve, [{ worldMatrix: parked }, { worldMatrix: parked }]),
    ],
  ]) {
    r.beginFrame([0.5, 0.5, 0.5, 1]);
    paint();
    r.endFrame();
    vectorCases.push({ name, pixel: window.__sample(150, 150) });
  }
  vh.dispose();
  ve.dispose();
  const ext = g.getExtension('WEBGL_debug_renderer_info');
  h.dispose();
  return {
    vectorCases,
    device: ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
    cases,
    tinyControl,
    restored,
    error: g.getError(),
  };
});
for (const c of collapsed.cases) {
  if (c.bakes === 0 && isGray(c.pixel))
    ok(c.name + ': collapsed affine draw stays blank and bakes no mask');
  else fail(c.name + ': collapsed affine draw ' + JSON.stringify(c));
}
if (
  collapsed.tinyControl.bakes > 0 &&
  isGray(collapsed.tinyControl.left) &&
  isGray(collapsed.tinyControl.center)
)
  ok('tiny invertible affine map still reaches mask rendering');
else fail('tiny affine map was wrongly skipped: ' + JSON.stringify(collapsed.tinyControl));
if (isBlue(collapsed.restored.left) && isGray(collapsed.restored.center) && !collapsed.error)
  ok('visible draw resumes with correct mask');
else fail('visible resume failed: ' + JSON.stringify(collapsed));
for (const c of collapsed.vectorCases) {
  if (isBlue(c.pixel)) ok(c.name + ': scale-independent vector effects retain visible geometry');
  else fail(c.name + ': vector effect wrongly culled ' + JSON.stringify(c));
}
console.log('device=' + collapsed.device);

await browser.close();
server.close();
if (failures === 0) console.log('\nMASK-CACHE PASS');
else console.log(`\nMASK-CACHE FAIL (${failures})`);
process.exit(failures ? 1 : 0);

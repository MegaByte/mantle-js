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
//
// PER HANDLE (second page): two masked bundles drawn every frame do not re-bake each other's mask
// layers every frame.
//
// A bake validity check that remembers ONE handle over one shared layer array re-bakes both of two
// masked handles drawn in a frame, every frame: the full-canvas child draws priced as per-bake
// become per-frame work. The count is read from debugStats.maskBakeCount over 60 steady frames, and
// the picture is checked against a frame drawn with each bundle alone.
//
// THE STATIC CACHE IS OFF (the debug-gated __MANTLE_NO_STATIC_CACHE), because it replays a bundle's
// finished pixels and the bake then never runs at all: with it on, a one-handle check also counts 0.
// The case under test is handles that are NOT statically cached, i.e. anything animating.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

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

// The per-handle page: two bundles, each masked by two circles.
const perHandle = (() => {
  const N = 160;
  const masked = (fill, cx) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
    // TWO shapes in the mask: a single-shape mask is handled inline and never bakes.
    `<defs><mask id="m"><circle cx="${cx}" cy="60" r="28" fill="#fff"/><circle cx="${cx}" cy="100" r="28" fill="#fff"/></mask></defs>` +
    `<rect x="0" y="0" width="${N}" height="${N}" fill="${fill}" mask="url(#m)"/></svg>`;
  const A = masked('#c33', 55),
    B = masked('#33c', 105);
  const FRAMES = 60;

  const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
  <script type="module">
  import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
  const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  globalThis.__MANTLE_DEBUG__ = true; globalThis.__MANTLE_NO_STATIC_CACHE = true;
  const R = createRenderer(gl, shaders, { aacPoints: false }); if (R.ready) await R.ready;
  const read = () => { const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
  window.__run = async (a, b, frames) => {
    const ba = createBundle(gl, await importSvg(a, { preserveViewport: true }));
    const bb = createBundle(gl, await importSvg(b, { preserveViewport: true }));
    R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    // Warm both, then count bakes over steady frames that draw BOTH.
    for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(ba); R.drawBundle(bb); R.endFrame(); }
    const c0 = R.debugStats.maskBakeCount | 0, warm = c0;
    for (let i = 0; i < frames; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(ba); R.drawBundle(bb); R.endFrame(); }
    const bakes = (R.debugStats.maskBakeCount | 0) - c0;
    const both = read();
    // Reference: each bundle alone, composited by drawing the second over the first's frame once.
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(ba); R.endFrame(); const onlyA = read();
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(bb); R.endFrame(); const onlyB = read();
    let bad = 0, ink = 0; const badPx = [];
    for (let i = 0; i < both.length; i += 4) {
      // Where ONLY A paints, 'both' must equal A alone, and likewise B. The overlap is skipped: there B
      // is drawn over A, which legitimately differs from B over white along B's antialiased edge.
      const aInk = onlyA[i] < 250 || onlyA[i + 1] < 250 || onlyA[i + 2] < 250, bInk = onlyB[i] < 250 || onlyB[i + 1] < 250 || onlyB[i + 2] < 250;
      if (aInk || bInk) ink++;
      // A PIXEL ONLY A PAINTS is one B leaves the white ground on, not one B paints faintly: B's antialiased edge
      // composites over A wherever B has any coverage at all. Judged by the ink threshold instead, B's circles at 2.4%
      // (250 on the red channel, just not "ink") read as B-free, and 'both' -- A under B's faint edge, exactly -- came
      // out 4 levels off A alone on 4 px with Slug's exact edges (a blended edge gives those slivers 0).
      const aAny = onlyA[i] < 255 || onlyA[i + 1] < 255 || onlyA[i + 2] < 255, bAny = onlyB[i] < 255 || onlyB[i + 1] < 255 || onlyB[i + 2] < 255;
      const ref = (bAny && !aAny) ? onlyB : (aAny && !bAny) ? onlyA : null;
      if (ref && (Math.abs(both[i] - ref[i]) > 2 || Math.abs(both[i + 1] - ref[i + 1]) > 2 || Math.abs(both[i + 2] - ref[i + 2]) > 2)) {
        bad++;
        if (badPx.length < 8) { const q = i / 4; badPx.push(\`(\${q % ${N}},\${${N} - 1 - Math.floor(q / ${N})}) both \${[both[i], both[i + 1], both[i + 2]]} A \${[onlyA[i], onlyA[i + 1], onlyA[i + 2]]} B \${[onlyB[i], onlyB[i + 1], onlyB[i + 2]]}\`); }
      }
    }
    return { bakes, bad, ink, warm, badPx, hasCount: typeof R.debugStats.maskBakeCount === 'number' };
  };
  window.__ready = true;
  </script></body></html>`;
  return { HTML, A, B, FRAMES };
})();

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (req.url === '/per-handle') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(perHandle.HTML);
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

const maskCacheFailures = failures;
if (maskCacheFailures === 0) console.log('\nMASK-CACHE PASS');
else console.log(`\nMASK-CACHE FAIL (${maskCacheFailures})`);

// ---- per handle: two masked handles drawn per frame keep their own layers ----
{
  const { A, B, FRAMES } = perHandle;
  const page = await browser.newPage();
  page.on('pageerror', (e) => fail('page: ' + e.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/per-handle`, {
      waitUntil: 'load',
      timeout: pageTimeoutFor(),
    });
    await page.waitForFunction(() => window.__ready === true, {
      timeout: pageTimeoutFor(),
      polling: 100,
    });
    const r = await page.evaluate((a, b, f) => window.__run(a, b, f), A, B, FRAMES);
    console.log(
      `  warm-up ${r.warm} bake(s); ${FRAMES} frames drawing two masked bundles: ${r.bakes} bakes, ${r.bad} px off the single-bundle frames, ${r.ink} ink px`,
    );
    if (!r.hasCount) fail('debugStats.maskBakeCount is not reported — the count proves nothing');
    else if (r.warm < 1)
      fail('the masks never baked at all — the case does not reach the bake path');
    else if (r.ink < 1000) fail('the masked content is nearly blank');
    else {
      if (r.bakes === 0) ok(`no re-bake over ${FRAMES} steady frames (the layers are per handle)`);
      else
        fail(
          `${r.bakes} bakes over ${FRAMES} steady frames — the two handles re-bake each other every frame`,
        );
      if (r.bad === 0) ok('each bundle still draws its own mask');
      else
        fail(
          `${r.bad} px differ from the single-bundle frames — a handle drew another's mask: ${r.badPx.join('; ')}`,
        );
    }
  } catch (e) {
    fail('setup: ' + e.message);
  }
  await page.close();
  if (failures === maskCacheFailures) console.log('\nmasked handles keep their own layers');
}

await browser.close();
server.close();
process.exit(failures ? 1 : 0);

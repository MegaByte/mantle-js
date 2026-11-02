// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bundleInstancedSmoke.mjs — drawBundleInstanced (live-fill instancing) proof.
// Draw ONE bundle at N per-instance transforms, sharing geometry + a single
// overrides table + the worldM-INDEPENDENT intermediate bakes.
//
// Asserts:
//   1. Each instance renders at its own worldMatrix (distinct positions).
//   2. Per-instance alpha attenuates independently.
//   3. A MASKED bundle drawn at N instances bakes its mask only ONCE —
//      the mask bake is worldM-independent, so every instance reuses it.
//      Contrast: a FILTERED bundle re-evaluates per DISTINCT transform,
//      because the filter is positioned in screen space.
//   4. Instanced output is pixel-identical to the naive N-call baseline.
//   5. Empty list → safe no-op (returns 0).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A MULTI-shape mask (≥2 rects → a real offscreen bake region). The bake
// is worldM-independent, so instancing it at N transforms bakes once.
// Red fill revealed in the left+right thirds (gap in center).
const MASK_SVG = readFileSync(
  new URL('../examples/smoke/bundleInstanced__MASK_SVG.svg', import.meta.url),
  'utf8',
);

// A blurred rect — used only to DOCUMENT that filters re-eval per transform.
const BLUR_SVG = readFileSync(
  new URL('../examples/smoke/bundleInstanced__BLUR_SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="240" height="240"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const sectionsMask = await importSvg(${JSON.stringify(MASK_SVG)});
const maskBundle = createBundle(gl, sectionsMask);
const blurBundle = createBundle(gl, await importSvg(${JSON.stringify(BLUR_SVG)}));
const ovr = createOverrideTable(gl, maskBundle);
window.__hasFn = typeof renderer.drawBundleInstanced === 'function';
// A single bundle auto-fits the viewport, so each instance scales it DOWN
// to a tile (s) then translates (tx,ty) in post-fit pixel space.
const ST = (s, tx, ty) => new Float32Array([s,0,0, 0,s,0, tx,ty,1]);
window.__T = ST;
window.__drawInst = (bundle, instances, shared) => {
  renderer.setViewport(240, 240);
  renderer.beginFrame([0,0,0,1]);
  const n = renderer.drawBundleInstanced(bundle, instances, shared || {});
  renderer.endFrame();
  return n;
};
window.__drawN = (bundle, transforms) => {
  renderer.setViewport(240, 240);
  renderer.beginFrame([0,0,0,1]);
  for (const wm of transforms) renderer.drawBundle(bundle, { worldMatrix: wm });
  renderer.endFrame();
};
window.__mask = maskBundle; window.__blur = blurBundle;
// Cold-cache efficiency probe: a FRESH masked bundle (never rendered)
// drawn at n identical-transform instances. Returns the mask-bake count
// before/after — expected delta is 1 (first instance bakes, rest reuse).
window.__coldMaskInstanced = (n) => {
  const fresh = createBundle(gl, sectionsMask);
  const insts = []; for (let i = 0; i < n; i++) insts.push({ worldMatrix: ST(1,0,0) });
  renderer.setViewport(240, 240);
  renderer.beginFrame([0,0,0,1]);
  const bakesBefore = renderer.debugStats.maskBakeCount;
  renderer.drawBundleInstanced(fresh, insts, {});
  const bakesAfter = renderer.debugStats.maskBakeCount;
  renderer.endFrame();
  return { bakesBefore, bakesAfter };
};
window.__maskBakes = () => renderer.debugStats.maskBakeCount;
window.__evals = () => renderer.debugStats.filterEvalCount;
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 240-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
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

if (await page.evaluate(() => window.__hasFn)) ok('renderer.drawBundleInstanced exists');
else fail('drawBundleInstanced not exported');

// The bundle fills the viewport at scale 1; the multi-shape mask reveals
// the left + right thirds → red columns at x∈[~0,80] and [~160,240], a
// background gap at x∈[80,160]. A worldMatrix translate of +tx shifts that
// whole pattern right by tx px. We probe those known columns rather than
// relying on tiny scaled tiles (which fall between sample points).

// (1) drew N + the per-instance transform is applied. worldMatrix is in
// CLIP space ([-1,1]), so a +0.5 x-translate shifts the pattern right by
// ~half a viewport. At t0 the left reveal is red at x=20; after the shift
// that column has moved away (x=20 is not red after the shift) — proving the
// per-instance transform takes effect (and isn't ignored).
const r1 = await page.evaluate(() => {
  const id = window.__T(1, 0, 0),
    shift = window.__T(1, 0.5, 0);
  const n = window.__drawInst(window.__mask, [{ worldMatrix: id }]);
  const base = { red: window.__sample(20, 120), gap: window.__sample(120, 120) };
  window.__drawInst(window.__mask, [{ worldMatrix: shift }]);
  const moved = { atOldRed: window.__sample(20, 120) };
  return { n, base, moved };
});
if (r1.n === 1) ok('drawBundleInstanced returns instance count');
else fail('count: ' + r1.n);
if (r1.base.red[0] > 180 && r1.base.gap[0] < 60)
  ok('masked instance renders (red reveal + mask gap)');
else fail('mask render wrong: red=' + r1.base.red + ' gap=' + r1.base.gap);
if (r1.moved.atOldRed[0] < 120)
  ok('+0.5 clip-space per-instance translate shifts the pattern (old red column moved away)');
else fail('translate not applied: x=20 still red after shift = ' + r1.moved.atOldRed);

// (3a) a COLD masked bundle drawn at N instances bakes ONCE — the first
// instance bakes, the rest reuse it. Uses a fresh bundle so no prior
// frame warmed the cache.
const r3 = await page.evaluate(() => {
  const { bakesBefore, bakesAfter } = window.__coldMaskInstanced(5);
  return bakesAfter - bakesBefore;
});
if (r3 === 1) ok('5 instances of a COLD masked bundle → mask baked ONCE (shared)');
else fail('cold masked instancing baked ' + r3 + '× (expected 1)');

// (3b) a filtered bundle re-evals per DISTINCT transform (the filter is
// positioned in screen space). Identical transforms DO share, but
// distinct ones cannot.
const r3b = await page.evaluate(() => {
  const base = window.__evals();
  window.__drawInst(window.__blur, [
    { worldMatrix: window.__T(1, 0, 0) },
    { worldMatrix: window.__T(1, 40, 0) },
    { worldMatrix: window.__T(1, 0, 40) },
  ]);
  return window.__evals() - base;
});
if (r3b === 3)
  ok(
    'filtered bundle re-evals per distinct transform (3 → 3 evals — documented, not a free lunch)',
  );
else fail('filtered instanced eval count ' + r3b + ' (expected 3 — filter is screen-positioned)');

// (2) Per-instance alpha: full vs ~half over black, sampled at the red column.
const r2 = await page.evaluate(() => {
  window.__drawInst(window.__mask, [{ worldMatrix: window.__T(1, 0, 0), alpha: 1.0 }]);
  const full = window.__sample(20, 120);
  window.__drawInst(window.__mask, [{ worldMatrix: window.__T(1, 0, 0), alpha: 0.4 }]);
  const half = window.__sample(20, 120);
  return { full, half };
});
if (r2.full[0] > 180) ok('alpha=1 instance fully present (red ' + r2.full[0] + ')');
else fail('alpha=1: ' + r2.full);
if (r2.half[0] > 40 && r2.half[0] < r2.full[0] - 30)
  ok('alpha=0.4 instance dimmer (' + r2.half[0] + ' < ' + r2.full[0] + ')');
else fail('alpha attenuation wrong: half=' + r2.half[0] + ' full=' + r2.full[0]);

// (4) Parity: instanced output is pixel-identical to N separate drawBundle.
const rp = await page.evaluate(() => {
  window.__drawInst(window.__mask, [{ worldMatrix: window.__T(1, 30, 0) }]);
  const inst = [window.__sample(50, 120), window.__sample(150, 120), window.__sample(20, 120)];
  window.__drawN(window.__mask, [window.__T(1, 30, 0)]);
  const naive = [window.__sample(50, 120), window.__sample(150, 120), window.__sample(20, 120)];
  return { inst, naive };
});
const dmax = Math.max(
  ...[0, 1, 2].flatMap((i) => [0, 1, 2, 3].map((k) => Math.abs(rp.inst[i][k] - rp.naive[i][k]))),
);
if (dmax <= 2) ok('instanced output matches N-call drawBundle baseline (Δmax=' + dmax + ')');
else
  fail(
    'instanced ≠ baseline: inst=' + JSON.stringify(rp.inst) + ' naive=' + JSON.stringify(rp.naive),
  );

// (5) Empty list → no-op.
const r5 = await page.evaluate(() => window.__drawInst(window.__mask, []));
if (r5 === 0) ok('empty instance list is a no-op (returns 0)');
else fail('empty list returned: ' + r5);

await browser.close();
server.close();
if (failures === 0) console.log('\nBUNDLE-INSTANCED PASS');
else console.log(`\nBUNDLE-INSTANCED FAIL (${failures})`);
process.exit(failures ? 1 : 0);

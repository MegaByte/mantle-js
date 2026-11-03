// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// bundleInstancedSmoke — drawBundleInstanced: one bundle at many per-instance transforms, on the
// instanced fast path where it can and the per-instance loop where it must:
//   bundleInstanced                shared geometry, overrides and intermediate bakes per instance
//   instancedFlatTintAlphaRender   flat-tinted, faded instances all keep the same opacity
//   bundleInstancedTint            per-instance tint on the fast path, colorMatrix on the loop
//   instancedBundleRenderDiff      the fast path is byte-identical to the per-instance loop
//   instancedFog                   a per-instance fog stays on the fast path
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openReady } from './_pageReady.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// bundleInstanced — drawBundleInstanced (live-fill instancing) proof.
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
async function bundleInstanced(host) {
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

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await openReady(page, host.page(HTML), { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
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
      'instanced ≠ baseline: inst=' +
        JSON.stringify(rp.inst) +
        ' naive=' +
        JSON.stringify(rp.naive),
    );

  // (5) Empty list → no-op.
  const r5 = await page.evaluate(() => window.__drawInst(window.__mask, []));
  if (r5 === 0) ok('empty instance list is a no-op (returns 0)');
  else fail('empty list returned: ' + r5);

  await page.close();
  if (failures === 0) console.log('\nBUNDLE-INSTANCED PASS');
  else console.log(`\nBUNDLE-INSTANCED FAIL (${failures})`);
  return failures;
}

// instancedFlatTintAlphaRender — one instanced run of the same one-circle bundle, every instance recolored to a flat tint
// (colorMatrix = zero 4x4 but m[15] = 1, colorMatrixOffset = (r, g, b, 0)) and faded by the same alpha, paints every instance alike.
//
// In a ring of 12 such instances no instance may come out at a different opacity from the others (an alpha-1 run is the uniform
// control). Each cell draws the ring through drawBundleInstanced and samples every instance's center; all centers
// must agree within 2/255 per channel and equal the same instance drawn on its own through drawBundle (the per-draw reference).
async function instancedFlatTintAlphaRender(host) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const CIRCLE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#ffffff"/></svg>';
  const W = 256;
  const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${W}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const W = ${W};
// 12 instances on a ring (clip space), each a 0.16-wide copy of the bundle
const ring = (n) => Array.from({ length: n }, (_, i) => {
  const a = Math.PI / 2 - i * 2 * Math.PI / n, s = 0.16, cx = 0.7 * Math.cos(a), cy = 0.7 * Math.sin(a);
  return { cx, cy, m: new Float32Array([s, 0, 0, 0, s, 0, cx, cy, 1]) };
});
const flat = (r, g, b) => { const cm = new Float32Array(16); cm[15] = 1; return { colorMatrix: cm, colorMatrixOffset: new Float32Array([r, g, b, 0]) }; };
const px = (cx, cy) => { const b = new Uint8Array(4); const x = Math.round((cx + 1) / 2 * W), y = Math.round((cy + 1) / 2 * W); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return Array.from(b); };
window.__run = async (route, alpha, n, mode) => {
  R.setViewport(W, W);
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(${JSON.stringify(CIRCLE)}, { preserveViewport: true }));
  const pos = ring(n);
  const insts = pos.map((p) => ({ worldMatrix: p.m, alpha, ...flat(0.8, 0.8, 0.8) }));
  const drawInst = () => { R.beginFrame([0.05, 0.33, 0.4, 1]); R.drawBundleInstanced(b, insts, {}); R.endFrame(); };
  const drawSeq = () => { R.beginFrame([0.05, 0.33, 0.4, 1]); for (const it of insts) R.drawBundle(b, it); R.endFrame(); };
  const draw = mode === 'seq' ? drawSeq : drawInst;
  const warm = await R.warmScene([{ draw }], { maxPasses: 16, fenceTimeoutMs: 60000 });
  if (!warm.complete) throw new Error('Scene warming incomplete');
  draw(); draw();
  const out = pos.map((p) => px(p.cx, p.cy));
  b.dispose();
  return out;
};
window.__ready = true;
</script></body></html>`;
  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(host.page(HTML), { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  const actualDevice = await page.evaluate(() => {
    const gl = document.getElementById('c').getContext('webgl2');
    return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
  });
  if (
    process.env.MANTLE_TEST_GL === 'metal' &&
    (!/Metal/.test(actualDevice) || /SwiftShader/.test(actualDevice))
  )
    throw new Error('Physical Metal required: ' + actualDevice);
  console.log('ACTUAL_DEVICE ' + actualDevice);
  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };
  const d = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
  for (const route of ['auto', 'none'])
    for (const alpha of [1, 0.35, 0.6])
      for (const n of [12, 7]) {
        const tag = `ring of ${n}, flat tint, alpha ${alpha} [${route}]`;
        let inst, seq;
        try {
          inst = await page.evaluate((r, a, k) => window.__run(r, a, k, 'inst'), route, alpha, n);
          seq = await page.evaluate((r, a, k) => window.__run(r, a, k, 'seq'), route, alpha, n);
        } catch (e) {
          fail(tag + ': ' + e.message);
          continue;
        }
        const ref = seq[0];
        const bad = inst.map((p, i) => [i, p]).filter(([, p]) => d(p, ref) > 2);
        const seqBad = seq.filter((p) => d(p, ref) > 2).length;
        if (seqBad)
          fail(tag + ': the per-draw reference itself is not uniform: ' + JSON.stringify(seq));
        else if (bad.length)
          fail(
            tag +
              `: instances ${bad.map(([i]) => i).join(',')} differ from the per-draw reference ${ref}: ` +
              bad.map(([i, p]) => `#${i}=[${p}]`).join(' '),
          );
        else ok(tag + `: all ${n} centres = [${ref}]`);
      }
  await page.close();
  if (!failures)
    console.log('\ninstancedFlatTintAlphaRenderSmoke: flat-tinted faded instances paint alike');
  return failures;
}

// bundleInstancedTint — per-instance COLOR on drawBundleInstanced.
//
// Asserts:
//   1. A simple fill-only bundle with ≥2 instances takes the GPU fast path
//      (debugStats.instancedFastCount bumps) and per-instance rgba `tint`
//      recolors each instance independently.
//   2. Fast path vs per-instance loop (_setInstancedFast(false)) is
//      pixel-identical for the same tinted instance list — the loop composes
//      the tint into an effective colorMatrix, the fast path rides an
//      instanced attribute; both must land on the same pixels.
//   3. Instanced+tinted output matches the naive N × drawBundle baseline
//      (per-draw colorMatrix = diag(tint)) pixel-for-pixel.
//   4. A per-instance FULL colorMatrix/offset falls back to the loop (fast
//      count does NOT bump) and applies correctly (R↔G swap, blue offset).
//   5. Per-instance tint composes UNDER the shared colorMatrix identically
//      on both routes (tint first, then shared matrix).
//   6. Per-instance alpha and tint combine on the fast path.
async function bundleInstancedTint(host) {
  // Simple TWO-shape fill-only bundle (fast-path eligible): white field with a
  // mid-gray inner square. Two shapes exercise the compacted cover-quad +
  // per-instance painter order, and tints scale both predictably.
  const SIMPLE_SVG = readFileSync(
    new URL('../examples/smoke/bundleInstancedTint__SIMPLE_SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="240" height="240"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SIMPLE_SVG)}));
// clip-space scale+translate: bundle auto-fits the viewport, each instance
// scales it down to a tile then translates in post-fit clip space.
const ST = (s, tx, ty) => new Float32Array([s,0,0, 0,s,0, tx,ty,1]);
window.__T = ST;
window.__fastCount = () => renderer.debugStats.instancedFastCount;
window.__setFast = (v) => renderer._setInstancedFast(v);
window.__drawInst = (instances, shared) => {
  renderer.setViewport(240, 240);
  renderer.beginFrame([0,0,0,1]);
  const n = renderer.drawBundleInstanced(bundle, instances, shared || {});
  renderer.endFrame();
  return n;
};
window.__drawSeq = (draws) => {
  renderer.setViewport(240, 240);
  renderer.beginFrame([0,0,0,1]);
  for (const d of draws) renderer.drawBundle(bundle, d);
  renderer.endFrame();
};
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 240-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
// Full-frame snapshot for pixel-for-pixel parity (returned as plain array
// checksum + a downsampled grid so the wire payload stays small: 24×24 grid
// of exact pixels + a full-buffer max-diff helper kept in-page).
let __snapA = null;
window.__grab = (slot) => {
  const buf = new Uint8Array(240*240*4);
  gl.readPixels(0, 0, 240, 240, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  if (slot === 0) { __snapA = buf; return 0; }
  let dmax = 0;
  for (let i = 0; i < buf.length; i++) { const d = Math.abs(buf[i] - __snapA[i]); if (d > dmax) dmax = d; }
  return dmax;
};
window.__ready = true;
</script></body></html>`;

  let failures = 0;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await openReady(page, host.page(HTML), { ready: 'flag' });
  } catch (e) {
    fail('setup: ' + e.message);
    await page.close();
    return 1;
  }

  // The instanced program links in the background where the driver compiles in parallel; the per-instance loop draws until it is done.
  await page.evaluate(`(async () => {
  for (let f = 0; f < 1200 && !(window.__fastCount() > 0); f++) {
    window.__drawInst([{ worldMatrix: window.__T(0.45, -0.5, 0) }, { worldMatrix: window.__T(0.45, 0.5, 0) }]);
    await new Promise((q) => setTimeout(q, 25));
  }
})()`);

  // Two side-by-side tiles: left tinted red, right tinted green. Tile centers:
  // clip x = ∓0.5 → px 60 / 180; white field sample at the tile center offset
  // left 30px (outside the inner gray square), gray sample at the exact center.
  const T = { s: 0.45 };
  const tiles = `[
  { worldMatrix: window.__T(0.45, -0.5, 0), tint: [1, 0, 0, 1] },
  { worldMatrix: window.__T(0.45,  0.5, 0), tint: [0, 1, 0, 1] },
]`;

  // (1) fast path taken + per-instance tint applies.
  const r1 = await page.evaluate(`(() => {
  const before = window.__fastCount();
  const n = window.__drawInst(${tiles});
  const after = window.__fastCount();
  return { n, dFast: after - before,
    leftWhite: window.__sample(30, 120), leftGray: window.__sample(60, 120),
    rightWhite: window.__sample(150, 120), rightGray: window.__sample(180, 120) };
})()`);
  if (r1.n === 2 && r1.dFast === 1)
    ok('2 simple tinted instances take the GPU fast path (fastCount +1)');
  else fail('fast path not taken: n=' + r1.n + ' dFast=' + r1.dFast);
  if (
    r1.leftWhite[0] > 220 &&
    r1.leftWhite[1] < 30 &&
    r1.leftGray[0] > 90 &&
    r1.leftGray[0] < 170 &&
    r1.leftGray[1] < 30
  )
    ok(
      'left instance tinted red (white→red ' +
        r1.leftWhite +
        ', gray→dark red ' +
        r1.leftGray +
        ')',
    );
  else fail('left tint wrong: white=' + r1.leftWhite + ' gray=' + r1.leftGray);
  if (
    r1.rightWhite[1] > 220 &&
    r1.rightWhite[0] < 30 &&
    r1.rightGray[1] > 90 &&
    r1.rightGray[1] < 170 &&
    r1.rightGray[0] < 30
  )
    ok('right instance tinted green independently (' + r1.rightWhite + ' / ' + r1.rightGray + ')');
  else fail('right tint wrong: white=' + r1.rightWhite + ' gray=' + r1.rightGray);

  // (2) fast path vs per-instance loop: pixel-identical.
  const r2 = await page.evaluate(`(() => {
  window.__drawInst(${tiles});
  window.__grab(0);
  window.__setFast(false);
  const before = window.__fastCount();
  window.__drawInst(${tiles});
  window.__setFast(true);
  return { dmax: window.__grab(1), dFast: window.__fastCount() - before };
})()`);
  if (r2.dFast === 0) ok('_setInstancedFast(false) routes the same call through the loop');
  else fail('toggle did not disable the fast path');
  if (r2.dmax <= 2) ok('fast path ≡ per-instance loop for tinted instances (Δmax=' + r2.dmax + ')');
  else fail('fast vs loop tint mismatch: Δmax=' + r2.dmax);

  // (3) instanced+tint ≡ naive N × drawBundle with colorMatrix = diag(tint).
  const r3 = await page.evaluate(`(() => {
  window.__drawInst(${tiles});
  window.__grab(0);
  const diag = (r,g,b,a) => new Float32Array([r,0,0,0, 0,g,0,0, 0,0,b,0, 0,0,0,a]);
  window.__drawSeq([
    { worldMatrix: window.__T(0.45, -0.5, 0), colorMatrix: diag(1,0,0,1) },
    { worldMatrix: window.__T(0.45,  0.5, 0), colorMatrix: diag(0,1,0,1) },
  ]);
  return window.__grab(1);
})()`);
  if (r3 <= 2)
    ok('instanced tint ≡ sequential drawBundle diag-colorMatrix baseline (Δmax=' + r3 + ')');
  else fail('instanced vs sequential baseline mismatch: Δmax=' + r3);

  // (4) per-instance FULL colorMatrix/offset → loop fallback, correct output.
  const r4 = await page.evaluate(`(() => {
  const swapRG = new Float32Array([0,1,0,0, 1,0,0,0, 0,0,1,0, 0,0,0,1]);
  const before = window.__fastCount();
  window.__drawInst([
    { worldMatrix: window.__T(0.45, -0.5, 0), tint: [1,0,0,1], colorMatrix: swapRG },
    { worldMatrix: window.__T(0.45,  0.5, 0), colorMatrixOffset: new Float32Array([0,0,1,0]) },
  ]);
  const dFast = window.__fastCount() - before;
  const left = window.__sample(30, 120);            // red tint then R↔G swap → green
  const right = window.__sample(150, 120);          // white + blue offset → still white (clamped)
  const rightGray = window.__sample(180, 120);      // gray + blue offset → blue channel saturates
  window.__grab(0);
  // Baseline: sequential draws with the equivalent composed matrices.
  const eff = new Float32Array([0,1,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1]); // swapRG · diag(1,0,0,1)
  window.__drawSeq([
    { worldMatrix: window.__T(0.45, -0.5, 0), colorMatrix: eff },
    { worldMatrix: window.__T(0.45,  0.5, 0), colorMatrixOffset: new Float32Array([0,0,1,0]) },
  ]);
  const dmax = window.__grab(1);
  return { dFast, left, right, rightGray, dmax };
})()`);
  if (r4.dFast === 0) ok('per-instance colorMatrix falls back to the per-instance loop');
  else fail('full colorMatrix wrongly took the fast path');
  if (r4.left[1] > 220 && r4.left[0] < 30)
    ok('tint→matrix compose order: red tint then R↔G swap = green (' + r4.left + ')');
  else fail('tint∘matrix compose wrong: ' + r4.left);
  if (r4.rightGray[2] > 220)
    ok('per-instance colorMatrixOffset applies (+blue → ' + r4.rightGray + ')');
  else fail('colorMatrixOffset not applied: ' + r4.rightGray);
  if (r4.dmax <= 2)
    ok('loop-path instanced CM ≡ sequential composed baseline (Δmax=' + r4.dmax + ')');
  else fail('instanced CM vs baseline mismatch: Δmax=' + r4.dmax);

  // (5) per-instance tint UNDER a shared colorMatrix — identical on both routes.
  const r5 = await page.evaluate(`(() => {
  window.__f5 = window.__fastCount();
  const swapRG = new Float32Array([0,1,0,0, 1,0,0,0, 0,0,1,0, 0,0,0,1]);
  const insts = [
    { worldMatrix: window.__T(0.45, -0.5, 0), tint: [1,0,0,1] },
    { worldMatrix: window.__T(0.45,  0.5, 0), tint: [0,1,0,1] },
  ];
  // (a shared matrix changes which features the program omits, so it is a new program that links in the background)
  return (async () => {
  for (let f = 0; f < 1200 && !(window.__fastCount() > window.__f5); f++) {
    window.__drawInst(insts, { colorMatrix: swapRG });
    await new Promise((q) => setTimeout(q, 25));
  }
  const before = window.__fastCount();
  window.__drawInst(insts, { colorMatrix: swapRG });
  const dFast = window.__fastCount() - before;
  const left = window.__sample(30, 120);    // white·red = red, then swap → green
  window.__grab(0);
  window.__setFast(false);
  window.__drawInst(insts, { colorMatrix: swapRG });
  window.__setFast(true);
  return { dFast, left, dmax: window.__grab(1) };
  })();
})()`);
  if (r5.dFast === 1) ok('tint + SHARED colorMatrix stays on the fast path');
  else fail('shared CM + tint did not take fast path');
  if (r5.left[1] > 220 && r5.left[0] < 30)
    ok('shared matrix applies AFTER the instance tint (red→swap→green: ' + r5.left + ')');
  else fail('shared∘tint order wrong: ' + r5.left);
  if (r5.dmax <= 2) ok('shared CM + tint: fast ≡ loop (Δmax=' + r5.dmax + ')');
  else fail('shared CM + tint fast vs loop mismatch: Δmax=' + r5.dmax);

  // (6) alpha and tint combine per instance on the fast path (over black:
  // premultiplied red at half alpha ≈ 128,0,0).
  const r6 = await page.evaluate(`(() => {
  window.__drawInst([
    { worldMatrix: window.__T(0.45, -0.5, 0), tint: [1,0,0,1], alpha: 0.5 },
    { worldMatrix: window.__T(0.45,  0.5, 0), tint: [1,0,0,1], alpha: 1.0 },
  ]);
  return { half: window.__sample(30, 120), full: window.__sample(150, 120) };
})()`);
  if (r6.full[0] > 220 && r6.half[0] > 90 && r6.half[0] < 170)
    ok('per-instance alpha × tint (full=' + r6.full[0] + ', half=' + r6.half[0] + ')');
  else fail('alpha×tint wrong: half=' + r6.half + ' full=' + r6.full);

  await page.close();
  if (failures === 0) console.log('\nBUNDLE-INSTANCED-TINT PASS');
  else console.log(`\nBUNDLE-INSTANCED-TINT FAIL (${failures})`);
  return failures;
}

// instancedBundleRenderDiff — proves the drawBundleInstanced GPU
// fast path (one drawArraysInstanced per cover-quad chunk, per-instance
// worldMatrix+alpha streamed from a vertex buffer read by the
// MANTLE_INSTANCED vertex variant) renders BYTE-IDENTICAL to the
// per-instance render() loop it replaces.
//
//   A = drawBundleInstanced with the fast path ON  (default)
//   B = drawBundleInstanced with the fast path OFF (_setInstancedFast(false)
//       → the per-instance render() loop)
//   assert A === B byte-for-byte.
//
// Two cases: plain (worldMatrix + per-instance alpha) and a shared
// override table (exercises the uHasOverrides path that every instance
// reads). The non-instanced drawBundle path is never touched.
async function instancedBundleRenderDiff(host) {
  let failures = 0;
  const ok = (m) => console.log('ok', m);
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };

  const SVG = readFileSync(
    new URL('../examples/smoke/instancedBundleRenderDiff__SVG.svg', import.meta.url),
    'utf8',
  );

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const W = 256, H = 256;
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sec = await importSvg(${JSON.stringify(SVG)});

// 4 instances: quadrants, scaled 0.5, varying alpha. worldMatrix is a
// column-major mat3 applied in clip space ([m00,m10,0, m01,m11,0, tx,ty,1]).
function wm(s, tx, ty) { return new Float32Array([s,0,0, 0,s,0, tx,ty,1]); }
const INSTANCES = [
  { worldMatrix: wm(0.5, -0.5,  0.5), alpha: 1.0 },
  { worldMatrix: wm(0.5,  0.5,  0.5), alpha: 0.6 },
  { worldMatrix: wm(0.5, -0.5, -0.5), alpha: 0.85 },
  { worldMatrix: wm(0.45, 0.5, -0.5), alpha: 1.0 },
];

function readback() {
  const buf = new Uint8Array(W*H*4);
  gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,buf);
  return buf;
}

// Render the instances with the fast path forced on/off. Fresh bundle +
// renderer each call so neither shares state.
function renderInstanced(fast, shared) {
  const bundle = createBundle(gl, sec);
  const renderer = createRenderer(gl, shaders);
  renderer.setViewport(W, H);
  renderer._setInstancedFast(fast);
  let sh = shared;
  if (shared === 'overrides') {
    const ov = createOverrideTable(gl, bundle);
    sh = { overrides: ov };
  }
  // drawBundleInstanced accumulates N copies; it must run inside a frame
  // (beginFrame owns the single color clear — standalone render() would
  // clear color per instance and show only the last).
  renderer.beginFrame([0, 0, 0, 0]);
  const n = renderer.drawBundleInstanced(bundle, INSTANCES, sh || undefined);
  renderer.endFrame();
  const buf = readback();
  bundle.dispose(); renderer.dispose();
  return { buf, n };
}

const result = { cases: [] };
try {
  for (const [name, shared] of [['plain', null], ['overrides', 'overrides']]) {
    const A = renderInstanced(true, shared);
    const B = renderInstanced(false, shared);
    let maxDiff = 0, nDiff = 0, ink = 0;
    for (let i = 0; i < A.buf.length; i++) {
      const d = Math.abs(A.buf[i] - B.buf[i]);
      if (d > maxDiff) maxDiff = d;
      if (d !== 0) nDiff++;
      if (B.buf[i] !== 0) ink++;
    }
    result.cases.push({ name, maxDiff, nDiff, ink, nFast: A.n, nLoop: B.n });
  }
  result.compiled = true;
} catch (e) { result.error = String(e && e.stack || e); }
window.__result = result;
window.__done = true;
</script></body></html>`;

  const url = host.page(HTML);
  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  await page.goto(url, { waitUntil: 'load', timeout: 15000 });
  await page
    .waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 })
    .catch(() => {});
  const r = await page.evaluate(() => window.__result);
  await page.close();

  if (!r || !r.compiled) {
    fail('instanced render did not complete: ' + ((r && r.error) || 'page error'));
  } else
    for (const c of r.cases) {
      // Bar: ≤1 LSB at a handful of subpixels. The instanced path issues ONE
      // drawArraysInstanced (instance-major) where the loop issues N separate
      // draws; at an instance-seam AA edge that can round 1 LSB differently —
      // a sub-quantization rasterization artifact, not a logic difference (the
      // override case is exactly byte-identical). A real bug (wrong transform /
      // missing instance / bad order) shows maxDiff in the dozens-to-hundreds
      // over thousands of pixels, which this gate still catches.
      if (c.nFast !== 4 || c.nLoop !== 4)
        fail(`${c.name}: drew ${c.nFast}/${c.nLoop} instances (expected 4/4)`);
      else if (c.ink === 0) fail(`${c.name}: nothing rendered`);
      else if (c.maxDiff === 0)
        ok(`${c.name}: instanced == per-instance loop byte-identical (ink=${c.ink})`);
      else if (c.maxDiff <= 1 && c.nDiff <= 16)
        ok(
          `${c.name}: instanced matches loop within 1 LSB (nDiff=${c.nDiff}/${c.ink}, ink=${c.ink})`,
        );
      else fail(`${c.name}: instanced differs (maxDiff=${c.maxDiff}, nDiff=${c.nDiff})`);
    }
  if (!failures)
    console.log(
      '\ninstancedBundleRenderDiffSmoke: drawBundleInstanced fast path is byte-identical to the loop',
    );
  return failures;
}

// instancedFog — a fog must stay on the instanced fast path.
//
// A distance fog
//     out.rgb = in.rgb * fog + fogColor * (1 - fog)
// is a diagonal scale PLUS an RGB offset, per instance, expressed as a per-instance
// colorMatrix + colorMatrixOffset. If that took the whole draw off the instanced fast path, a
// screen of hazards would collapse into one draw call each. The fragment math is not the cost;
// the draw calls are.
//
// A diagonal matrix IS a tint; a diagonal matrix plus an offset is a tint plus a bias. The
// fast path carries both as per-instance attributes.
//
// Two things must hold, and the second is the one that bites:
//   1. it takes the fast path (ONE drawArraysInstanced, not N draws);
//   2. it paints exactly what the general per-instance loop paints — the loop composes the
//      same fog into a full color matrix, so the two must agree pixel for pixel.
async function instancedFog(host) {
  const url = host.url(`mantleDemo.html`);

  let failures = 0;
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  const ok = (m) => console.log('ok', m);

  const { browser } = host;
  const page = await browser.newPage();
  await page.setViewport({ width: 500, height: 500 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));

  // Count real GPU draw calls, so "it took the fast path" is measured, not assumed.
  await page.evaluateOnNewDocument(() => {
    globalThis.__draws = 0;
    globalThis.__inst = 0;
    const P = WebGL2RenderingContext.prototype;
    const da = P.drawArrays;
    P.drawArrays = function (...a) {
      globalThis.__draws++;
      return da.apply(this, a);
    };
    const di = P.drawArraysInstanced;
    P.drawArraysInstanced = function (...a) {
      globalThis.__inst++;
      return di.apply(this, a);
    };
  });
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
    timeout: 20000,
    polling: 100,
  });

  const res = await page.evaluate(async () => {
    const { importSvg, createBundle } = await import('/src/index.js');
    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    const cnv = document.getElementById('glcanvas');
    const W = 600,
      H = 400;
    cnv.width = W;
    cnv.height = H;

    // This one is loaded INSIDE page.evaluate — browser context, where readFileSync and

    // import.meta do not exist. The smoke's own server already serves the package root.

    const SVG = await (await fetch('/examples/smoke/instancedFog__SVG.svg')).text();
    const b = createBundle(gl, await importSvg(SVG));

    // The fog, exactly as writeFog builds it: diagonal scale + RGB offset.
    const FOG_COLOR = [0.25, 0.45, 0.75];
    const mkFog = (fog) => {
      const m = new Float32Array(16);
      m[0] = fog;
      m[5] = fog;
      m[10] = fog;
      m[15] = 1; // diagonal scale
      const off = new Float32Array([
        FOG_COLOR[0] * (1 - fog),
        FOG_COLOR[1] * (1 - fog),
        FOG_COLOR[2] * (1 - fog),
        0,
      ]); // + color offset
      return { colorMatrix: m, colorMatrixOffset: off };
    };
    const N = 6;
    const mkInstances = () =>
      Array.from({ length: N }, (_, i) => {
        const fog = 1 - i * 0.15;
        return { worldMatrix: [0.28, 0, 0, 0, 0.28, 0, -0.75 + i * 0.3, 0, 1], ...mkFog(fog) };
      });

    const shot = () => {
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    // FAST PATH (default).
    globalThis.__MANTLE_DEBUG__ = true;
    globalThis.__MANTLE_NO_INSTANCED_FAST = undefined;
    // The instanced program links in the background where the driver compiles in parallel; the per-instance loop draws until it is done.
    for (let f = 0; f < 1200 && !(renderer.debugStats.instancedFastCount > 0); f++) {
      renderer.beginFrame([1, 1, 1, 1]);
      renderer.drawBundleInstanced(b, mkInstances());
      renderer.endFrame();
      await new Promise((q) => setTimeout(q, 25));
    }
    globalThis.__draws = 0;
    globalThis.__inst = 0;
    renderer.beginFrame([1, 1, 1, 1]);
    renderer.drawBundleInstanced(b, mkInstances());
    renderer.endFrame();
    const fast = shot();
    const fastCalls = { draws: globalThis.__draws, inst: globalThis.__inst };

    // THE LOOP (the general path), which composes the same fog into a full color matrix.
    globalThis.__MANTLE_NO_INSTANCED_FAST = true;
    globalThis.__draws = 0;
    globalThis.__inst = 0;
    renderer.beginFrame([1, 1, 1, 1]);
    renderer.drawBundleInstanced(b, mkInstances());
    renderer.endFrame();
    const loop = shot();
    const loopCalls = { draws: globalThis.__draws, inst: globalThis.__inst };
    globalThis.__MANTLE_NO_INSTANCED_FAST = undefined;

    let diff = 0,
      worst = 0,
      ink = 0,
      fogged = 0;
    // W,H are the canvas dims already in scope — the buffer is 600x400, not square.
    const dAt = (p) => {
      const i = p * 4;
      return Math.max(
        Math.abs(fast[i] - loop[i]),
        Math.abs(fast[i + 1] - loop[i + 1]),
        Math.abs(fast[i + 2] - loop[i + 2]),
      );
    };
    let edgeAdj = 0,
      interior = 0;
    for (let p = 0; p < W * H; p++) {
      if (dAt(p) <= 1) continue;
      const x = p % W,
        y = (p / W) | 0;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          if (dAt(ny * W + nx) === 0) {
            near = true;
            break;
          }
        }
      if (near) edgeAdj++;
      else interior++;
    }
    globalThis.__diffShape = { edgeAdj, interior };
    for (let i = 0; i < fast.length; i += 4) {
      const nonWhite = fast[i] < 245 || fast[i + 1] < 245 || fast[i + 2] < 245;
      if (nonWhite) ink++;
      // A fogged white square is tinted toward FOG_COLOR — bluer than it is red.
      if (nonWhite && fast[i + 2] > fast[i] + 25) fogged++;
      const d = Math.max(
        Math.abs(fast[i] - loop[i]),
        Math.abs(fast[i + 1] - loop[i + 1]),
        Math.abs(fast[i + 2] - loop[i + 2]),
      );
      if (d > 1) diff++;
      if (d > worst) worst = d;
    }
    b.dispose();
    return { diff, worst, ink, fogged, N, fastCalls, loopCalls, shape: globalThis.__diffShape };
  });

  console.log(
    `  fast path: ${res.fastCalls.inst} instanced + ${res.fastCalls.draws} plain draws   ` +
      `loop: ${res.loopCalls.inst} instanced + ${res.loopCalls.draws} plain draws`,
  );
  console.log(`  differing px: ${JSON.stringify(res.shape)}`);
  console.log(
    `  ink ${res.ink}px   visibly fogged ${res.fogged}px   fast-vs-loop ${res.diff}px differ (worst ${res.worst})`,
  );

  if (res.ink < 2000) {
    fail(`the hazards barely rendered (${res.ink}px) — nothing below would prove anything`);
  } else {
    ok(`the ${res.N} fogged instances render (${res.ink}px)`);
  }
  if (res.fogged < 500) {
    fail(
      `no instance is visibly fogged (${res.fogged}px tinted toward the fog color) — the ` +
        `OFFSET is being dropped, so a fog would render as a plain tint and this smoke would ` +
        `pass on a bug`,
    );
  } else {
    ok(`the fog's OFFSET is applied (${res.fogged}px pulled toward the fog color)`);
  }
  if (res.fastCalls.inst !== 1) {
    fail(
      `the fog did NOT take the instanced fast path: ${res.fastCalls.inst} instanced draws, ` +
        `${res.fastCalls.draws} plain ones for ${res.N} instances. A diagonal color matrix + ` +
        `offset is a tint + bias and must stay instanced — otherwise a screen of hazards is ` +
        `one draw call each.`,
    );
  } else {
    ok(`the fog stays on the fast path (1 drawArraysInstanced for ${res.N} instances)`);
  }
  // INTERIOR pixels must match exactly; ANTIALIASED EDGE pixels may not. The two
  // paths are separate shader programs computing the same formula, and the
  // exact-area stroke AA (the default) is enough
  // arithmetic that their last bits diverge on an edge pixel. A pixel with a
  // neighbor where the two agree exactly sits on an edge; one without lies
  // inside a region both agree is covered, which is what a real fog-algebra
  // difference would look like.
  //
  // The differing pixels are all edge-adjacent, none interior, so asserting on a
  // raw count would price antialiasing as a bug.
  if (res.shape && res.shape.interior > 0) {
    fail(
      `the fast path and the per-instance loop disagree on ${res.shape.interior}px ` +
        `INSIDE the shape (worst ${res.worst}). ` +
        `The loop composes the same fog into a full color matrix; the fast path folds it into ` +
        `a tint + bias. They must be the same picture.`,
    );
  } else {
    ok(
      `fast path == loop on every INTERIOR px ` +
        `(${res.ink}px ink, ${res.fogged}px fogged; ${res.shape ? res.shape.edgeAdj : 0} AA-edge px differ, worst ${res.worst})`,
    );
  }

  await page.close();
  console.log(failures ? `\nFAILURES: ${failures}` : '\nINSTANCED-FOG PASS');
  return failures;
}

const host = await openCaseHost(ROOT);
const failures = await runCases(host, [
  ['bundleInstanced', bundleInstanced],
  ['instancedFlatTintAlphaRender', instancedFlatTintAlphaRender],
  ['bundleInstancedTint', bundleInstancedTint],
  ['instancedBundleRenderDiff', instancedBundleRenderDiff],
  ['instancedFog', instancedFog],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nbundleInstancedSmoke: instanced draws match their per-instance references');

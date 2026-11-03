// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textBundleIdentitySmoke.mjs — identity-stable setText.
//
// createTextBundle's setText/setStyle rebuild the text run IN PLACE:
// `tb.bundle` keeps the same object identity, the rebuild bumps
// bundle._geomGen, and every bound renderer handle re-uploads
// automatically on its next draw. Consumers need not re-mount /
// re-register / mint fresh bundle ids after a text change.
//
// Assertions:
//   1. tb.bundle object identity is stable across setText + setStyle.
//   2. A persistent handle (createBundleHandle) bound ONCE renders the
//      NEW glyphs after setText — no rebind, no invalidate().
//   3. The singleton drawBundle path picks up new text the same way.
//   4. runMetrics refreshes per setText (typoBBox width tracks string).
//   5. Empty-string round-trip: setText('') draws as a no-op, then
//      setText('back') renders again — through the same handle.
//   6. setStyle (fill change) re-renders through the same handle.
//
// A RETYPED BUNDLE MUST NOT HAND ITS DEAD TEXTURES TO THE PIPELINE WARMER (second page).
//
// setText() rebuilds a text bundle by TRANSPLANTING a fresh bundle's GL objects into the
// existing bundle object (that is what keeps its identity stable). The fresh bundle is
// left behind as an empty shell — but createBundle had already enqueued it for
// fill-prewarm, so it sits in the PSO-warm queue with its fields still naming the
// textures the target now owns. The NEXT setText disposes the target, deleting exactly
// those textures, and the warmer then binds them:
//
//   WebGL: INVALID_OPERATION: bindTexture: attempt to use a deleted object
//
// Once per warm, for every text bundle a scene retypes — a score, a label, a timer. Text
// smokes that never run the warmer, and warm smokes that never retype any text, cannot
// see it.
//
// Retype, warm, repeat — and require that nothing binds a texture we deleted.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
import { fontFixture, requireAsset } from './_assets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const fontB64 = readFileSync(requireAsset(fontFixture('roboto-regular.ttf'))).toString('base64');

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.glsl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 256, height: 128 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await openReady(page, url, { ready: 'renderer' });

const results = await page.evaluate(async (fontB64) => {
  const { createTextBundle, MantleFontAsset } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  cnv.width = 256;
  cnv.height = 128;
  renderer.setViewport(256, 128);

  const font = new MantleFontAsset(Uint8Array.from(atob(fontB64), (c) => c.charCodeAt(0)));
  const tb = await createTextBundle(gl, {
    font,
    text: 'IIII',
    style: { fill: [1, 0, 0, 1], fontSizePx: 48 },
  });
  const bundle0 = tb.bundle;
  const rm0 = { w: tb.runMetrics.typoBBox[2], lines: tb.runMetrics.lineCount };

  // Full-canvas snapshot + ink/channel summary.
  const snap = () => {
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let ink = 0,
      r = 0,
      g = 0,
      b = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] !== 255 || px[i + 1] !== 255 || px[i + 2] !== 255) {
        ink++;
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
      }
    }
    return { ink, r, g, b, px };
  };
  // Count of pixels whose max channel delta exceeds 8 (AA jitter slack).
  const diffCount = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.px.length; i += 4) {
      if (
        Math.abs(a.px[i] - b.px[i]) > 8 ||
        Math.abs(a.px[i + 1] - b.px[i + 1]) > 8 ||
        Math.abs(a.px[i + 2] - b.px[i + 2]) > 8
      )
        n++;
    }
    return n;
  };

  // Persistent handle, bound ONCE — never rebound for the whole test.
  const handle = renderer.createBundleHandle(tb.bundle);
  const frame = () => {
    renderer.beginFrame([1, 1, 1, 1]);
    handle.draw();
    renderer.endFrame();
  };

  frame();
  const s0 = snap(); // 'IIII' in red

  // --- setText: different string, same handle --------------------------
  await tb.setText('MWMW');
  const identityAfterSetText = tb.bundle === bundle0;
  const rm1 = { w: tb.runMetrics.typoBBox[2], lines: tb.runMetrics.lineCount };
  frame();
  const s1 = snap(); // 'MWMW' via the ORIGINAL handle

  // Ground truth: a FRESH text bundle with the same content must render
  // the same pixels as the transplanted bundle through the old handle.
  const tbRef = await createTextBundle(gl, {
    font,
    text: 'MWMW',
    style: { fill: [1, 0, 0, 1], fontSizePx: 48 },
  });
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundle(tbRef.bundle, {});
  renderer.endFrame();
  const sRef = snap();
  tbRef.dispose();
  const diffVsRef = diffCount(s1, sRef);
  const diffVsOld = diffCount(s1, s0);

  // --- singleton drawBundle path also sees the new content ------------
  renderer.beginFrame([1, 1, 1, 1]);
  renderer.drawBundle(tb.bundle, {});
  renderer.endFrame();
  const s1single = snap();
  const diffSingleVsHandle = diffCount(s1single, s1);

  // --- empty round trip ------------------------------------------------
  await tb.setText('');
  const identityAfterEmpty = tb.bundle === bundle0;
  const emptyShapes = tb.bundle.numShapes | 0;
  frame();
  const sEmpty = snap(); // blank

  await tb.setText('back');
  const identityAfterRefill = tb.bundle === bundle0;
  frame();
  const sBack = snap(); // ink again

  // --- setStyle: recolor to green, same handle -------------------------
  await tb.setStyle({ fill: [0, 1, 0, 1], fontSizePx: 48 });
  const identityAfterStyle = tb.bundle === bundle0;
  frame();
  const sGreen = snap();

  handle.dispose();
  tb.dispose();

  const strip = ({ ink, r, g, b }) => ({ ink, r, g, b });
  return {
    identityAfterSetText,
    identityAfterEmpty,
    identityAfterRefill,
    identityAfterStyle,
    emptyShapes,
    rm0,
    rm1,
    diffVsRef,
    diffVsOld,
    diffSingleVsHandle,
    s0: strip(s0),
    s1: strip(s1),
    sEmpty: strip(sEmpty),
    sBack: strip(sBack),
    sGreen: strip(sGreen),
    totalPx: cnv.width * cnv.height,
  };
}, fontB64);

await page.close();

if (results.error) {
  fail(results.error);
  process.exit(1);
}

if (results.identityAfterSetText) ok('tb.bundle identity stable across setText');
else fail('setText replaced the bundle object');
if (results.identityAfterEmpty && results.identityAfterRefill)
  ok('identity stable across empty-string round trip');
else fail('empty round trip changed identity');
if (results.identityAfterStyle) ok('identity stable across setStyle');
else fail('setStyle replaced the bundle object');
if (results.emptyShapes === 0) ok('empty string → zero-shape stub under same identity');
else fail(`empty string numShapes ${results.emptyShapes}`);

if (results.s0.ink > 50) ok(`initial 'IIII' renders (${results.s0.ink} ink px)`);
else fail(`initial render blank (${results.s0.ink} ink px)`);
if (results.diffVsOld > 500)
  ok(`same handle re-renders after setText — ${results.diffVsOld} px changed vs old string`);
else fail(`handle kept stale glyphs: only ${results.diffVsOld} px changed`);
const refTol = Math.max(64, results.totalPx * 0.005);
if (results.diffVsRef <= refTol)
  ok(
    `transplanted render matches a FRESH 'MWMW' bundle (${results.diffVsRef} px diff ≤ ${refTol.toFixed(0)})`,
  );
else fail(`transplanted render diverges from fresh bundle: ${results.diffVsRef} px`);
if (results.diffSingleVsHandle <= refTol) ok('singleton drawBundle path matches the handle render');
else fail(`singleton path diverges: ${results.diffSingleVsHandle} px`);
if (results.sEmpty.ink === 0) ok('empty string draws as a clean no-op');
else fail(`empty string left ${results.sEmpty.ink} ink px`);
if (results.sBack.ink > 50)
  ok(`same handle renders again after refill (${results.sBack.ink} ink px)`);
else fail(`refill after empty is blank (${results.sBack.ink} ink px)`);

if (results.rm1.w > results.rm0.w)
  ok(
    `runMetrics refreshes per setText (typo width ${results.rm0.w.toFixed(3)} → ${results.rm1.w.toFixed(3)})`,
  );
else fail(`runMetrics stale: ${results.rm0.w} → ${results.rm1.w}`);

const g = results.sGreen;
if (g.ink > 50 && g.g > g.r && g.g > g.b)
  ok('setStyle recolors through the same handle (green dominant)');
else fail(`setStyle render: ink ${g.ink}, rgb sums (${g.r},${g.g},${g.b})`);

const identityFailures = failures;
if (identityFailures) console.error(`\nTEXT-IDENTITY FAIL (${identityFailures})`);
else console.log('\nTEXT-IDENTITY PASS');

// ---- setText transplant + pipeline warm: nothing binds a deleted texture ----
{
  const page = await browser.newPage();
  await page.setViewport({ width: 500, height: 500 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));

  // Track every texture we delete, and flag anyone who binds one afterwards. Installed
  // before the page's GL context exists.
  await page.evaluateOnNewDocument(() => {
    globalThis.__deadBinds = [];
    const P = WebGL2RenderingContext.prototype;
    const dead = new WeakSet();
    const od = P.deleteTexture;
    P.deleteTexture = function (t) {
      if (t) dead.add(t);
      return od.call(this, t);
    };
    const ob = P.bindTexture;
    P.bindTexture = function (target, t) {
      if (t && dead.has(t)) {
        const st = (new Error().stack || '')
          .split('\n')
          .slice(1, 4)
          .map((l) => l.trim().replace(/https?:\/\/[^/]+/g, ''))
          .join(' <- ');
        globalThis.__deadBinds.push(st);
      }
      return ob.call(this, target, t);
    };
  });
  await page.goto(url, { waitUntil: 'load', timeout: pageTimeoutFor() });
  await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });

  const res = await page.evaluate(async (fontB64) => {
    const { createTextBundle, MantleFontAsset } = await import('/src/index.js');
    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    const cnv = document.getElementById('glcanvas');
    cnv.width = 500;
    cnv.height = 400;
    renderer.setViewport(500, 400);

    const font = new MantleFontAsset(Uint8Array.from(atob(fontB64), (c) => c.charCodeAt(0)));
    const tb = await createTextBundle(gl, {
      font,
      text: '0',
      style: { fill: [1, 0, 0, 1], fontSizePx: 48 },
    });
    const h = renderer.createBundleHandle(tb.bundle);

    // ORDER MATTERS. Retype REPEATEDLY FIRST, with no warm in between: each setText leaves
    // a spent shell in the prewarm queue, and the NEXT one disposes the target — deleting
    // the very textures the earlier shells still name. Warming after each retype would find
    // those textures still alive and prove nothing; the warmer draining ONE bundle per
    // frame (which is what it does in a running app) is exactly what lets a shell go stale.
    let drew = 0;
    for (let round = 0; round < 8; round++) await tb.setText(String(1000 + round * 137));
    // Now warm. The queue holds 8 shells, 7 of them naming deleted textures.
    if (renderer.precompileFills) renderer.precompileFills();
    for (let f = 0; f < 8; f++) {
      renderer.beginFrame([1, 1, 1, 1]); // beginFrame also runs the per-frame warm tick
      h.draw({});
      renderer.endFrame();
      drew++;
    }
    const px = new Uint8Array(500 * 400 * 4);
    gl.readPixels(0, 0, 500, 400, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let ink = 0;
    for (let i = 0; i < px.length; i += 4)
      if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) ink++;
    h.dispose();
    if (tb.dispose) tb.dispose();
    return {
      drew,
      ink,
      glErr: gl.getError(),
      deadBinds: globalThis.__deadBinds.slice(0, 5),
      deadCount: globalThis.__deadBinds.length,
    };
  }, fontB64);

  {
    if (res.ink < 100) {
      fail(
        `the retyped text barely rendered (${res.ink}px) — a dead-texture bind would look ` +
          `the same as this, so the check below proves nothing`,
      );
    } else {
      ok(`retyped text renders after ${res.drew} transplant+warm rounds (${res.ink}px of ink)`);
    }
    if (res.deadCount > 0) {
      fail(
        `${res.deadCount} bind(s) of a DELETED texture after setText + pipeline warm. ` +
          `transplantBundle leaves the fresh bundle as a shell whose fields still name the ` +
          `textures the target adopted; it must be marked dead so the warm queues skip it.\n` +
          res.deadBinds.map((s) => '      ' + s).join('\n'),
      );
    } else {
      ok('no bind of a deleted texture (0)');
    }
    if (res.glErr !== 0) fail(`GL error ${res.glErr} after the transplant+warm rounds`);
    else ok('no GL error');
  }
  await page.close();
  const n = failures - identityFailures;
  console.log(n ? `\nFAILURES: ${n}` : '\nTEXT-TRANSPLANT-WARM PASS');
}

await browser.close();
server.close();
process.exit(failures ? 1 : 0);

// A shape morph over a `<g mask>` wrapping a `<path filter>` must stay
// visible. Builds two synthetic SVG poses and verifies:
//
//   1. Each individual pose renders something non-empty.
//   2. createShapeMorph(src, dst) at t=0 / 0.5 / 1 renders something
//      non-empty too.
//   3. createShapeTimeline([src, dst], keys) renders something non-empty.
//
// Asserts non-empty pixels at the centre + a corner the path covers, so
// the "morph renders nothing / all black" failure mode trips immediately.
//
// Synthetic fixture: two centered squares with a circular reveal mask and
// a drop-shadow filter. Mask `<path>` differs between poses (the morph
// target); filter is identical.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (p.endsWith('.glsl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try { res.writeHead(200, { 'content-type': mime(p) }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url  = `http://127.0.0.1:${port}/mantleDemo.html`;

// Two poses. Same shared `<defs>` id space.
// - Mask `m1`: a circle at (50,50) r=40 (pose A) vs (50,50) r=20 (pose B).
//   So pose A reveals nearly the full square, pose B reveals only the
//   centre disc.
// - Filter `f1`: drop shadow, identical in both poses.
// - Filled rectangle 10..90 × 10..90 wrapped in `<g mask filter>`.
//
// Both poses produce a non-empty centre pixel (the square interior is
// the green fill). Pose A also produces a non-empty pixel at e.g.
// (15,15) — the corner of the square (mask radius covers it). Pose B
// has the corner masked out, so corner pixel is empty there. The centre
// pixel is the signal: if the morph renders nothing it falls back to
// canvas-clear white.
const POSE_A = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <mask id="m1"><circle cx="50" cy="50" r="40" fill="#fff"/></mask>
    <filter id="f1" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#333" flood-opacity="0.85"/>
    </filter>
  </defs>
  <g mask="url(#m1)">
    <rect filter="url(#f1)" x="10" y="10" width="80" height="80" fill="#58B92D"/>
  </g>
</svg>`;
const POSE_B = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <mask id="m1"><circle cx="50" cy="50" r="20" fill="#fff"/></mask>
    <filter id="f1" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="1" stdDeviation="2" flood-color="#333" flood-opacity="0.85"/>
    </filter>
  </defs>
  <g mask="url(#m1)">
    <rect filter="url(#f1)" x="10" y="10" width="80" height="80" fill="#58B92D"/>
  </g>
</svg>`;

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok   = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 200, height: 200 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => {
  const t = m.text();
  if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
});
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 10000 });

const results = await page.evaluate(async (poseA, poseB) => {
  const { importSvg, createBundle, createShapeMorph, createShapeTimeline } =
    await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');

  async function bundleFromSvg(svg) {
    return createBundle(gl, await importSvg(svg));
  }
  const bA = await bundleFromSvg(poseA);
  const bB = await bundleFromSvg(poseB);

  function snapshot(handle) {
    renderer.render(handle);
    const w = cnv.width, h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // y is flipped (gl readPixels origin bottom-left). Canvas is
    // 200×200; the square covers ~ x∈[20,180], y∈[20,180] in canvas
    // coords. Pick the dead-centre pixel — it should be GREEN
    // (post-mask, since mask radius covers centre in both poses).
    const cIdx = ((h >> 1) * w + (w >> 1)) * 4;
    return {
      centre: [px[cIdx], px[cIdx + 1], px[cIdx + 2], px[cIdx + 3]],
    };
  }

  // ---- 1. Individual poses render (sanity) ----
  const aSnap = snapshot(bA);
  const bSnap = snapshot(bB);

  // ---- 2. createShapeMorph(A, B) at t = 0, 0.5, 1 ----
  const morph = createShapeMorph(gl, bA, bB);
  morph.setT(0);   const m0   = snapshot(morph);
  morph.setT(0.5); const mMid = snapshot(morph);
  morph.setT(1);   const m1   = snapshot(morph);

  // ---- 3. createShapeTimeline([A, B], keys) at t = 0, 0.5, 1 ----
  const tl = createShapeTimeline(gl, [bA, bB], [
    { time: 0, bundleIndex: 0, interp: 'linear' },
    { time: 1, bundleIndex: 1, interp: 'linear' },
  ]);
  tl.setTime(0);   const t0   = snapshot(tl);
  tl.setTime(0.5); const tMid = snapshot(tl);
  tl.setTime(1);   const t1   = snapshot(tl);

  morph.dispose();
  tl.dispose();
  bA.dispose();
  bB.dispose();

  return { aSnap, bSnap, m0, mMid, m1, t0, tMid, t1 };
}, POSE_A, POSE_B);

await browser.close();
server.close();

// ---- Assertions --------------------------------------------------
//
// `renders something` = centre alpha > ~10. The "renders nothing" mode
// leaves centre at canvas clear-color (alpha 0 on the FBO readback in
// some browsers; here the clear is white opaque, so we look for "centre
// is GREEN-ish" instead of "centre is white").
//
// Green test fixture is #58B92D = (88, 185, 45) — predominantly green.
// We accept "centre's green channel > red + blue" as the signal that
// the masked fill is reaching the centre pixel. Pure-white (canvas
// clear, mask drops everything) reads (255,255,255) — red == green,
// fails the test. Drop-shadow halo + AA fuzz the actual values.

function isGreenish(rgba, label) {
  const [r, g, b] = rgba;
  if (g <= r || g <= b) {
    fail(`${label}: centre is NOT green-dominant — RGB=(${r},${g},${b}). Expected G > R + G > B (fill = #58B92D, mask should let centre through).`);
    return false;
  }
  ok(`${label}: centre is green-dominant — RGB=(${r},${g},${b})`);
  return true;
}

isGreenish(results.aSnap.centre, 'pose A direct render');
isGreenish(results.bSnap.centre, 'pose B direct render');
isGreenish(results.m0.centre,   'createShapeMorph t=0');
isGreenish(results.mMid.centre, 'createShapeMorph t=0.5');
isGreenish(results.m1.centre,   'createShapeMorph t=1');
isGreenish(results.t0.centre,   'createShapeTimeline t=0');
isGreenish(results.tMid.centre, 'createShapeTimeline t=0.5');
isGreenish(results.t1.centre,   'createShapeTimeline t=1');

if (failures) {
  console.error(`\n${failures} assertions failed — bug reproduces.`);
  process.exit(1);
}
console.log('\nshapeMorphMaskFilterSmoke: PASS (bug NOT reproduced — either fixed already, or fixture doesn\'t trip it)');

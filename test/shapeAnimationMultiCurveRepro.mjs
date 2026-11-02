// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Shape-morph cover-quad coverage. Two SVGs sharing a multi-quad path (rounded
// card outline). Verifies that drawing the morph at t=0 produces the same
// pixels as drawing the src bundle directly, and that interior pixels (center
// + off-center samples inside the silhouette) are filled — no fragmentation
// gaps.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

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
  let p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
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
const port = server.address().port;
const url = `http://127.0.0.1:${port}/mantleDemo.html`;

// Card-flip pose pair: 14 quads + 2 lines, with intermediate poses where
// dst's control points can wander far from the card silhouette so the
// interpolated curves at arbitrary t look right — the kind of payload a
// shape-morph exporter produces.
const SRC_SVG = readFileSync(
  new URL('../examples/smoke/shapeAnimationMultiCurveRepro__SRC_SVG.svg', import.meta.url),
  'utf8',
);
const DST_SVG = readFileSync(
  new URL('../examples/smoke/shapeAnimationMultiCurveRepro__DST_SVG.svg', import.meta.url),
  'utf8',
);

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
await page.setViewport({ width: 400, height: 400 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
  timeout: 10000,
  polling: 100,
});

const results = await page.evaluate(
  async (srcSvg, dstSvg) => {
    const { importSvg, createBundle, createShapeMorph } = await import('/src/index.js');

    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    const cnv = document.getElementById('glcanvas');

    async function bundleFromSvg(svg) {
      return createBundle(gl, await importSvg(svg));
    }

    function snapshot(handle) {
      renderer.render(handle);
      const w = cnv.width,
        h = cnv.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return { w, h, data: px };
    }

    function pixelAt(snap, x, y) {
      const i = (y * snap.w + x) * 4;
      return [snap.data[i], snap.data[i + 1], snap.data[i + 2], snap.data[i + 3]];
    }

    // Count "filled" pixels — any pixel where R+G+B > 30 (avoids the
    // ~black background while accepting magenta lerp at t=0.5).
    function filledArea(snap) {
      let n = 0;
      for (let i = 0; i < snap.data.length; i += 4) {
        const sum = snap.data[i] + snap.data[i + 1] + snap.data[i + 2];
        if (sum > 30) n++;
      }
      return n;
    }

    // Per-pixel diff count between two snaps (ignores fully-black pixels
    // outside the canvas-rect intersection).
    function diffCount(a, b, tol = 4) {
      if (a.w !== b.w || a.h !== b.h) return -1;
      let n = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        if (Math.abs(a.data[i] - b.data[i]) > tol) {
          n++;
          continue;
        }
        if (Math.abs(a.data[i + 1] - b.data[i + 1]) > tol) {
          n++;
          continue;
        }
        if (Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) {
          n++;
          continue;
        }
      }
      return n;
    }

    const bSrc = await bundleFromSvg(srcSvg);
    const bDst = await bundleFromSvg(dstSvg);

    function pngOf(snap) {
      return cnv.toDataURL('image/png');
    }

    // Reference: draw src directly.
    const refSrc = snapshot(bSrc);
    const refSrcPng = cnv.toDataURL('image/png');
    const refSrcArea = filledArea(refSrc);

    const refDst = snapshot(bDst);
    const refDstPng = cnv.toDataURL('image/png');

    // Morph path at t=0 — should match refSrc.
    const morph = createShapeMorph(gl, bSrc, bDst);
    morph.setT(0);
    const morph0 = snapshot(morph);
    const morph0Png = cnv.toDataURL('image/png');
    const morph0Area = filledArea(morph0);

    morph.setT(1);
    const morph1 = snapshot(morph);
    const morph1Png = cnv.toDataURL('image/png');

    morph.setT(0.5);
    const morphMid = snapshot(morph);
    const morphMidPng = cnv.toDataURL('image/png');

    const refDiff = diffCount(refSrc, morph0);

    // Sample 9 points across the silhouette interior (the card outline
    // covers most of the 100×100 viewBox, ~90% of pixels).
    const w = morph0.w,
      h = morph0.h;
    const samples = [];
    for (const ys of [0.25, 0.5, 0.75]) {
      for (const xs of [0.25, 0.5, 0.75]) {
        const x = Math.floor(xs * w),
          y = Math.floor(ys * h);
        samples.push({
          x,
          y,
          refSrc: pixelAt(refSrc, x, y),
          morph0: pixelAt(morph0, x, y),
          morph1: pixelAt(morph1, x, y),
          morphMid: pixelAt(morphMid, x, y),
        });
      }
    }

    morph.dispose();
    bSrc.dispose();
    bDst.dispose();

    return {
      refSrcArea,
      morph0Area,
      morph1Area: filledArea(morph1),
      morphMidArea: filledArea(morphMid),
      refDiff,
      samples,
      centerSrc: pixelAt(refSrc, w >> 1, h >> 1),
      centerM0: pixelAt(morph0, w >> 1, h >> 1),
      centerM1: pixelAt(morph1, w >> 1, h >> 1),
      centerMid: pixelAt(morphMid, w >> 1, h >> 1),
      canvasW: w,
      canvasH: h,
      pngs: {
        refSrc: refSrcPng,
        refDst: refDstPng,
        morph0: morph0Png,
        morph1: morph1Png,
        morphMid: morphMidPng,
      },
    };
  },
  SRC_SVG,
  DST_SVG,
);

await browser.close();
server.close();

// Save PNGs for visual inspection.
import { mkdirSync, writeFileSync } from 'fs';
const OUT = path.join(__dirname, 'visuals', 'multi-curve-morph');
mkdirSync(OUT, { recursive: true });
for (const [name, dataUrl] of Object.entries(results.pngs)) {
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) continue;
  writeFileSync(
    path.join(OUT, `${name}.png`),
    Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'),
  );
}
console.log(`  PNGs saved to ${OUT}`);
delete results.pngs;

console.log(`  canvas = ${results.canvasW}x${results.canvasH}`);
console.log('  refSrc area =', results.refSrcArea);
console.log('  morph t=0 area =', results.morph0Area);
console.log('  morph t=0.5 area =', results.morphMidArea);
console.log('  morph t=1 area =', results.morph1Area);
console.log('  refSrc vs morph0 pixel diff =', results.refDiff);
console.log('  center src=', results.centerSrc);
console.log('  center m0 =', results.centerM0);
console.log('  center mid=', results.centerMid);
console.log('  center m1 =', results.centerM1);

// T1: morph at t=0 must have the same filled area as a direct
// drawBundle(src). Allow a tiny tolerance for AA differences.
{
  const delta = Math.abs(results.refSrcArea - results.morph0Area);
  const tolerance = Math.max(20, results.refSrcArea * 0.005);
  if (delta > tolerance) {
    fail(
      `T1 morph t=0 filled area (${results.morph0Area}) differs from refSrc (${results.refSrcArea}) by ${delta} > tolerance ${tolerance}`,
    );
  } else {
    ok(`T1 morph t=0 silhouette area matches refSrc (Δ=${delta})`);
  }
}
// T2: morph at t=0 should be near-pixel-identical to refSrc (small
// tolerance for FBO compositing differences).
{
  const tolerance = Math.max(200, results.refSrcArea * 0.02);
  if (results.refDiff > tolerance) {
    fail(`T2 morph t=0 differs from refSrc by ${results.refDiff} pixels > tolerance ${tolerance}`);
  } else {
    ok(`T2 morph t=0 vs refSrc pixel diff = ${results.refDiff} (≤ ${tolerance})`);
  }
}
// T3: morph at t=0 center is solid red.
{
  const [r, g, b] = results.centerM0;
  if (r < 200 || g > 30 || b > 30) fail(`T3 morph t=0 center should be red; got (${r},${g},${b})`);
  else ok(`T3 morph t=0 center = red (${r},${g},${b})`);
}
// T4: morph at t=1 center is solid blue.
{
  const [r, g, b] = results.centerM1;
  if (r > 30 || g > 30 || b < 200) fail(`T4 morph t=1 center should be blue; got (${r},${g},${b})`);
  else ok(`T4 morph t=1 center = blue (${r},${g},${b})`);
}
// T5: morph at t=0.5 center is magenta-ish.
{
  const [r, g, b] = results.centerMid;
  if (r < 60 || r > 195 || b < 60 || b > 195 || g > 30)
    fail(`T5 morph t=0.5 center should be magenta-ish; got (${r},${g},${b})`);
  else ok(`T5 morph t=0.5 center = magenta (${r},${g},${b})`);
}
// T6: per-sample interior pixels — each interior sample at t=0 should
// match refSrc within tolerance.
{
  let bad = 0;
  for (const s of results.samples) {
    const dr = Math.abs(s.refSrc[0] - s.morph0[0]);
    const dg = Math.abs(s.refSrc[1] - s.morph0[1]);
    const db = Math.abs(s.refSrc[2] - s.morph0[2]);
    if (dr > 4 || dg > 4 || db > 4) {
      bad++;
      console.log(`  diff at (${s.x},${s.y}): refSrc=${s.refSrc} morph0=${s.morph0}`);
    }
  }
  if (bad > 0) fail(`T6 ${bad}/${results.samples.length} interior samples differ at t=0`);
  else ok(`T6 all ${results.samples.length} interior samples match refSrc at t=0`);
}

console.log();
console.log(failures === 0 ? 'MULTI-CURVE MORPH PASS' : `MULTI-CURVE MORPH FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

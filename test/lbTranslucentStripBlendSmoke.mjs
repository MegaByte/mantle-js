// lbTranslucentStripBlendSmoke.mjs — a TRANSLUCENT curved shape must not blend
// over ITSELF along its curve bands.
//
// LB's curve strips (kinds 9/10) deliberately share the interior's depth tier and
// BLEND with it rather than claiming the pixel. That union is exact at α=1, where
// "band ∪ interior saturates" — OVER with an opaque colour is idempotent, so
// painting a pixel twice is harmless.
//
// At α<1 it is NOT. The union blends the shape OVER ITSELF: α=0.6 twice reads
// 0.84, three times 0.94, and along a curve band it drives to fully opaque. A
// translucent curved shape then renders its edges far too solid and swallows
// whatever sits behind it. Real-world symptom (Highway Hazards' parallax hills:
// stacked ridges, the front one at fill-opacity 0.6): a band along every ridge
// painted the front hill at coverage 1.00 where the truth is 0.60, eating the thin
// visible sliver of the ridge behind it — which reads as "the curve fill is
// missing" and as "the AA is too dark".
//
// Assertions:
//   1. The bundle actually routes to LB (else this proves nothing).
//   2. LB matches Slug across the whole canvas.
//   3. The translucent shape's coverage over the shape behind it is the TRUE α,
//      not the self-blended 1-(1-α)^n. This is the assertion that fails loudly on
//      a regression: the band saturates instead of ramping.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { emitFixture } from './_fixtures.mjs';

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
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

// Back: OPAQUE pure-green ridge. Front: the SAME ridge dropped 30em, PURE BLUE at
// fill-opacity 0.6 — chained quads, so it carries curve strips. Pure primaries keep
// the arithmetic unambiguous: over green, the blue channel IS the front's coverage.
const ALPHA = 0.6;
// A ridge of 17 chained NEAR-FLAT quads (control deviation ~0.55% of chord) — this
// is the geometry that actually carries curve strips, and a 2-quad ridge does NOT
// reproduce the bug. Back: OPAQUE green. Front: the same ridge dropped 30em, PURE
// BLUE at fill-opacity 0.6. Pure primaries keep the arithmetic unambiguous — over
// green, the blue channel IS the front shape's coverage.
const BACK  = "M0.000,200.000 Q37.492,198.853 75.000,198.530 Q112.492,197.408 150.000,197.110 Q187.493,196.037 225.000,195.789 Q262.494,194.787 300.000,194.610 Q337.495,193.701 375.000,193.616 Q412.496,192.815 450.000,192.839 Q487.497,192.160 525.000,192.305 Q562.499,191.757 600.000,192.034 Q637.500,191.622 675.000,192.034 Q712.501,191.757 750.000,192.305 Q787.503,192.160 825.000,192.839 Q862.504,192.815 900.000,193.616 Q937.505,193.701 975.000,194.610 Q1012.506,194.787 1050.000,195.789 Q1087.507,196.037 1125.000,197.110 Q1162.508,197.408 1200.000,198.530 Q1237.508,198.853 1275.000,200.000 L1275.000,400 L0,400 Z";
const FRONT = "M0.000,230.000 Q37.492,228.853 75.000,228.530 Q112.492,227.408 150.000,227.110 Q187.493,226.037 225.000,225.789 Q262.494,224.787 300.000,224.610 Q337.495,223.701 375.000,223.616 Q412.496,222.815 450.000,222.839 Q487.497,222.160 525.000,222.305 Q562.499,221.757 600.000,222.034 Q637.500,221.622 675.000,222.034 Q712.501,221.757 750.000,222.305 Q787.503,222.160 825.000,222.839 Q862.504,222.815 900.000,223.616 Q937.505,223.701 975.000,224.610 Q1012.506,224.787 1050.000,225.789 Q1087.507,226.037 1125.000,227.110 Q1162.508,227.408 1200.000,228.530 Q1237.508,228.853 1275.000,230.000 L1275.000,400 L0,400 Z";
const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1275 400">
  <path d="${BACK}" fill="#00ff00"/>
  <path d="${FRONT}" fill="#0000ff" fill-opacity="${ALPHA}"/>
</svg>`;
emitFixture('lbTranslucentStripBlend__SVG', SVG);

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok   = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 850, height: 400 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 20000 });

const results = await page.evaluate(async (svg, alpha) => {
  const { importSvg, createBundle } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  const W = 1700, H = 800;
  cnv.width = W; cnv.height = H;
  const shot = () => {
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const asset = await importSvg(svg);

  renderer.setLoopBlinnFill('off');
  const bS = createBundle(gl, asset);
  const hS = renderer.createBundleHandle(bS);
  renderer.beginFrame([1, 1, 1, 1]); hS.draw(); renderer.endFrame();
  const slug = shot();

  renderer.setLoopBlinnFill('on');
  const bL = createBundle(gl, asset);
  const hL = renderer.createBundleHandle(bL);
  await renderer.awaitLbReady(bL);
  renderer.beginFrame([1, 1, 1, 1]); hL.draw(); renderer.endFrame();
  const lb = shot();
  const lbRouted = Array.isArray(bL._lbMeshes) && bL._lbMeshes.length > 0;

  let diff = 0;
  for (let i = 0; i < slug.length; i += 4) {
    const d = Math.max(
      Math.abs(slug[i] - lb[i]), Math.abs(slug[i + 1] - lb[i + 1]), Math.abs(slug[i + 2] - lb[i + 2]),
    );
    if (d > 16) diff++;
  }

  // Coverage of the FRONT (blue, translucent) shape where it lies OVER the back
  // (green) shape: on pure primaries the blue channel is exactly that coverage.
  // Sample well inside the overlap AND right along the front ridge's curve band,
  // which is where the self-blend showed up.
  const covAt = (px, x, y) => { const i = (((H - 1 - y) * W + x) * 4); return px[i + 2] / 255; };
  const worstOver = { cov: 0, x: -1, y: -1 };
  for (let x = 40; x < W - 40; x += 3) {
    for (let y = 300; y < 560; y++) {
      // only where the BACK shape is present in Slug (so we're over green, not white)
      const i = (((H - 1 - y) * W + x) * 4);
      if (slug[i + 1] < 40 && slug[i + 2] < 40) continue;   // not the green/blue composite
      if (slug[i] > 200) continue;                          // white bg
      const c = covAt(lb, x, y);
      if (c > worstOver.cov) { worstOver.cov = c; worstOver.x = x; worstOver.y = y; }
    }
  }
  hS.dispose(); hL.dispose(); bS.dispose(); bL.dispose();
  return { lbRouted, diff, total: W * H, worstOver, alpha };
}, SVG, ALPHA);

const { lbRouted, diff, total, worstOver, alpha } = results;
console.log(`  lbRouted=${lbRouted} diff=${diff}/${total}px  max front-coverage over the back shape=${worstOver.cov.toFixed(2)} (true α=${alpha})`);

if (!lbRouted) fail('bundle did NOT route to LB — this smoke is not exercising the LB path');
else ok('bundle routes to LB');

// LB and Slug will never be pixel-identical at an edge, and since the exact-edge refinement
// became opt-in (renderer opt `exactEdgeAa`) they differ by a few more LSBs there: LB always
// computes an exact half-plane area, Slug now blends two ray coverages. This bound is a sanity
// check that the two engines agree on the PICTURE — the strip double-blend it guards against is a
// whole-shape effect worth tens of thousands of pixels, not hundreds. (The real assertion is the
// one below: a translucent shape must take exactly ONE OVER.)
if (diff > 2000) fail(`LB differs from Slug on ${diff}px`);
else ok(`LB matches Slug (${diff}px differ, of ${total})`);

// Self-blending drives coverage to 1-(1-α)^n: 0.84 at two overlaps, →1.0 along a
// band. Allow a little AA headroom over α, but nowhere near the 0.84 second blend.
const CEIL = alpha + 0.12;
if (worstOver.cov > CEIL) {
  fail(`the translucent shape blended over ITSELF: coverage ${worstOver.cov.toFixed(2)} at `
     + `(${worstOver.x},${worstOver.y}) exceeds α=${alpha} (1-(1-α)² would be `
     + `${(1 - (1 - alpha) ** 2).toFixed(2)}) — curve strips are co-covering the interior`);
} else {
  ok(`translucent shape takes exactly ONE OVER (max coverage ${worstOver.cov.toFixed(2)} ≤ ${CEIL.toFixed(2)})`);
}

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nPASS');
process.exit(failures ? 1 : 0);

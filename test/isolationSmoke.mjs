// isolationSmoke.mjs — Verify that <g isolation="isolate"> routes its
// children through a private offscreen FBO so blend modes among the
// children stay LOCAL to the group, not blending with the parent
// backdrop. Also asserts the parent backdrop OUTSIDE the group is
// preserved after groupEnd composes.
//
// Test setup: a blue background rect, then a group containing a red
// rect and a lime rect with `mix-blend-mode: multiply`. The overlap
// region (where red and lime meet) shows the blend.
//
// WITHOUT isolation: lime's multiply blends against the EVERYTHING
// behind (blue bg + red rect). Lime × blue = black at the
// lime-only zone (no overlap with red). The right half of the
// inner rectangle (lime-only over blue) is BLACK.
//
// WITH isolation: lime's multiply blends only inside the group
// (so against red where they overlap, against transparent elsewhere).
// The lime-only zone over blue keeps its full lime color: blue
// becomes the backdrop only after the group composites. So the
// right half is LIME, not BLACK.
//
// Predicate: the green channel in the right half (lime-only area)
// should be MUCH stronger with isolation than without.

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT  = path.join(__dirname, 'visuals', 'isolation');
mkdirSync(OUT, { recursive: true });

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.glsl')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try { res.writeHead(200, { 'content-type': mime(p) }); res.end(readFileSync(path.join(ROOT, p))); }
  catch (e) { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});

async function renderAndSample(svgUrl) {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400 });
  await page.goto(`http://127.0.0.1:${port}/mantleDemo.html?svg=/${encodeURIComponent(svgUrl)}`, { waitUntil: 'load', timeout: 10000 });
  await page.waitForFunction(() => {
    const st = document.getElementById('status');
    return st && !/Fetching|Converting/.test(st.textContent);
  }, { timeout: 8000 });
  const stats = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    const gl = window.__mantleGl, renderer = window.__mantleRenderer;
    if (!gl || !renderer) return null;
    renderer.render();
    const w = cnv.width, h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // The lime-only zone sits in the right half of the inner group
    // rectangle. With the demo's default canvas aspect-ratio fit
    // (xMidYMid meet), the SVG viewBox 0..300 maps to roughly x=0..800
    // when h=400. The inner rect goes from 50..200 in SVG, so the
    // lime-only zone (150..200 in SVG x) sits at roughly canvas x in
    // the right portion of the inner rect. Sample a 40×40 window at
    // canvas (520..560, 200..240) — covers the lime-only zone.
    let sumG = 0, sumR = 0, sumB = 0, count = 0;
    const x0 = Math.floor(w * 0.62), x1 = Math.floor(w * 0.72);
    const y0 = Math.floor(h * 0.45), y1 = Math.floor(h * 0.55);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * w + x) * 4;
        sumR += px[idx]; sumG += px[idx + 1]; sumB += px[idx + 2];
        count++;
      }
    }
    // Sample the backdrop OUTSIDE the group (top-left corner inside the
    // SVG viewBox, well clear of the inner rect at x=50..200, y=50..150
    // in SVG coords). The blue rect covers the full viewBox, so this
    // sample should be PURE BLUE if groupEnd correctly preserves the
    // backdrop. (0,0) lands outside the aspect-fit viewBox; sample at
    // (10% w, 30% h) which maps inside the viewBox at upper-left.
    const bx = Math.floor(w * 0.05), by = Math.floor(h * 0.35);
    const idxBackdrop = (by * w + bx) * 4;
    return {
      w, h,
      avgR: count ? sumR / count : 0,
      avgG: count ? sumG / count : 0,
      avgB: count ? sumB / count : 0,
      backdropR: px[idxBackdrop + 0],
      backdropG: px[idxBackdrop + 1],
      backdropB: px[idxBackdrop + 2],
      backdropA: px[idxBackdrop + 3],
    };
  });
  const dataUrl = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    const renderer = window.__mantleRenderer;
    if (!cnv || !renderer) return null;
    renderer.render();
    return cnv.toDataURL('image/png');
  });
  await page.close();
  return { stats, dataUrl };
}

let failures = 0;
function fail(msg) { failures++; console.error('FAIL:', msg); }

const iso = await renderAndSample('examples/_isolation.svg');
const noiso = await renderAndSample('examples/_no_isolation.svg');

if (iso.dataUrl) writeFileSync(path.join(OUT, 'isolation.png'),
  Buffer.from(iso.dataUrl.slice('data:image/png;base64,'.length), 'base64'));
if (noiso.dataUrl) writeFileSync(path.join(OUT, 'no_isolation.png'),
  Buffer.from(noiso.dataUrl.slice('data:image/png;base64,'.length), 'base64'));

console.log(`  isolation:    inside-lime R=${iso.stats.avgR.toFixed(1)} G=${iso.stats.avgG.toFixed(1)} B=${iso.stats.avgB.toFixed(1)}  |  backdrop=(${iso.stats.backdropR},${iso.stats.backdropG},${iso.stats.backdropB},${iso.stats.backdropA})`);
console.log(`  no-isolation: inside-lime R=${noiso.stats.avgR.toFixed(1)} G=${noiso.stats.avgG.toFixed(1)} B=${noiso.stats.avgB.toFixed(1)}  |  backdrop=(${noiso.stats.backdropR},${noiso.stats.backdropG},${noiso.stats.backdropB},${noiso.stats.backdropA})`);

// T1: WITH isolation, the lime-only zone over blue should retain
// strong green signal (lime is rgb(0, 255, 0)). The group composites
// after multiply-among-siblings, so the local lime-on-transparent stays
// lime, then over blue → lime.
// Use 100 as the threshold — the sample window straddles the AA boundary
// at the inner rect's right edge, so the lime channel averages around
// 118 with full lime (255) at the interior pixels and partial coverage
// at the edges. 100 is comfortably above the "blue backdrop bleeding
// through" case (which averages 0).
if (iso.stats.avgG > 100) {
  console.log(`ok T1 isolation: lime-only zone is bright green (avgG=${iso.stats.avgG.toFixed(1)}, isolated multiply)`);
} else {
  fail(`T1 isolation: lime-only avgG=${iso.stats.avgG.toFixed(1)} too low (expected > 100)`);
}

// T2: Sanity check on no-isolation. WITHOUT isolation, lime multiplies
// directly with whatever's behind. In the lime-only zone (right of red),
// lime multiplies with the blue backdrop:
//   (0/255, 255/255, 0/255) × (0/255, 0/255, 255/255) = (0, 0, 0) → BLACK.
// So avgG SHOULD be low (well under 100).
if (noiso.stats.avgG < 100) {
  console.log('ok T2 no-isolation: lime-only zone darkened by multiply with blue bg');
} else {
  fail(`T2 no-isolation: lime-only avgG=${noiso.stats.avgG.toFixed(1)} too high (expected < 100; isolation FBO may already be applying when it shouldn't)`);
}

// T3: The two cases must differ meaningfully.
const dG = iso.stats.avgG - noiso.stats.avgG;
if (dG > 100) {
  console.log(`ok T3 isolation vs no-isolation: ΔG = ${dG.toFixed(1)} (isolation lifts green)`);
} else {
  fail(`T3 ΔG too small: ${dG.toFixed(1)}`);
}

// T4: backdrop preservation — outside the group, the blue rect must
// still be visible. After groupEnd composes the group onto the canvas,
// the captured mainCopyTex (blue) should source-over for pixels where
// the group has no coverage. Demand opaque blue at the corner sample.
if (iso.stats.backdropB > 200 && iso.stats.backdropA > 200 &&
    iso.stats.backdropR < 50 && iso.stats.backdropG < 50) {
  console.log(`ok T4 backdrop preserved outside group: (${iso.stats.backdropR},${iso.stats.backdropG},${iso.stats.backdropB},${iso.stats.backdropA})`);
} else {
  fail(`T4 backdrop not preserved: got (${iso.stats.backdropR},${iso.stats.backdropG},${iso.stats.backdropB},${iso.stats.backdropA}) expected ~(0,0,255,255)`);
}

await browser.close();
server.close();
console.log();
console.log(failures === 0 ? 'ISOLATION PASS' : `ISOLATION FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacBandSeamSmoke — guards the encoder's switch from control-hull to CURVE-TIGHT
// segment bboxes for band binning (svg/textures.js).
//
// Why this can bite: a segment is binned into every H band its y-range overlaps.
// Slug's H-walker only needs segments that cross the ray at exactly c.y, so tight
// binning is precisely correct for it. AAC integrates over the whole 1px cell
// [c.y-0.5px, c.y+0.5px], so it needs any segment that GRAZES the cell — and a
// segment lying just across a band boundary, within half a pixel of the cell, is
// not binned into the band the fragment reads unless the encoder pads for it. Dropping a segment breaks
// the winding fold by ~1, which is a blown pixel, not a sub-pixel AA wobble.
//
// (A control hull gives this margin only by accident, and never for LINE
// segments at all — for a line the hull IS the tight bbox. So the exposure
// exists with hull binning too; tight binning widens it.)
//
// Stress: a 512-segment wavy closed blob → bandsY saturates at 32. Rendered at
// 160px, band height ≈ 5px, so a large fraction of fragment rows sit within half
// a pixel of a boundary. Asserts (a) interior stays solid (winding intact),
// (b) AAC never diverges from Slug by more than edge-AA amounts, and critically
// (c) NO pixel differs by a large amount — a dropped segment shows up as a
// near-full-scale channel delta, not as a few /255.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 160,
  cx = 80,
  cy = 80;

// 512-cubic wavy annulus-free blob. Bulgy control points (the hull/tight gap)
// and small per-segment y-extents (so band membership is decided finely).
function wavy(K, R, amp, lobes) {
  const P = (i) => {
    const a = (i / K) * 2 * Math.PI;
    const r = R + amp * Math.sin(lobes * a);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  let d = '';
  for (let i = 0; i < K; i++) {
    const A = P(i),
      B = P(i + 1);
    // bulge the control points well off the chord: hull >> tight bbox
    const bx = (B[1] - A[1]) * 0.55,
      by = -(B[0] - A[0]) * 0.55;
    const c1 = [A[0] + (B[0] - A[0]) / 3 + bx, A[1] + (B[1] - A[1]) / 3 + by];
    const c2 = [A[0] + (2 * (B[0] - A[0])) / 3 - bx, A[1] + (2 * (B[1] - A[1])) / 3 - by];
    if (i === 0) d += `M ${A[0].toFixed(3)} ${A[1].toFixed(3)} `;
    d += `C ${c1[0].toFixed(3)} ${c1[1].toFixed(3)} ${c2[0].toFixed(3)} ${c2[1].toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d + 'Z';
}
// a straight-edge counterpart: lines have hull == tight, so they isolate the
// band-boundary question from the hull-shrink question entirely.
function gear(K, R, amp, lobes) {
  let d = '';
  for (let i = 0; i < K; i++) {
    const a = (i / K) * 2 * Math.PI,
      r = R + amp * Math.sin(lobes * a);
    const p = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    d += (i ? 'L ' : 'M ') + `${p[0].toFixed(3)} ${p[1].toFixed(3)} `;
  }
  return d + 'Z';
}

const SHAPES = { 'wavy-512-cubic': wavy(512, 62, 8, 17), 'gear-512-line': gear(512, 62, 8, 17) };
const SVGS = Object.fromEntries(
  Object.entries(SHAPES).map(([k, d]) => [
    k,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#3366cc" d="${d}"/></svg>`,
  ]),
);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const SVGS = ${JSON.stringify(SVGS)};
async function render(svg, aac){
  const sec = await importSvg(svg);
  const r = createRenderer(gl, shaders, aac ? { aacFill: true } : {});
  r.setViewport(${N},${N}); r.setLoopBlinnFill('off');
  const b = createBundle(gl, sec);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);
  b.dispose();
  return Array.from(px);
}
const out = {};
try { for (const k of Object.keys(SVGS)) out[k] = { slug: await render(SVGS[k], false), aac: await render(SVGS[k], true) }; }
catch(e){ out.err = String(e); }
window.__out = out;
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
const browser = await launchBrowser({
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
let out;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  out = await page.evaluate(() => window.__out);
} catch (e) {
  console.error('setup failed:', e.message);
  await browser.close();
  server.close();
  process.exit(1);
}
await browser.close();
server.close();

let fail = 0;
const ok = (m) => console.log('ok', m);
const bad = (m) => {
  fail++;
  console.error('FAIL', m);
};
if (out.err) {
  bad('render threw: ' + out.err);
} else
  for (const k of Object.keys(SHAPES)) {
    const S = out[k].slug,
      A = out[k].aac;
    console.log(`\n[${k}]`);
    let inkA = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (A[i] !== 255 || A[i + 1] !== 255 || A[i + 2] !== 255) inkA++;
    }
    inkA > 3000
      ? ok(`AAC renders (${inkA} non-white px)`)
      : bad(`AAC barely rendered (${inkA} px)`);

    // interior disc (r < 44) must be solid in both — a dropped segment punches a
    // hole or a wedge here, because the winding fold lands on the wrong integer.
    let solidBad = 0,
      solidBadSlug = 0,
      interiorN = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > 44 * 44) continue;
        const j = (y * N + x) * 4;
        interiorN++;
        if (A[j] !== 51 || A[j + 1] !== 102 || A[j + 2] !== 204) solidBad++;
        if (S[j] !== 51 || S[j + 1] !== 102 || S[j + 2] !== 204) solidBadSlug++;
      }
    // Slug is the control: if IT is also unsolid, the shape itself isn't solid
    // there and the test shape is at fault, not the band binning.
    if (solidBadSlug)
      console.log(
        `   (control: Slug also unsolid on ${solidBadSlug}/${interiorN} — shape, not banding)`,
      );
    solidBad === 0
      ? ok(`interior disc (${interiorN}px) solid in AAC — winding intact`)
      : bad(`${solidBad}/${interiorN} interior px not solid in AAC (Slug: ${solidBadSlug})`);

    // whole image: edge AA may differ a little; a dropped segment cannot hide here
    let sum = 0,
      mx = 0,
      big = 0;
    for (let i = 0; i < S.length; i++) {
      const dd = Math.abs(S[i] - A[i]);
      sum += dd;
      mx = Math.max(mx, dd);
      if (dd > 64) big++;
    }
    const mean = sum / S.length;
    ok(`mean diff ${mean.toFixed(3)}/255, max ${mx}, ${big} channels differ by >64`);
    mean < 2.0 ? ok('mean < 2/255') : bad(`mean diff too large: ${mean.toFixed(2)}`);
    // a band-seam drop shows as a full-scale delta on a run of pixels, not as AA
    big === 0
      ? ok('no channel differs by >64 (no band-seam dropout)')
      : bad(`${big} channels differ by >64 — band-seam dropout`);
  }
console.log(fail ? `\nAAC-BAND-SEAM FAIL (${fail})` : `\nAAC-BAND-SEAM PASS`);
process.exit(fail ? 1 : 0);

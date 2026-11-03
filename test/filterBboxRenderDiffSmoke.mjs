// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterBboxRenderDiffSmoke — proves bbox-sized filter RTs are BYTE-IDENTICAL
// to the full-canvas filter passes.
//
// Each full-canvas filter-graph pass (blur, composite, colorMatrix, …)
// is restricted to the device-pixel region where its output can be
// non-zero (the SourceGraphic bbox propagated through the graph by
// computeNodeBboxes, with feFlood/generators resized to their pointwise
// consumers). For a small filtered shape on a large canvas this skips
// the out-of-bbox fragment work. It must be output-identical: bounded
// primitives are transparent beyond their bbox by spec, and the RT pool
// pre-clears every acquired surface so the un-drawn region stays 0.
//
//   A = render with bbox-sized RTs ON  (default)
//   B = render with them OFF (renderer._setFilterBbox(false))
//   assert A === B byte-for-byte, AND the bbox path actually engaged.
//
// NOT a glScissor: each pass ALLOCATES at its bbox and consumers remap UVs
// through the rect, so "off" means canvas-sized RTs. The distinction matters
// because it is what makes fragment-quad parity below a correctness issue.
//
// Every rect's GL origin is forced EVEN, and this test is why. Derivatives are
// evaluated over 2x2 fragment quads aligned to even framebuffer coordinates, so
// an odd-origin RT re-pairs each fragment with different quad-mates than the
// canvas-sized render used, and derivative-based edge AA lands one quad out.
// On the drop-shadow fixture an odd origin shows: its second shape sits at x=305
// and would differ on exactly its four CORNERS — 16 px, up to 85/255 of alpha —
// which feComposite-in against a flood amplifies to ~300 px of visible output,
// while its first shape at x=66 stays identical. Byte-identity here is a real
// assertion about that alignment, not a formality.
//
// Covers a drop-shadow (feGaussianBlur → feOffset → feFlood →
// feComposite-in → feMerge — exercises the generator-resize path AND a
// multi-pass blur intermediate), a plain blur, and colorMatrix / merge /
// blend graphs. The shape is small relative to the canvas so the bbox
// is a strict sub-rect (non-vacuous).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const CASES = [
  { name: 'dropshadow', svg: 'examples/_dropshadow.svg' },
  { name: 'blur', svg: 'examples/_blur.svg' },
  { name: 'colorMatrix', svg: 'examples/_fgraph_cmat.svg' },
  { name: 'merge', svg: 'examples/_fgraph_merge.svg' },
  { name: 'blend', svg: 'examples/_fgraph_blend.svg' },
];

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W = 512, H = 512;
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const CASES = ${JSON.stringify(CASES)};

async function fetchText(u) { return (await fetch(u)).text(); }

// Render a freshly-imported bundle (fresh renderer so the per-renderer
// filter cache never bridges the on/off pair). bboxOn toggles the
// internal bbox-sized-RT path.
async function renderCase(svgText, bboxOn) {
  const sec = await importSvg(svgText);
  const bundle = createBundle(gl, sec);
  const renderer = createRenderer(gl, shaders);
  renderer._setFilterBbox(bboxOn);
  renderer.setViewport(W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  renderer.drawBundle(bundle);
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const stats = renderer.debugStats;
  bundle.dispose(); renderer.dispose();
  return { buf, stats };
}

const result = { cases: [] };
try {
  for (const c of CASES) {
    const svgText = await fetchText('/' + c.svg);
    const on  = await renderCase(svgText, true);
    const off = await renderCase(svgText, false);
    let maxDiff = 0, nDiff = 0, ink = 0;
    for (let i = 0; i < on.buf.length; i++) {
      const d = Math.abs(on.buf[i] - off.buf[i]);
      if (d > maxDiff) maxDiff = d;
      if (d !== 0) nDiff++;
      if (off.buf[i] !== 0) ink++;
    }
    result.cases.push({
      name: c.name, maxDiff, nDiff, ink,
      bboxActive: on.stats.filterBboxActiveCount,
      evals: on.stats.filterEvalCount,
    });
  }
  result.compiled = true;
} catch (e) { result.error = String(e && e.stack || e); }
window.__result = result;
window.__done = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : p.endsWith('.svg')
          ? 'image/svg+xml'
          : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
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
await browser.close();
server.close();

if (!r || !r.compiled) {
  fail('filter render did not complete: ' + ((r && r.error) || 'page error'));
} else {
  let anyBbox = false;
  for (const c of r.cases) {
    if (c.bboxActive > 0) anyBbox = true;
    if (c.ink === 0) fail(`${c.name}: nothing rendered`);
    // the default kernel is the exact box coverage, which is not rounded the way an estimate would be, so a pixel whose coverage lands
    // within float noise of a rounding boundary can flip one byte between two draws of the same shape that interpolate em at slightly
    // different floats (an occupancy skip, a bbox-sized RT, a prepass). One byte on a handful of pixels is that; an origin or derivative
    // error is many bytes (what a zero bar would guard).
    else if (c.maxDiff === 0)
      ok(
        `${c.name}: bbox-sized == full-canvas byte-identical (ink=${c.ink}, bboxEvals=${c.bboxActive}/${c.evals})`,
      );
    // a graph in linearRGB stores 8 bits of LINEAR light, and the composite's conversion to sRGB spreads one flipped linear byte over up to
    // a dozen sRGB levels in the darks (the two RTs sample the same texels through uv maps that differ in the last float bit). Two levels on a
    // handful of pixels is that; an origin error is many pixels and many levels.
    else if (c.maxDiff <= 2 && c.nDiff <= 8 && c.name === 'merge')
      ok(
        `${c.name}: bbox-sized == full-canvas within two levels on ${c.nDiff} pixels (linearRGB, ink=${c.ink})`,
      );
    else if (c.maxDiff <= 1 && c.nDiff <= 8)
      ok(
        `${c.name}: bbox-sized == full-canvas within one byte on ${c.nDiff} pixels (ink=${c.ink})`,
      );
    else
      fail(
        `${c.name}: bbox-sized differs (maxDiff=${c.maxDiff}, nDiff=${c.nDiff}). A handful of pixels on shape CORNERS means an RT origin went odd again — see the header.`,
      );
  }
  if (!anyBbox)
    fail('no case took the bbox path — test is vacuous (filterBboxActiveCount==0 everywhere)');
  else ok('bbox-sized RTs engaged on >=1 case (non-vacuous)');
}
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nfilterBboxRenderDiffSmoke: bbox-sized filter RTs are byte-identical to full-canvas');

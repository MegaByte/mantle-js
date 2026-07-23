// bundleHandleDimensionsSmoke.mjs — regression test for cross-handle
// aspect-ratio bleed in one frame.
//
// Mechanism: beginFillPass caches `(cw, ch) === fillPassCanvasW/H` to
// gate the `arScale(globalBBox, cw, ch)` recompute. The cache key
// is canvas-size only, not bundle-aware. With multiple handles
// in one frame, handle B would inherit handle A's arScale result if
// the canvas size hasn't changed — even though A and B have
// different globalBBox (different aspect ratios → different
// (sx, sy) scale).
//
// This smoke uses two bundles with deliberately different aspect
// ratios:
//   - Tall: viewBox 0 0 50 100 (taller than wide)
//   - Wide: viewBox 0 0 100 50 (wider than tall)
// Each draws a filled rectangle covering its viewBox. On a square
// canvas, the renderer aspect-fits the asset:
//   - Tall asset: fills vertical extent, leaves horizontal margins
//   - Wide asset: fills horizontal extent, leaves vertical margins
//
// Assertion: after both render via handles in any order, the
// last-rendered handle's footprint should match its OWN aspect
// (not inherit the previous handle's arScale).

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

// 2:1 aspect ratios, opposite orientations. The fills are
// distinct colors so we can identify which one's pixels we're
// reading. On a square canvas:
//   Tall (50×100, red):   bbox at canvas centre x ∈ [w/4, 3w/4], y ∈ [0, h]
//   Wide (100×50, blue):  bbox at canvas centre x ∈ [0, w], y ∈ [h/4, 3h/4]
const SVG_TALL = readFileSync(new URL('../examples/smoke/bundleHandleDimensions__SVG_TALL.svg', import.meta.url), 'utf8');
const SVG_WIDE = readFileSync(new URL('../examples/smoke/bundleHandleDimensions__SVG_WIDE.svg', import.meta.url), 'utf8');

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

const results = await page.evaluate(async (svgTall, svgWide) => {
  const { importSvg, createBundle } =
    await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');

  const bTall = createBundle(gl, await importSvg(svgTall));
  const bWide = createBundle(gl, await importSvg(svgWide));
  const hTall = renderer.createBundleHandle(bTall);
  const hWide = renderer.createBundleHandle(bWide);

  function snapshot() {
    const w = cnv.width, h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { w, h, px };
  }

  // Probe pixels in the corners + along the major axis to fingerprint
  // the actual footprint.
  function probe(snap, color) {
    const { w, h, px } = snap;
    // Color matches (within tolerance) on premult RGBA8.
    function near(idx) {
      return Math.abs(px[idx]   - color[0]) <= 32 &&
             Math.abs(px[idx+1] - color[1]) <= 32 &&
             Math.abs(px[idx+2] - color[2]) <= 32 &&
             px[idx+3] > 200;  // mostly opaque
    }
    // Sample at deciles along the centre column AND centre row.
    const colFilled = [];
    const rowFilled = [];
    for (let i = 0; i < 10; i++) {
      const y = Math.floor((i + 0.5) * h / 10);
      const x = Math.floor((i + 0.5) * w / 10);
      colFilled.push(near(((y * w) + (w >> 1)) * 4));   // centre column
      rowFilled.push(near((((h >> 1) * w) + x) * 4));   // centre row
    }
    return { colFilled, rowFilled };
  }

  // ---- Single-handle baseline: render each alone, capture footprint ----
  renderer.beginFrame([1, 1, 1, 1]);
  hTall.draw();
  renderer.endFrame();
  const tallAlone = probe(snapshot(), [255, 0, 0]);

  renderer.beginFrame([1, 1, 1, 1]);
  hWide.draw();
  renderer.endFrame();
  const wideAlone = probe(snapshot(), [0, 0, 255]);

  // ---- Multi-handle: render tall then wide; check that wide's
  // footprint matches its OWN aspect, not tall's ----
  renderer.beginFrame([1, 1, 1, 1]);
  hTall.draw();
  hWide.draw();
  renderer.endFrame();
  const wideAfterTall = probe(snapshot(), [0, 0, 255]);

  // ---- Reverse: render wide then tall; check tall's footprint ----
  renderer.beginFrame([1, 1, 1, 1]);
  hWide.draw();
  hTall.draw();
  renderer.endFrame();
  const tallAfterWide = probe(snapshot(), [255, 0, 0]);

  hTall.dispose();
  hWide.dispose();
  bTall.dispose();
  bWide.dispose();

  return { tallAlone, wideAlone, wideAfterTall, tallAfterWide };
}, SVG_TALL, SVG_WIDE);

await browser.close();
server.close();

function fmt(probe) {
  // Render a compact "C: ##########  R: ##########" visual.
  const col = probe.colFilled.map(b => b ? '█' : '·').join('');
  const row = probe.rowFilled.map(b => b ? '█' : '·').join('');
  return `col=${col} row=${row}`;
}

function probesEqual(a, b) {
  for (let i = 0; i < 10; i++) {
    if (a.colFilled[i] !== b.colFilled[i]) return false;
    if (a.rowFilled[i] !== b.rowFilled[i]) return false;
  }
  return true;
}

console.log(`tall alone:        ${fmt(results.tallAlone)}`);
console.log(`wide alone:        ${fmt(results.wideAlone)}`);
console.log(`wide after tall:   ${fmt(results.wideAfterTall)}`);
console.log(`tall after wide:   ${fmt(results.tallAfterWide)}`);

if (probesEqual(results.wideAfterTall, results.wideAlone)) {
  ok('wide footprint identical whether drawn alone or after tall');
} else {
  fail('wide footprint changed when preceded by tall — dimensions bug reproduces');
}

if (probesEqual(results.tallAfterWide, results.tallAlone)) {
  ok('tall footprint identical whether drawn alone or after wide');
} else {
  fail('tall footprint changed when preceded by wide — dimensions bug reproduces');
}

// Cross-check: tall and wide must actually have DIFFERENT footprints
// (else the test isn't measuring anything).
if (probesEqual(results.tallAlone, results.wideAlone)) {
  fail('tall and wide solo footprints are identical — test fixtures are not distinguishing aspect ratios');
} else {
  ok('tall and wide solo footprints differ (fixture is a meaningful test)');
}

if (failures) {
  console.error(`\n${failures} assertions failed`);
  process.exit(1);
}
console.log('\nbundleHandleDimensionsSmoke: PASS');

// museoIFillDropoutSweep.mjs — regression guard for a lowercase 'i'
// rendering unfilled in a single occurrence (coverage fill).
//
// Text glyphs are rasterised by the per-pixel coverage ray-cast in
// _slugCoverage.glsl. Coverage combines an H-ray and a V-ray via
// `min(abs(L.x), abs(L.y))` for interior pixels. If either axis miscounts
// its winding by a single crossing at a shared vertex / near-axis tangent,
// an interior pixel with no edge within 0.5px gets ZERO coverage — a total
// dropout. Because glyphs are baked at absolute layout coords and the walker
// is sensitive to sub-pixel phase, two identical glyphs can render
// differently: one fills, one drops. The 'i' is the canary — thinnest stem
// plus a separate dot contour stacked above it (4 near-collinear edges on a
// V-ray).
//
// Strategy: render a long row of identical 'i's so one frame samples many
// sub-pixel phases at once, with the sibling glyphs as the "should be
// identical" baseline. Sweep the viewport size finely to cross
// size-dependent thresholds. A dropout = any glyph whose ink is a strong
// outlier below its siblings, or an interior background hole inside a
// glyph's stem box.
//
//   MANTLE_FONT=/path/to/font.ttf node test/museoIFillDropoutSweep.mjs
//
// Exit 0 = no dropout found across the sweep; 1 = dropout(s) found (PNGs of
// the failing frames are written to test/visuals/).

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { decodeIfWoff2 } from '../src/font/fontAsset.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'i-dropout-sweep');
mkdirSync(OUT, { recursive: true });

// ---- config ----
const FONT_PATH = process.env.MANTLE_FONT
  || '/System/Library/Fonts/Supplemental/Arial.ttf';
const GLYPH = process.env.MANTLE_GLYPH || 'i';
// The mantleDemo canvas is a FIXED 800×800 (viewport size is ignored),
// and the run is fit to the 800px width. So the realized glyph size is
// set by the GLYPH COUNT: N glyphs → ~800/N px per cell. We sweep N to
// sweep realized size from chunky (~20px stem) down to sub-pixel
// (where thin-feature winding bugs bite). Within each render the N
// glyphs land at N different sub-pixel phases, so one frame samples
// many phases — the sibling glyphs are the "should be identical"
// baseline. Coarse early, dense in the small-size danger zone.
const COUNTS = [];
for (let n = 16; n <= 60; n += 2) COUNTS.push(n);     // big → medium
for (let n = 61; n <= 240; n += 1) COUNTS.push(n);    // small danger zone, dense
for (let n = 244; n <= 420; n += 4) COUNTS.push(n);   // tiny
const VIEW_H = 200;

// ---- detector self-test (no GPU): fabricate an i-row ink frame with
// one glyph blanked, assert analyze() flags exactly that glyph. Proves
// a clean sweep means "no dropout", not "detector never fires". ----
if (process.argv.includes('--selftest')) {
  const w = 600, h = 64, ink = new Float32Array(w * h);
  const pitch = 20, stemW = 4, n = Math.floor(w / pitch);
  const BLANK = 7;                                   // glyph to drop
  for (let g = 0; g < n; g++) {
    if (g === BLANK) continue;
    const cx = g * pitch + pitch / 2;
    for (let y = 14; y < 54; y++)                    // stem
      for (let x = cx - stemW / 2; x < cx + stemW / 2; x++) ink[y * w + (x | 0)] = 1;
    for (let y = 4; y < 10; y++)                      // dot
      for (let x = cx - stemW / 2; x < cx + stemW / 2; x++) ink[y * w + (x | 0)] = 1;
  }
  const a = analyze(w, h, ink);
  const ok = a && a.dropouts.length === 1;
  console.log(`selftest: ${a ? a.glyphs.length : 0} glyphs, dropouts=${a ? a.dropouts.length : 'null'} → ${ok ? 'PASS (detector fires)' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

// ---- static server (serve repo root + system fonts) ----
function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/mantleDemo.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const data = readFileSync(fp);
    res.writeHead(200, { 'content-type': mime(fp), 'cache-control': 'no-store' });
    res.end(data);
  } catch (e) { res.writeHead(404); res.end(String(e && e.message)); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/mantleDemo.html`;

let fontBytes = new Uint8Array(readFileSync(FONT_PATH));
fontBytes = await decodeIfWoff2(fontBytes);
const ttfArr = Array.from(fontBytes);
console.log(`font: ${FONT_PATH} (${fontBytes.length} bytes), glyph '${GLYPH}', N sweep ${COUNTS[0]}..${COUNTS[COUNTS.length - 1]} (${COUNTS.length} renders)`);

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});

// Render one case, return composited top-down grayscale "ink" (0=bg,
// 1=fully painted) plus dims. Ink = darkness over white background.
async function renderInk(page, markup) {
  const result = await page.evaluate(
    async (ttf, m) => {
      try {
        const ret = await window.mantleRenderText(new Uint8Array(ttf), m,
          { defaultColor: [0, 0, 0, 1], align: 'left' });
        return { ok: true, ...ret };
      } catch (e) { return { ok: false, err: e && (e.stack || String(e)) }; }
    }, ttfArr, markup);
  if (!result.ok) return { err: result.err };
  const frame = await page.evaluate(() => {
    const f = window.__mantleLastFrame;
    if (!f) return null;
    const w = f.w, hh = f.h;
    const ink = new Float32Array(w * hh);
    for (let y = 0; y < hh; y++) {
      const srcY = hh - 1 - y;               // readPixels is bottom-up
      for (let x = 0; x < w; x++) {
        const so = (srcY * w + x) * 4;
        // The framebuffer is OPAQUE (alpha is 255 everywhere), so ink
        // must come from luminance: composite premultiplied RGB over
        // white, then ink = 1 - luma. Black text → ink≈1, bg → 0.
        const a = f.data[so + 3];
        const rr = Math.min(255, f.data[so] + (255 - a));
        const gg = Math.min(255, f.data[so + 1] + (255 - a));
        const bb = Math.min(255, f.data[so + 2] + (255 - a));
        ink[y * w + x] = 1 - (rr + gg + bb) / 765;
      }
    }
    return { w, h: hh, ink: Array.from(ink) };
  });
  return frame ? { w: frame.w, h: frame.h, ink: Float32Array.from(frame.ink), numShapes: result.numShapes } : { err: 'no frame' };
}

// Segment the i-row into per-glyph clusters via the column ink profile,
// then compare ink mass across the identical glyphs. Returns
// { glyphs:[{x0,x1,ink}], dropouts:[idx...], stemPx } or null.
function analyze(w, h, ink) {
  const col = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) s += ink[y * w + x];
    col[x] = s;
  }
  // Cluster columns into glyphs: a glyph is a maximal run of columns
  // with ink above a small fraction of the row's peak column.
  let peak = 0; for (let x = 0; x < w; x++) peak = Math.max(peak, col[x]);
  if (peak < 1e-3) return null;
  const on = col.map(v => v > peak * 0.06 ? 1 : 0);
  const glyphs = [];
  let x = 0;
  while (x < w) {
    if (!on[x]) { x++; continue; }
    let x0 = x; while (x < w && on[x]) x++;
    let x1 = x;                              // [x0, x1)
    let mass = 0;
    for (let xx = x0; xx < x1; xx++) mass += col[xx];
    glyphs.push({ x0, x1, ink: mass });
    // skip tiny specular noise clusters
  }
  // Keep only "real" glyph-sized clusters (filter sub-pixel noise).
  const widths = glyphs.map(g => g.x1 - g.x0).sort((a, b) => a - b);
  const medW = widths[widths.length >> 1] || 1;
  const real = glyphs.filter(g => (g.x1 - g.x0) >= medW * 0.4);
  if (real.length < 6) return { glyphs: real, dropouts: [], note: 'too-few-glyphs' };

  // (A) PARTIAL dropout: a glyph that drew but is missing its stem or
  // dot → strong low-ink outlier vs its identical siblings.
  const masses = real.map(g => g.ink).slice().sort((a, b) => a - b);
  const medMass = masses[masses.length >> 1];
  const partial = [];
  real.forEach((g, i) => { if (g.ink < medMass * 0.62) partial.push(i); });

  // (B) TOTAL dropout: an entire 'i' rendered blank leaves NO cluster —
  // it shows up only as a ~2× gap in the otherwise even glyph pitch.
  // Estimate pitch from consecutive cluster centers (median is robust
  // to the one or two missing slots) and flag any oversized gap.
  const cx = real.map(g => (g.x0 + g.x1) / 2);
  const gaps = [];
  for (let i = 1; i < cx.length; i++) gaps.push(cx[i] - cx[i - 1]);
  const gsort = gaps.slice().sort((a, b) => a - b);
  const pitch = gsort[gsort.length >> 1] || medW;
  let missing = 0;
  for (const gp of gaps) missing += Math.max(0, Math.round(gp / pitch) - 1);

  const dropouts = partial.slice();
  // Represent each missing (total) dropout as a synthetic index so the
  // count reflects total + partial.
  for (let m = 0; m < missing; m++) dropouts.push(-1 - m);
  return { glyphs: real, dropouts, partial: partial.length, missing, medMass, stemPx: medW, pitch };
}

// Encode an ink frame to PNG (via the page's canvas) for inspection.
async function savePng(page, w, h, ink, file) {
  const b64 = await page.evaluate((w, h, inkArr) => {
    const cnv = document.createElement('canvas');
    cnv.width = w; cnv.height = h;
    const ctx = cnv.getContext('2d');
    const id = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = Math.round(255 * (1 - inkArr[i]));   // white bg, black ink
      id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    return cnv.toDataURL('image/png').split(',')[1];
  }, w, h, Array.from(ink));
  writeFileSync(file, Buffer.from(b64, 'base64'));
}

const page = await browser.newPage();
await page.setViewport({ width: 900, height: VIEW_H, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.mantleTextReady === true, { timeout: 8000 });

let totalDropouts = 0;
let failCases = 0;
const failingSizes = [];
const cellSeen = new Set();
for (const n of COUNTS) {
  const r = await renderInk(page, GLYPH.repeat(n));
  if (r.err) { console.error(`N=${n}: render error: ${r.err}`); failCases++; continue; }
  const a = analyze(r.w, r.h, r.ink);
  if (!a) continue;
  if (a.stemPx) cellSeen.add(a.stemPx);
  if (a.dropouts.length) {
    totalDropouts += a.dropouts.length;
    failingSizes.push({ n, cellPx: a.stemPx, dropouts: a.dropouts.length, glyphs: a.glyphs.length, partial: a.partial, missing: a.missing });
    const png = path.join(OUT, `drop_N${n}_cell${a.stemPx}.png`);
    await savePng(page, r.w, r.h, r.ink, png);
    console.log(`DROPOUT  N=${n}  cell≈${a.stemPx}px  partial=${a.partial} missing=${a.missing}  (${a.glyphs.length}/${n} glyphs found)  → ${png}`);
  }
}
await page.close();

const cells = [...cellSeen].sort((a, b) => a - b);
console.log(`realized glyph cell widths sampled (px): ${cells.join(', ')}`);

if (!process.argv.includes('--keep-open')) { await browser.close(); server.close(); }

console.log();
if (totalDropouts === 0) {
  console.log(`PASS — no 'i' dropouts across ${COUNTS.length} glyph counts (cell ${cells[0]}–${cells[cells.length - 1]}px).`);
  process.exit(0);
} else {
  console.log(`FAIL — ${totalDropouts} dropout(s) across ${failingSizes.length} size(s). Failing realized cell widths (px): ${[...new Set(failingSizes.map(f => f.cellPx))].sort((a, b) => a - b).join(', ')}`);
  process.exit(1);
}

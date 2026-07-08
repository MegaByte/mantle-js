// museoIWordDropoutSweep.mjs — word-context variant of the 'i' dropout
// check. Renders real words containing two or more 'i's (e.g. "building")
// and compares the ink of each 'i' glyph against its siblings in the same
// word, catching an 'i' that fills inconsistently within a single word.
//
// Each glyph is its own coverage shape, so unlike a pure i-row this also
// exercises the per-glyph buffer offsets / sub-pixel phases the actual
// word produces. We locate the 'i' glyphs via measureGlyphsFromText
// (em-space pen positions) and map them to pixel columns using the painted
// run's extent.
//
//   MANTLE_FONT=/path/to/font.ttf node test/museoIWordDropoutSweep.mjs
//
// Exit 0 = every 'i' in every word/size fills consistently; 1 = at
// least one 'i' dropped relative to its in-word siblings.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { decodeIfWoff2 } from '../src/font/fontAsset.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'i-word-dropout');
mkdirSync(OUT, { recursive: true });

const FONT_PATH = process.env.MANTLE_FONT
  || '/System/Library/Fonts/Supplemental/Arial.ttf';
// Words with ≥2 'i's so the in-word siblings give a baseline.
const WORDS = (process.env.MANTLE_WORDS
  || 'building,minimize,visibility,initializing,illuminating,iiiiiiii')
  .split(',');
const VIEW_H = 200;
const WIDTHS = [];
for (let w = 240; w <= 1500; w += 2) WIDTHS.push(w);

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (p === '/') p = '/mantleDemo.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try { const d = readFileSync(fp); res.writeHead(200, { 'content-type': mime(fp), 'cache-control': 'no-store' }); res.end(d); }
  catch (e) { res.writeHead(404); res.end(String(e && e.message)); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

let fontBytes = await decodeIfWoff2(new Uint8Array(readFileSync(FONT_PATH)));
const ttfArr = Array.from(fontBytes);
console.log(`font: ${FONT_PATH}; words: ${WORDS.join(' ')}`);

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('pageerror', String(e)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.mantleTextReady === true, { timeout: 8000 });

// Per word: em-space glyph layout (pen positions + which are 'i').
async function glyphLayout(word) {
  return await page.evaluate(async (ttf, w) => {
    const fontMod = await import('./src/font/fontAsset.js');
    const runMod = await import('./src/font/textRun.js');
    const bytes = await fontMod.decodeIfWoff2(new Uint8Array(ttf));
    const font = new fontMod.MantleFontAsset(bytes);
    const m = runMod.measureGlyphsFromText(w, font, {});
    return {
      glyphs: m.glyphs.map(g => ({ penX: g.penX, advance: g.advance, cp: g.codepoint })),
    };
  }, ttfArr, word);
}

async function renderInk(page, markup) {
  // Canvas is a fixed 800×800; viewport size is ignored, so don't set it.
  const result = await page.evaluate(async (ttf, m) => {
    try {
      const ret = await window.mantleRenderText(new Uint8Array(ttf), m, { defaultColor: [0, 0, 0, 1], align: 'left' });
      return { ok: true, ...ret };
    } catch (e) { return { ok: false, err: e && (e.stack || String(e)) }; }
  }, ttfArr, markup);
  if (!result.ok) return { err: result.err };
  const frame = await page.evaluate(() => {
    const f = window.__mantleLastFrame; if (!f) return null;
    const ww = f.w, hh = f.h, ink = new Float32Array(ww * hh);
    for (let y = 0; y < hh; y++) {
      const sy = hh - 1 - y;
      for (let x = 0; x < ww; x++) {
        const so = (sy * ww + x) * 4, a = f.data[so + 3];
        const rr = Math.min(255, f.data[so] + (255 - a));
        const gg = Math.min(255, f.data[so + 1] + (255 - a));
        const bb = Math.min(255, f.data[so + 2] + (255 - a));
        ink[y * ww + x] = 1 - (rr + gg + bb) / 765;   // opaque FB → use luma
      }
    }
    return { w: ww, h: hh, ink: Array.from(ink) };
  });
  return frame ? { w: frame.w, h: frame.h, ink: Float32Array.from(frame.ink) } : { err: 'no frame' };
}

// Painted run x-extent (first/last inked column) → maps em pen-X to px.
function inkColumns(w, h, ink) {
  const col = new Float32Array(w);
  for (let x = 0; x < w; x++) { let s = 0; for (let y = 0; y < h; y++) s += ink[y * w + x]; col[x] = s; }
  let minX = -1, maxX = -1;
  for (let x = 0; x < w; x++) if (col[x] > 0.01) { if (minX < 0) minX = x; maxX = x; }
  return { col, minX, maxX };
}

async function savePng(page, w, h, ink, file) {
  const b64 = await page.evaluate((w, h, a) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); const id = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) { const v = Math.round(255 * (1 - a[i])); id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    ctx.putImageData(id, 0, 0); return c.toDataURL('image/png').split(',')[1];
  }, w, h, Array.from(ink));
  writeFileSync(file, Buffer.from(b64, 'base64'));
}

// The demo canvas is a fixed 800×800 and fits the whole run to its width,
// so the realized size is set by how much text is on the line. We control
// size by repeating the word K times: more repeats → smaller text. Each
// repeat also lands the word's 'i's at fresh sub-pixel phases, so one
// render samples many phases of the real word context (the neighbour
// phases matter — a uniform i-row at readable sizes does not exercise
// them). Detection is gated to the readable regime (realized cap height
// ≳ 10px) so we don't re-flag the genuine sub-pixel floor (<1px stems).
const REPEATS = [];
for (let k = 2; k <= 60; k++) REPEATS.push(k);
const MIN_PXPEREM = 11;           // ~cap-height 8px; below this is sub-pixel

let totalDropouts = 0;
let readableRenders = 0;
for (const word of WORDS) {
  for (const K of REPEATS) {
    const markup = (word + ' ').repeat(K).trim();
    const lay = await glyphLayout(markup);
    const gl = lay.glyphs;
    const iIdx = gl.map((g, i) => ({ g, i })).filter(o => o.g.cp === 0x69).map(o => o.i);
    if (iIdx.length < 2) continue;
    const emMinPen = gl[0].penX;
    const emMaxPen = gl[gl.length - 1].penX + gl[gl.length - 1].advance;
    const emRunW = Math.max(1e-6, emMaxPen - emMinPen);

    const r = await renderInk(page, markup);
    if (r.err) { console.error(`"${word}"×${K}: ${r.err}`); continue; }
    const { col, minX, maxX } = inkColumns(r.w, r.h, r.ink);
    if (minX < 0 || maxX <= minX) continue;
    const pxPerEm = (maxX - minX) / emRunW;
    if (pxPerEm < MIN_PXPEREM) continue;          // restrict to readable sizes
    readableRenders++;

    // Per-'i' stem peak ink. Do not window by penX→px directly:
    // cumulative em→px mapping drift over a long line pushes late stems
    // out of their computed window and falsely reads them as faint (the
    // stem still renders full, just shifted). Search a ±0.45·advance px
    // neighbourhood around the expected centre for the actual stem (local
    // column-ink peak) and compare peaks. A real dropout lowers the peak;
    // a misalignment does not.
    const iMass = iIdx.map(idx => {
      const g = gl[idx];
      const cxe = minX + (g.penX + g.advance * 0.5 - emMinPen) * pxPerEm;
      const half = Math.max(2, g.advance * 0.45 * pxPerEm);
      let peak = 0;
      for (let x = Math.round(cxe - half); x <= Math.round(cxe + half); x++)
        if (x >= 0 && x < r.w && col[x] > peak) peak = col[x];
      return peak;
    });
    const sorted = iMass.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    // 0.4: flag only a near-blank stem. cap≤9px shows ~0.5-peak AA
    // variation between sub-pixel phases that is not a visible dropout,
    // so a looser threshold would cry wolf.
    const dropped = iMass.filter(m => med > 0 && m < med * 0.4).length;
    if (dropped) {
      totalDropouts += dropped;
      const capPx = pxPerEm * 0.72;               // rough cap height
      const png = path.join(OUT, `drop_${word}_x${K}.png`);
      await savePng(page, r.w, r.h, r.ink, png);
      console.log(`DROPOUT "${word}"×${K}  cap≈${capPx.toFixed(0)}px pxPerEm≈${pxPerEm.toFixed(1)}  ${dropped}/${iIdx.length} i's faint  med=${med.toFixed(0)} min=${sorted[0].toFixed(0)}  → ${png}`);
    }
  }
}
await page.close();
if (!process.argv.includes('--keep-open')) { await browser.close(); server.close(); }
console.log();
console.log(`readable renders inspected: ${readableRenders}`);
console.log(totalDropouts === 0
  ? `PASS — every 'i' filled consistently (readable sizes).`
  : `FAIL — ${totalDropouts} in-word 'i' dropout(s) at readable sizes.`);
process.exit(totalDropouts === 0 ? 0 : 1);

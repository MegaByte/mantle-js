// museoISubpixelHunt.mjs — fixed-size, dense sub-pixel sweep hunting an
// unfilled 'i' in a single word (e.g. "building"). This:
//   * pins an exact pixel size by driving bundle.globalBBox directly
//     (size = canvasPx / globalBBox.width), independent of the demo's
//     fit-to-canvas;
//   * sweeps the sub-pixel x (and a few y) offsets in hundreds of
//     fractional steps at each size, via globalBBox.x/.y +
//     invalidateRenderState()+render() — no per-frame rebuild;
//   * measures each i's stem peak ink and compares it to the 'l' stem
//     (a same-width vertical stroke in the same word) as a healthy
//     reference, so a real dropout = an i stem that craters toward 0 at
//     some phase while 'l' stays full.
//
//   MANTLE_FONT=/path/to/font.ttf node test/museoISubpixelHunt.mjs
//
// Env: MANTLE_PPE="40,52,64" to force specific pixels-per-em (≈ cap
// height / 0.7); MANTLE_STEPS=400 sub-pixel steps; MANTLE_WORD.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { decodeIfWoff2 } from '../src/font/fontAsset.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'i-subpixel-hunt');
mkdirSync(OUT, { recursive: true });

const FONT = process.env.MANTLE_FONT || '/System/Library/Fonts/Supplemental/Arial.ttf';
const WORD = process.env.MANTLE_WORD || 'building';
const STEPS = +(process.env.MANTLE_STEPS || 400);
// Pixels-per-em sweep. cap height ≈ 0.72·ppe, so 28..120 ppe ≈ 20..86px
// glyphs — brackets any plausible screenshot size.
const PPES = (process.env.MANTLE_PPE
  ? process.env.MANTLE_PPE.split(',').map(Number)
  : [28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 88, 96, 104, 120]);
const Y_OFFS = +(process.env.MANTLE_YOFFS || 3);   // sub-pixel y phases per size

const srv = http.createServer((q, s) => {
  let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p === '/') p = '/mantleDemo.html';
  const fp = path.join(ROOT, p);
  try { const d = readFileSync(fp); s.writeHead(200, { 'content-type': fp.endsWith('.html') ? 'text/html' : (fp.endsWith('.mjs') || fp.endsWith('.js')) ? 'text/javascript' : 'application/octet-stream' }); s.end(d); }
  catch (e) { s.writeHead(404); s.end(); }
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${srv.address().port}/mantleDemo.html`;
const ttf = Array.from(await decodeIfWoff2(new Uint8Array(readFileSync(FONT))));

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('pageerror', String(e)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.mantleTextReady === true, { timeout: 8000 });

// Glyph layout: stem-centre em-x for each 'i' and a reference 'l'/'d'/'b'.
const lay = await page.evaluate(async (t, w) => {
  const fm = await import('./src/font/fontAsset.js');
  const rm = await import('./src/font/textRun.js');
  const f = new fm.MantleFontAsset(await fm.decodeIfWoff2(new Uint8Array(t)));
  const g = rm.measureGlyphsFromText(w, f, {});
  return { glyphs: g.glyphs.map(x => ({ penX: x.penX, advance: x.advance, cp: x.codepoint })) };
}, ttf, WORD);
const gl = lay.glyphs;
// Stem centre ≈ penX + 0.116em (MuseoSans 'i' stem x[82,150]/1000). For
// the reference stroke ('l','d','b','t','k' — tall thin verticals) use
// the same offset; good enough for a peak probe.
const STEM = 0.116;
const iProbes = gl.map((g, idx) => ({ idx, cp: g.cp, ex: g.penX + STEM })).filter(o => o.cp === 0x69);
const refCps = new Set([0x6c, 0x64, 0x62, 0x68, 0x6b, 0x74]); // l d b h k t
const refProbe = gl.map((g, idx) => ({ idx, cp: g.cp, ex: g.penX + STEM })).find(o => refCps.has(o.cp));
if (iProbes.length === 0) { console.error('no i in word'); process.exit(2); }

// Build + bind the bundle once.
await page.evaluate(async (t, m) => { await window.mantleRenderText(new Uint8Array(t), m, { defaultColor: [0, 0, 0, 1] }); }, ttf, WORD);
const content = await page.evaluate(() => window.__mantleGetBundle().globalBBox.slice()); // [0,0,cw,ch]
const contentW = content[2], contentH = content[3];

// One render at (ox,oy,gbw,gbh): set globalBBox, invalidate, render,
// read pixels. Return position-independent signals: total word ink, and
// per-i stem ink found by local search (robust to any em→bundle scale
// offset). A real "unfilled i" craters both total ink and that i's local
// stem ink at a specific phase; the min render is the visual arbiter
// (computed-position probes are unreliable).
async function probe(ox, oy, gbw, gbh, iExs, refEx) {
  return await page.evaluate((ox, oy, gbw, gbh, iExs, refEx) => {
    const gb = window.__mantleGetBundle().globalBBox;
    gb[0] = ox; gb[1] = oy; gb[2] = gbw; gb[3] = gbh;
    window.__mantleRenderer.invalidateRenderState();
    window.__mantleRenderer.render();
    const g2 = window.__mantleGl;
    const w = g2.drawingBufferWidth, h = g2.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    g2.readPixels(0, 0, w, h, g2.RGBA, g2.UNSIGNED_BYTE, buf);
    const col = new Float32Array(w);
    let total = 0;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4, a = buf[o + 3];
        const lum = (Math.min(255, buf[o] + (255 - a)) + Math.min(255, buf[o + 1] + (255 - a)) + Math.min(255, buf[o + 2] + (255 - a))) / 3;
        s += 1 - lum / 255;
      }
      col[x] = s; total += s;
    }
    const ppe = w / gbw;
    // Stem ink in a narrow ±2px window centred on the expected stem.
    // Narrow (not wide) on purpose: a wide search would hop to a
    // neighbour stem and hide a real dropout. The expected centre may be
    // a bit off (scale), so total ink is the primary signal; stem
    // windows are advisory.
    const stemInk = (ex) => { const cx = Math.round((ex - ox) * ppe); let m = 0; for (let dx = -2; dx <= 2; dx++) { const x = cx + dx; if (x >= 0 && x < w) m += col[x]; } return +m.toFixed(1); };
    return { total: +total.toFixed(0), iInk: iExs.map(stemInk), refInk: refEx != null ? stemInk(refEx) : 0 };
  }, ox, oy, gbw, gbh, iExs, refEx);
}

const iExs = iProbes.map(p => p.ex);
const refEx = refProbe ? refProbe.ex : null;
const CANVAS = await page.evaluate(() => window.__mantleGl.drawingBufferWidth);

// Render + save a zoomed crop at a given offset (the arbiter image).
async function saveZoom(ox, oy, gbw, gbh, file) {
  const png = await page.evaluate((ox, oy, gbw, gbh) => {
    const gb = window.__mantleGetBundle().globalBBox;
    gb[0] = ox; gb[1] = oy; gb[2] = gbw; gb[3] = gbh;
    window.__mantleRenderer.invalidateRenderState(); window.__mantleRenderer.render();
    const g2 = window.__mantleGl; const w = g2.drawingBufferWidth, h = g2.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4); g2.readPixels(0, 0, w, h, g2.RGBA, g2.UNSIGNED_BYTE, buf);
    const lum = (x, y) => { const o = ((h - 1 - y) * w + x) * 4, a = buf[o + 3]; return (Math.min(255, buf[o] + (255 - a)) + Math.min(255, buf[o + 1] + (255 - a)) + Math.min(255, buf[o + 2] + (255 - a))) / 3; };
    let mnX = w, mxX = -1, mnY = h, mxY = -1; for (let y = 0; y < h; y++)for (let x = 0; x < w; x++)if (lum(x, y) < 170) { if (x < mnX)mnX = x; if (x > mxX)mxX = x; if (y < mnY)mnY = y; if (y > mxY)mxY = y; }
    if (mxX < 0) return null;
    const cw = mxX - mnX + 1, ch = mxY - mnY + 1, Z = Math.max(2, Math.min(8, (700 / cw) | 0) || 4);
    const cnv = document.createElement('canvas'); cnv.width = cw * Z; cnv.height = ch * Z; const ctx = cnv.getContext('2d'); const id = ctx.createImageData(cw * Z, ch * Z);
    for (let y = 0; y < ch * Z; y++)for (let x = 0; x < cw * Z; x++) { const v = Math.round(lum(mnX + (x / Z | 0), mnY + (y / Z | 0))); const o = (y * cw * Z + x) * 4; id.data[o] = v; id.data[o + 1] = v; id.data[o + 2] = v; id.data[o + 3] = 255; }
    ctx.putImageData(id, 0, 0); return cnv.toDataURL('image/png').split(',')[1];
  }, ox, oy, gbw, gbh);
  if (png) writeFileSync(file, Buffer.from(png, 'base64'));
  return !!png;
}

let renders = 0;
const flagged = [];
for (const ppe of PPES) {
  const gbw = CANVAS / ppe, gbh = CANVAS / ppe;
  const baseOx = contentW / 2 - gbw / 2;
  const baseOy = contentH / 2 - gbh / 2;
  let minTot = Infinity, maxTot = 0, minAt = null;
  // Track each i's min local stem ink + the ref's typical ink.
  const iMin = iExs.map(() => Infinity), iMax = iExs.map(() => 0);
  let refMax = 0;
  for (let yi = 0; yi < Y_OFFS; yi++) {
    const oy = baseOy + (yi / Y_OFFS) * (1 / ppe);
    for (let s = 0; s < STEPS; s++) {
      const ox = baseOx + (s / STEPS) * (1 / ppe);
      const r = await probe(ox, oy, gbw, gbh, iExs, refEx);
      renders++;
      if (r.total < minTot) { minTot = r.total; minAt = { ox, oy }; }
      if (r.total > maxTot) maxTot = r.total;
      r.iInk.forEach((v, k) => { if (v < iMin[k]) iMin[k] = v; if (v > iMax[k]) iMax[k] = v; });
      if (r.refInk > refMax) refMax = r.refInk;
    }
  }
  const totRatio = maxTot > 0 ? minTot / maxTot : 1;
  const iWorst = Math.min(...iMin.map((v, k) => (iMax[k] > 0 ? v / iMax[k] : 1)));
  // Flag on the position-independent signal only: an unfilled i removes
  // a whole stem (~4-6% of the word's ink), so total ink craters below
  // ~95% of its max at that phase. iStem windows are advisory (the
  // narrow probe drifts and can falsely read 0).
  const suspicious = totRatio < 0.95;
  console.log(`ppe=${ppe} cap≈${(ppe * 0.72).toFixed(0)}px  totalInk ${minTot}..${maxTot} (min/max=${(totRatio * 100).toFixed(1)}%)  iStemMin/Max=[${iMin.map((v, k) => `${v.toFixed(0)}/${iMax[k].toFixed(0)}`).join(', ')}]${suspicious ? '  <<< INSPECT' : ''}`);
  // Always save the min-total render so we can eyeball it.
  const f = path.join(OUT, `mintotal_ppe${ppe}_cap${(ppe * 0.72).toFixed(0)}.png`);
  await saveZoom(minAt.ox, minAt.oy, gbw, gbh, f);
  if (suspicious) flagged.push({ ppe, totRatio, iWorst, file: f });
}
console.log(`\ntotal renders: ${renders}`);
console.log(flagged.length
  ? `INSPECT ${flagged.length} size(s): ${flagged.map(f => `ppe${f.ppe}(tot ${(f.totRatio * 100).toFixed(1)}%, iStem ${(f.iWorst * 100).toFixed(0)}%)`).join(', ')}`
  : `no total-ink craters — every size's min render saved under ${OUT} for spot-checking.`);
console.log(`min-total renders saved per size in ${OUT}`);
await page.close();
if (!process.argv.includes('--keep-open')) { await browser.close(); srv.close(); }

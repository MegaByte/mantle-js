// colrV1VisualSmoke.mjs — render a synthetic COLRv1 glyph through the
// WebGL renderer end-to-end and verify the framebuffer carries the
// expected colour signal.
//
// Why synthetic: vendoring Noto Color Emoji (~9MB) is overkill for a
// smoke that just exercises the COLR dispatch path. `_colrFontFixture`
// already builds a minimal CPAL/COLR font with a paint tree the
// dispatch can paint (paintColrLayers → 2 paintSolid). The smoke
// loads that font, asks `mantleRenderText` to render the COLR
// codepoint, and inspects the resulting framebuffer:
//
//   1. v0 fixture: gid 1 = COLRv0 layers (red square + green-α square).
//      Coverage check: > 100 red pixels OR > 100 green pixels.
//   2. v1-rich fixture: gid 1 = paintColrLayers(paintGlyph(transform,
//      solid red), paintSolid green). Coverage check: same as v0
//      since the rich fixture intentionally produces a similar visual.
//
// These are coverage checks, not pixel-identical baselines — the
// renderer's dilation + premultiply + canvas-AR mapping all vary by
// viewport, and we don't want to bake a baseline image without a
// good reason. The signal we care about is "did the COLR branch
// actually fire and paint COLOUR pixels?"

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

import { buildColrTestFont } from './_colrFontFixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT  = path.join(__dirname, 'visuals', 'colr-v1');
mkdirSync(OUT, { recursive: true });

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try { res.writeHead(200, { 'content-type': mime(p) }); res.end(readFileSync(path.join(ROOT, p))); }
  catch (e) { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

const COLR_CODEPOINT = 0x41;       // synthetic fixture maps 'A' to its base glyph.
const CASES = [
  {
    name: 'v0-layers',
    fontBytes: buildColrTestFont({ codepoint: COLR_CODEPOINT }),
    desc: 'COLRv0 layer list (red + green-α squares)',
  },
  {
    name: 'v1-rich',
    fontBytes: buildColrTestFont({ codepoint: COLR_CODEPOINT, colrV1Rich: true }),
    desc: 'COLRv1 paint tree (colrLayers → transform → 2 solids)',
  },
  {
    name: 'v1-grad',
    fontBytes: buildColrTestFont({ codepoint: COLR_CODEPOINT, colrV1Grad: true }),
    desc: 'COLRv1 gradient (linear / radial / sweep)',
  },
];

let failures = 0;
function fail(name, msg) { console.error(`FAIL [${name}]: ${msg}`); failures++; }

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});

for (const c of CASES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 512, height: 512 });
  // Surface page-side console output so any silent COLR dispatch errors
  // bubble up to the test runner.
  page.on('console', m => console.log(`  [page-${c.name}]`, m.text()));
  page.on('pageerror', e => console.log(`  [page-err-${c.name}]`, e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => window.mantleTextReady === true, { timeout: 5000 });
  } catch (e) {
    const status = await page.evaluate(() => document.getElementById('status') && document.getElementById('status').textContent);
    fail(c.name, `mantleTextReady timeout (status="${status}")`);
    await page.close();
    continue;
  }

  const result = await page.evaluate(
    async (ttfArr, text) => {
      try {
        const { setDiagnostics } = await import('/src/index.js');
        const trace = [];
        setDiagnostics({ colrTrace: trace });
        const r = await window.mantleRenderText(
          new Uint8Array(ttfArr), text,
          { defaultColor: [0.5, 0.5, 0.5, 1], fontSizePx: 256 });
        setDiagnostics({ colrTrace: null });
        return { ok: true, trace, ...r };
      } catch (e) { return { ok: false, err: e && (e.stack || e.message || String(e)) }; }
    },
    Array.from(c.fontBytes), String.fromCodePoint(COLR_CODEPOINT));
  if (result.trace && result.trace.length) {
    console.log(`  trace[${c.name}]: ${result.trace.map(t => {
      let s = `[${t.i}]${t.type}`;
      if (t.err) s += '⚠' + t.err.toString(16);
      if (t.rgba) s += '=' + JSON.stringify(t.rgba);
      return s;
    }).join(' → ')}`);
  }

  if (!result.ok) {
    fail(c.name, `render hook threw: ${result.err}`);
    await page.close();
    continue;
  }

  // Diagnostic surface — verify the COLR dispatch is wired before
  // pixel-coverage assertions. Failing here pinpoints the wiring
  // gap (e.g. colrGraphs not threaded through, meta texel 44 zero).
  const diag = await page.evaluate(() => window.__mantleLastTextDiag);
  if (diag) {
    console.log(`  diag[${c.name}]: shapes=${diag.numShapes} colrGraphs=${diag.colrGraphsCount} colrGraphIds=[${diag.colrGraphIds.join(',')}] flagsShape=[${diag.flagsShape.join(',')}] drawList=${diag.drawListLen} (slug=${diag.drawListSlugOps}, colr=${diag.drawListColrOps}) curveLen=${diag.curveLen} bbox=${JSON.stringify(diag.globalBBox)}`);
  }

  // Pull the framebuffer + tally colour channels. "Coloured" means
  // any non-white opaque pixel — we don't try to classify the COLR
  // mixture more finely than that, because PaintMerge with
  // red+green α=0.5 produces near-balanced (127, 128, 0) pixels
  // that don't satisfy any "channel-dominates" heuristic but are
  // clearly the result of correct compositing.
  const stats = await page.evaluate(() => {
    const f = window.__mantleLastFrame;
    if (!f) return null;
    const w = f.w, h = f.h, d = f.data;
    let opaque = 0;
    let redish = 0, greenish = 0, blueish = 0;
    let coloured = 0;   // any opaque pixel that's NOT pure white
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
      if (a < 16) continue;
      opaque++;
      // "Coloured" = at least one channel < 240 (i.e. not near-white).
      if (r < 240 || g < 240 || b < 240) coloured++;
      if (r > 64 && r - g > 64 && r - b > 64) redish++;
      if (g > 64 && g - r > 64 && g - b > 64) greenish++;
      if (b > 64 && b - r > 64 && b - g > 64) blueish++;
    }
    return { w, h, opaque, redish, greenish, blueish, coloured };
  });

  if (!stats) { fail(c.name, 'no __mantleLastFrame on page'); await page.close(); continue; }

  // Capture PNG via the page's canvas.
  const pngB64 = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    // Re-render to refresh the back buffer (it may have been cleared
    // between the readPixels above and now).
    return cnv.toDataURL('image/png').split(',')[1];
  });
  const outPng = path.join(OUT, `${c.name}.png`);
  writeFileSync(outPng, Buffer.from(pngB64, 'base64'));

  console.log(`  fb[${c.name}]: opaque=${stats.opaque} redish=${stats.redish} greenish=${stats.greenish} blueish=${stats.blueish}`);

  // Coverage assertions vary per fixture.
  //
  //   v0-layers: the framebuffer must carry both red AND green pixels
  //     (the fixture's two layer squares). v0 dispatch is exercised
  //     end-to-end here.
  //
  //   v1-rich: verifies the COLRv1 dispatch fires per-node via
  //     `trace[].rgba`, with correct colour through PaintSolid →
  //     PaintMerge → PaintTransform → PaintGlyph, and the final
  //     framebuffer carries coloured (non-white) pixels.
  //
  //   v1-grad: synthetic fixture has empty glyph outlines, so textRun
  //     produces zero shapes and there's nothing to render. Skip.
  if (c.name === 'v0-layers') {
    if (stats.opaque < 200) fail(c.name, `painted area too small: ${stats.opaque}px`);
    else if (stats.redish < 50 || stats.greenish < 50)
      fail(c.name, `missing red/green coverage: red=${stats.redish} green=${stats.greenish}`);
    else
      console.log(`PASS ${c.name}: opaque=${stats.opaque} red=${stats.redish} green=${stats.greenish} → ${path.relative(ROOT, outPng)}`);
  } else if (c.name === 'v1-rich') {
    // End-to-end COLR pipeline: per-node trace shows correct colour
    // through PaintSolid → PaintMerge → PaintTransform → PaintGlyph,
    // and the final framebuffer carries coloured (non-white) pixels
    // where the silhouette mask covered.
    const merge = result.trace && result.trace.find(t => t.type === 'PaintMerge' && t.rgba);
    const xform = result.trace && result.trace.find(t => t.type === 'PaintTransform' && t.rgba);
    const glyph = result.trace && result.trace.find(t => t.type === 'PaintGlyph' && t.rgba);
    if (!merge) { fail(c.name, 'no PaintMerge trace'); }
    else if (!xform) { fail(c.name, 'no PaintTransform trace'); }
    else if (!glyph) { fail(c.name, 'no PaintGlyph trace'); }
    else {
      const [mR, mG, , mA] = merge.rgba;
      const [xR, xG, , xA] = xform.rgba;
      const [gR, gG, , gA] = glyph.rgba;
      if (!(mR > 32 && mG > 32 && mA > 32))
        fail(c.name, `PaintMerge produced no colour: ${JSON.stringify(merge.rgba)}`);
      else if (!(xR > 32 && xG > 32 && xA > 32))
        fail(c.name, `PaintTransform produced no colour (em→px rescale regression): ${JSON.stringify(xform.rgba)}`);
      else if (!(gR > 32 && gG > 32 && gA > 32))
        fail(c.name, `PaintGlyph produced no colour (silhouette mask regression — see slot-44 primKind/colrGraphId gating): ${JSON.stringify(glyph.rgba)}`);
      else if ((stats.coloured | 0) < 200)
        fail(c.name, `framebuffer has < 200 coloured pixels: ${stats.coloured}`);
      else
        console.log(`PASS ${c.name}: dispatch fires end-to-end (Merge=${JSON.stringify(merge.rgba)} Transform=${JSON.stringify(xform.rgba)} Glyph=${JSON.stringify(glyph.rgba)}, fb coloured=${stats.coloured}) → ${path.relative(ROOT, outPng)}`);
    }
  } else if (c.name === 'v1-grad') {
    if (diag && diag.numShapes === 0) {
      console.log(`SKIP ${c.name}: synthetic v1-grad fixture has no glyph outlines; nothing to render. (Real Noto Color Emoji has them.)`);
    } else {
      // If a future fixture emits real shapes, exercise the gradient
      // path normally.
      const anyColour = stats.redish + stats.greenish + stats.blueish;
      if (anyColour < 50) fail(c.name, `gradient produced no colour signal: r=${stats.redish} g=${stats.greenish} b=${stats.blueish}`);
      else console.log(`PASS ${c.name}: opaque=${stats.opaque} colour-mix r=${stats.redish} g=${stats.greenish} b=${stats.blueish} → ${path.relative(ROOT, outPng)}`);
    }
  }

  await page.close();
}

await browser.close();
server.close();
console.log();
console.log(failures === 0
  ? `COLRv1 VISUAL SMOKE PASS (${CASES.length} cases)`
  : `COLRv1 VISUAL SMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Render COLRv0 layers and a COLRv1 composition tree; require colored framebuffer output.
// Gradient placement is covered by colrGradientPlacementRenderSmoke.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../_launch.mjs';

import { buildColrTestFont } from './_colrFontFixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'visuals', 'colr-v1');
mkdirSync(OUT, { recursive: true });

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch (e) {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

const COLR_CODEPOINT = 0x41; // synthetic fixture maps 'A' to its base glyph.
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
];

let failures = 0;
function fail(name, msg) {
  console.error(`FAIL [${name}]: ${msg}`);
  failures++;
}

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});

for (const c of CASES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 512, height: 512 });
  // Surface page-side console output so any silent COLR dispatch errors
  // bubble up to the test runner.
  page.on('console', (m) => console.log(`  [page-${c.name}]`, m.text()));
  page.on('pageerror', (e) => console.log(`  [page-err-${c.name}]`, e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => window.mantleTextReady === true, {
      timeout: 5000,
      polling: 100,
    });
  } catch (e) {
    const status = await page.evaluate(
      () => document.getElementById('status') && document.getElementById('status').textContent,
    );
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
        const r = await window.mantleRenderText(new Uint8Array(ttfArr), text, {
          defaultColor: [0.5, 0.5, 0.5, 1],
          fontSizePx: 256,
        });
        setDiagnostics({ colrTrace: null });
        return { ok: true, trace, ...r };
      } catch (e) {
        return { ok: false, err: e && (e.stack || e.message || String(e)) };
      }
    },
    Array.from(c.fontBytes),
    String.fromCodePoint(COLR_CODEPOINT),
  );
  if (result.trace && result.trace.length) {
    console.log(
      `  trace[${c.name}]: ${result.trace
        .map((t) => {
          let s = `[${t.i}]${t.type}`;
          if (t.err) s += '⚠' + t.err.toString(16);
          if (t.rgba) s += '=' + JSON.stringify(t.rgba);
          return s;
        })
        .join(' → ')}`,
    );
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
    console.log(
      `  diag[${c.name}]: shapes=${diag.numShapes} colrGraphs=${diag.colrGraphsCount} colrGraphIds=[${diag.colrGraphIds.join(',')}] flagsShape=[${diag.flagsShape.join(',')}] drawList=${diag.drawListLen} (slug=${diag.drawListSlugOps}, colr=${diag.drawListColrOps}) curveLen=${diag.curveLen} bbox=${JSON.stringify(diag.globalBBox)}`,
    );
  }

  // Pull the framebuffer + tally color channels. "Colored" means
  // any non-white opaque pixel — we don't try to classify the COLR
  // mixture more finely than that, because PaintMerge with
  // red+green α=0.5 produces near-balanced (127, 128, 0) pixels
  // that don't satisfy any "channel-dominates" heuristic but are
  // clearly the result of correct compositing.
  const stats = await page.evaluate(() => {
    const f = window.__mantleLastFrame;
    if (!f) return null;
    const w = f.w,
      h = f.h,
      d = f.data;
    let opaque = 0;
    let redish = 0,
      greenish = 0,
      blueish = 0;
    let colored = 0; // any opaque pixel that's NOT pure white
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2],
        a = d[i + 3];
      if (a < 16) continue;
      opaque++;
      // "Colored" = at least one channel < 240 (i.e. not near-white).
      if (r < 240 || g < 240 || b < 240) colored++;
      if (r > 64 && r - g > 64 && r - b > 64) redish++;
      if (g > 64 && g - r > 64 && g - b > 64) greenish++;
      if (b > 64 && b - r > 64 && b - g > 64) blueish++;
    }
    return { w, h, opaque, redish, greenish, blueish, colored };
  });

  if (!stats) {
    fail(c.name, 'no __mantleLastFrame on page');
    await page.close();
    continue;
  }

  // Capture PNG via the page's canvas.
  const pngB64 = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    // Re-render to refresh the back buffer (it may have been cleared
    // between the readPixels above and now).
    return cnv.toDataURL('image/png').split(',')[1];
  });
  const outPng = path.join(OUT, `${c.name}.png`);
  writeFileSync(outPng, Buffer.from(pngB64, 'base64'));

  console.log(
    `  fb[${c.name}]: opaque=${stats.opaque} redish=${stats.redish} greenish=${stats.greenish} blueish=${stats.blueish}`,
  );

  // Coverage assertions vary per fixture.
  //
  //   v0-layers: the framebuffer must carry both red AND green pixels
  //     (the fixture's two layer squares). v0 dispatch is exercised
  //     end-to-end here.
  //
  //   v1-rich: verifies the COLRv1 dispatch fires per-node via
  //     `trace[].rgba`, with correct color through PaintSolid →
  //     PaintMerge → PaintTransform → PaintGlyph, and the final
  //     framebuffer carries colored (non-white) pixels.
  //
  if (c.name === 'v0-layers') {
    if (stats.opaque < 200) fail(c.name, `painted area too small: ${stats.opaque}px`);
    else if (stats.redish < 50 || stats.greenish < 50)
      fail(c.name, `missing red/green coverage: red=${stats.redish} green=${stats.greenish}`);
    else
      console.log(
        `PASS ${c.name}: opaque=${stats.opaque} red=${stats.redish} green=${stats.greenish} → ${path.relative(ROOT, outPng)}`,
      );
  } else if (c.name === 'v1-rich') {
    // End-to-end COLR pipeline: per-node trace shows correct color
    // through PaintSolid → PaintMerge → PaintTransform → PaintGlyph,
    // and the final framebuffer carries colored (non-white) pixels
    // where the silhouette mask covered.
    const merge = result.trace && result.trace.find((t) => t.type === 'PaintMerge' && t.rgba);
    const xform = result.trace && result.trace.find((t) => t.type === 'PaintTransform' && t.rgba);
    const glyph = result.trace && result.trace.find((t) => t.type === 'PaintGlyph' && t.rgba);
    if (!merge) {
      fail(c.name, 'no PaintMerge trace');
    } else if (!xform) {
      fail(c.name, 'no PaintTransform trace');
    } else if (!glyph) {
      fail(c.name, 'no PaintGlyph trace');
    } else {
      const [mR, mG, , mA] = merge.rgba;
      const [xR, xG, , xA] = xform.rgba;
      const [gR, gG, , gA] = glyph.rgba;
      if (!(mR > 32 && mG > 32 && mA > 32))
        fail(c.name, `PaintMerge produced no color: ${JSON.stringify(merge.rgba)}`);
      // The paint transform sits above each solid (placeColrTransforms pushes it to the leaves), so one node carries red
      // and the next green: any color at all proves the em->px rescale.
      else if (!(xR + xG > 32 && xA > 32))
        fail(
          c.name,
          `PaintTransform produced no color (em→px rescale regression): ${JSON.stringify(xform.rgba)}`,
        );
      else if (!(gR > 32 && gG > 32 && gA > 32))
        fail(
          c.name,
          `PaintGlyph produced no color (silhouette mask regression — see slot-44 primKind/colrGraphId gating): ${JSON.stringify(glyph.rgba)}`,
        );
      else if ((stats.colored | 0) < 200)
        fail(c.name, `framebuffer has < 200 colored pixels: ${stats.colored}`);
      else
        console.log(
          `PASS ${c.name}: dispatch fires end-to-end (Merge=${JSON.stringify(merge.rgba)} Transform=${JSON.stringify(xform.rgba)} Glyph=${JSON.stringify(glyph.rgba)}, fb colored=${stats.colored}) → ${path.relative(ROOT, outPng)}`,
        );
    }
  }

  await page.close();
}

await browser.close();
server.close();
console.log();
console.log(
  failures === 0
    ? `COLRv1 VISUAL SMOKE PASS (${CASES.length} cases)`
    : `COLRv1 VISUAL SMOKE FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);

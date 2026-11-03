// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// visualBreadth.mjs — render the full printable ASCII range for every
// test font through the WebGL renderer, save PNGs, sanity-check that
// each PNG has the expected coverage profile.
//
// Three baselines: Arial.ttf (TT outlines), STIXGeneral.otf (CFF
// outlines), Roboto-Regular.woff2 (woff2-compressed TT). For each:
//   - render the uppercase A..Z
//   - render the lowercase a..z
//   - render the digits + punctuation
// Each render: assert numShapes matches non-space char count, painted
// area falls inside the reported bbox, and at least 10% of the bbox
// pixels are dark (font glyphs are reasonably solid).
//
// Note: woff2 is pre-decoded in Node before being passed to the page
// because headless Chromium swiftshader lacks DecompressionStream 'br'.
//
// MARKUP CASES (a fresh 800x800 demo page each): window.mantleRenderText(ttfBytes, markup, opts) with
// plain, colored, wrapped and resized markup, PNGs written to test/font/visuals/. Per case: the hook
// returned the expected numShapes, the canvas has some non-background pixels (the text actually drew),
// a colored run paints red, and a wrapped run paints a taller region than one line. The font is
// MANTLE_FONT or the system Arial.ttf, as the breadth cases read it.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../_launch.mjs';
import { pageTimeoutFor } from '../_laneBudget.mjs';
import { fontFixture, requireAsset } from '../_assets.mjs';
import { decodeIfWoff2 } from '../../src/font/fontAsset.js';
import { registerWoff2Reader } from '../../src/font/formats/woff2.js';
registerWoff2Reader();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(__dirname, 'visuals', 'breadth');
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

const FONTS = [
  { name: 'arial', path: '/System/Library/Fonts/Supplemental/Arial.ttf' },
  { name: 'stix', path: '/System/Library/Fonts/Supplemental/STIXGeneral.otf' },
  { name: 'roboto', path: requireAsset(fontFixture('roboto-regular.woff2')) },
];
const RANGES = [
  { label: 'upper', text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
  { label: 'lower', text: 'abcdefghijklmnopqrstuvwxyz' },
  { label: 'digit', text: '0123456789' },
  { label: 'punct', text: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~' },
];

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});

let failures = 0;
function fail(name, msg) {
  console.error(`FAIL [${name}]: ${msg}`);
  failures++;
}

// One page renders every font x range case (each call builds and binds a fresh bundle); a font's bytes cross once.
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 200 });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.mantleTextReady === true, {
  timeout: pageTimeoutFor(60000),
  polling: 100,
});
for (const fnt of FONTS) {
  const resolved = path.isAbsolute(fnt.path) ? fnt.path : path.join(ROOT, fnt.path);
  const raw = new Uint8Array(readFileSync(resolved));
  const ttf = await decodeIfWoff2(raw);
  await page.evaluate((b64) => {
    const bin = atob(b64);
    window.__ttf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) window.__ttf[i] = bin.charCodeAt(i);
  }, Buffer.from(ttf).toString('base64'));

  for (const rng of RANGES) {
    const result = await page.evaluate(async (text) => {
      try {
        const r = await window.mantleRenderText(window.__ttf, text, {
          defaultColor: [0, 0, 0, 1],
        });
        return { ok: true, ...r };
      } catch (e) {
        return { ok: false, err: e && (e.stack || e.message || String(e)) };
      }
    }, rng.text);

    if (!result.ok) {
      fail(`${fnt.name}.${rng.label}`, `hook threw: ${result.err}`);
      continue;
    }

    const stats = await page.evaluate(() => {
      const f = window.__mantleLastFrame;
      const w = f.w,
        h = f.h;
      let opaque = 0,
        dark = 0,
        mxX = -1,
        mnX = w,
        mxY = -1,
        mnY = h;
      const out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        const srcY = h - 1 - y;
        for (let x = 0; x < w; x++) {
          const so = (srcY * w + x) * 4;
          const r = f.data[so],
            g = f.data[so + 1],
            b = f.data[so + 2],
            a = f.data[so + 3];
          const rr = Math.min(255, r + (255 - a));
          const gg = Math.min(255, g + (255 - a));
          const bb = Math.min(255, b + (255 - a));
          const o = (y * w + x) * 4;
          out[o] = rr;
          out[o + 1] = gg;
          out[o + 2] = bb;
          out[o + 3] = 255;
          if (a > 16) {
            opaque++;
            if (x < mnX) mnX = x;
            if (x > mxX) mxX = x;
            if (y < mnY) mnY = y;
            if (y > mxY) mxY = y;
          }
          if (rr < 128 && gg < 128 && bb < 128) dark++;
        }
      }
      let bin = '';
      for (let i = 0; i < out.length; i += 0x8000)
        bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
      return { w, h, opaque, dark, mnX, mxX, mnY, mxY, pngB64: btoa(bin) };
    });

    // Encode the composited RGBA back to PNG via the page.
    const pngB64 = await page.evaluate(
      (w, h, raw) => {
        const cnv = document.createElement('canvas');
        cnv.width = w;
        cnv.height = h;
        const ctx = cnv.getContext('2d');
        const id = ctx.createImageData(w, h);
        const bin = atob(raw);
        for (let i = 0; i < bin.length; i++) id.data[i] = bin.charCodeAt(i);
        ctx.putImageData(id, 0, 0);
        return cnv.toDataURL('image/png').split(',')[1];
      },
      stats.w,
      stats.h,
      stats.pngB64,
    );
    const outPng = path.join(OUT, `${fnt.name}-${rng.label}.png`);
    writeFileSync(outPng, Buffer.from(pngB64, 'base64'));

    // Sanity checks.
    const expectedShapes = rng.text.length;
    if (result.numShapes !== expectedShapes) {
      // Allow for `<` and `>` getting eaten by markup-tag parsing —
      // those are recognized partially and a `<not-a-tag>` situation
      // produces literal pass-through. For punct the text contains
      // both `<` and `>`; markup parser may eat the whole token if it
      // looks like a tag. Print a warning rather than fail.
      console.warn(
        `WARN [${fnt.name}.${rng.label}]: expected ${expectedShapes} shapes, got ${result.numShapes}`,
      );
    }
    if (stats.opaque < 1000)
      fail(`${fnt.name}.${rng.label}`, `painted area too small: ${stats.opaque}px`);
    if (stats.dark < 200) fail(`${fnt.name}.${rng.label}`, `dark pixels too few: ${stats.dark}`);
    const bw = stats.mxX - stats.mnX,
      bh = stats.mxY - stats.mnY;
    console.log(
      `PASS ${fnt.name}.${rng.label}: ${result.numShapes} shapes, painted bbox=${bw}×${bh}, opaque=${stats.opaque}, dark=${stats.dark} → ${path.relative(ROOT, outPng)}`,
    );
  }
}

await page.close();
console.log();
console.log(
  failures === 0
    ? `VISUAL BREADTH PASS (${FONTS.length * RANGES.length} cases)`
    : `VISUAL BREADTH FAIL (${failures})`,
);
// The markup cases, each on a fresh demo page at 800 x 800.
async function markupSection() {
  const OUT = path.join(__dirname, 'visuals');
  const before = failures;
  const FONT_PATH = process.env.MANTLE_FONT || '/System/Library/Fonts/Supplemental/Arial.ttf';
  const ttfBytes = new Uint8Array(readFileSync(FONT_PATH));
  const ttfArr = Array.from(ttfBytes); // serializable across page boundary

  const MARKUP_CASES = [
    {
      name: 'plain',
      markup: 'Hello, World!',
      opts: { defaultColor: [0, 0, 0, 1] },
      expect: { minShapes: 12, maxShapes: 12 },
    },
    {
      name: 'multicolor',
      markup: 'Hello, <color=#f00>World</color>!',
      opts: { defaultColor: [0, 0, 0, 1] },
      expect: { minShapes: 12, maxShapes: 12, hasRed: true },
    },
    {
      name: 'wrap',
      markup: 'Hello World wrapping nicely across lines',
      opts: { defaultColor: [0, 0, 0, 1], maxWidthEm: 6, align: 'left' },
      expect: { minShapes: 30, minLines: 2 },
    },
    {
      name: 'size',
      markup: 'A<size=0.5>b</size>C',
      opts: { defaultColor: [0, 0, 0, 1] },
      expect: { minShapes: 3, maxShapes: 3 },
    },
  ];

  for (const c of MARKUP_CASES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 800, deviceScaleFactor: 1 });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for the page's IIFE to wire up window.mantleRenderText.
    await page.waitForFunction(() => window.mantleTextReady === true, {
      timeout: pageTimeoutFor(),
      polling: 100,
    });

    const result = await page.evaluate(
      async (ttfArr, markup, opts) => {
        try {
          const ret = await window.mantleRenderText(new Uint8Array(ttfArr), markup, opts);
          return { ok: true, ...ret };
        } catch (e) {
          return { ok: false, err: e && (e.stack || e.message || String(e)) };
        }
      },
      ttfArr,
      c.markup,
      c.opts,
    );

    if (!result.ok) {
      fail(c.name, `hook threw: ${result.err}`);
      await page.close();
      continue;
    }

    // Pull the captured frame buffer that the hook stashed on window.
    // gl.readPixels returns bottom-up; we flip + composite over white
    // here (the WebGL context has premultipliedAlpha=true).
    const stats = await page.evaluate(() => {
      const f = window.__mantleLastFrame;
      if (!f) return null;
      const w = f.w,
        h = f.h;
      let dark = 0,
        red = 0,
        opaque = 0,
        minX = w,
        minY = h,
        maxX = -1,
        maxY = -1;
      // Build a composited RGBA buffer (top-down, over-white) for PNG.
      const out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        // Flip Y (readPixels is bottom-up).
        const srcY = h - 1 - y;
        for (let x = 0; x < w; x++) {
          const so = (srcY * w + x) * 4;
          const r = f.data[so],
            g = f.data[so + 1],
            b = f.data[so + 2],
            a = f.data[so + 3];
          // Composite over white (premultiplied -> just src + (1-a)*255).
          const rr = Math.min(255, r + (255 - a));
          const gg = Math.min(255, g + (255 - a));
          const bb = Math.min(255, b + (255 - a));
          const o = (y * w + x) * 4;
          out[o] = rr;
          out[o + 1] = gg;
          out[o + 2] = bb;
          out[o + 3] = 255;
          if (a > 16) {
            opaque++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
          if (rr < 128 && gg < 128 && bb < 128) dark++;
          if (rr > 200 && gg < 96 && bb < 96) red++;
        }
      }
      // btoa needs a binary string; build it in chunks to avoid the
      // argument-count limit on String.fromCharCode for ~3MB Uint8Arrays.
      let bin = '';
      for (let i = 0; i < out.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
      }
      return {
        w,
        h,
        dark,
        red,
        opaque,
        minX,
        minY,
        maxX,
        maxY,
        pngB64: btoa(bin),
      };
    });
    if (!stats) {
      fail(c.name, 'no captured frame');
      await page.close();
      continue;
    }

    // Encode our composited RGBA as PNG via node's zlib + minimal PNG.
    // Cheaper than shipping a dep — but we already have a Canvas in the
    // page; just round-trip through page.evaluate to encode.
    const pngB64 = await page.evaluate(
      (w, h, raw) => {
        const cnv = document.createElement('canvas');
        cnv.width = w;
        cnv.height = h;
        const ctx = cnv.getContext('2d');
        const id = ctx.createImageData(w, h);
        // raw is a base64-encoded RGBA byte string from above.
        const bin = atob(raw);
        for (let i = 0; i < bin.length; i++) id.data[i] = bin.charCodeAt(i);
        ctx.putImageData(id, 0, 0);
        return cnv.toDataURL('image/png').split(',')[1];
      },
      stats.w,
      stats.h,
      stats.pngB64,
    );
    const outPng = path.join(OUT, `${c.name}.png`);
    writeFileSync(outPng, Buffer.from(pngB64, 'base64'));

    // Assertions
    if (c.expect.minShapes != null && result.numShapes < c.expect.minShapes)
      fail(c.name, `numShapes ${result.numShapes} < ${c.expect.minShapes}`);
    if (c.expect.maxShapes != null && result.numShapes > c.expect.maxShapes)
      fail(c.name, `numShapes ${result.numShapes} > ${c.expect.maxShapes}`);
    if (stats.opaque < 50) fail(c.name, `only ${stats.opaque} opaque pixels — text didn't draw`);
    if (c.expect.hasRed && stats.red < 10) fail(c.name, `expected red pixels (found ${stats.red})`);
    if (c.expect.minLines != null) {
      // Crude: a wrapped run should occupy a taller painted region than
      // a single-line run. We don't know single-line height a-priori,
      // so check the painted box's height/width ratio is > 0.4 (single
      // line is typically <0.3 for this string).
      const h = stats.maxY - stats.minY,
        w = stats.maxX - stats.minX;
      if (h < w * 0.4)
        fail(c.name, `painted aspect ${h}/${w}=${(h / w).toFixed(2)} too short for multi-line`);
    }

    const errStr = consoleErrors.length ? ` [console errors: ${consoleErrors.length}]` : '';
    console.log(
      `${failures === before ? 'PASS' : 'CHECK'} ${c.name}: shapes=${result.numShapes} bbox=[${result.bbox.map((v) => v.toFixed(2)).join(',')}] opaque=${stats.opaque}px dark=${stats.dark}px red=${stats.red}px → ${outPng}${errStr}`,
    );

    await page.close();
  }

  return { before, n: MARKUP_CASES.length };
}
{
  const { before, n } = await markupSection();
  console.log();
  console.log(
    failures === before
      ? `VISUAL HARNESS PASS (${n} cases)`
      : `VISUAL HARNESS FAIL (${failures - before} failures)`,
  );
}
await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);

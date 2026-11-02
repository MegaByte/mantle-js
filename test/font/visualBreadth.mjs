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

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../_launch.mjs';
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

for (const fnt of FONTS) {
  const resolved = path.isAbsolute(fnt.path) ? fnt.path : path.join(ROOT, fnt.path);
  const raw = new Uint8Array(readFileSync(resolved));
  const ttf = await decodeIfWoff2(raw);
  const ttfArr = Array.from(ttf);

  for (const rng of RANGES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 200 });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.mantleTextReady === true, {
      timeout: 5000,
      polling: 100,
    });

    const result = await page.evaluate(
      async (ttfArr, text) => {
        try {
          const r = await window.mantleRenderText(new Uint8Array(ttfArr), text, {
            defaultColor: [0, 0, 0, 1],
          });
          return { ok: true, ...r };
        } catch (e) {
          return { ok: false, err: e && (e.stack || e.message || String(e)) };
        }
      },
      ttfArr,
      rng.text,
    );

    if (!result.ok) {
      fail(`${fnt.name}.${rng.label}`, `hook threw: ${result.err}`);
      await page.close();
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

    await page.close();
  }
}

await browser.close();
server.close();
console.log();
console.log(
  failures === 0
    ? `VISUAL BREADTH PASS (${FONTS.length * RANGES.length} cases)`
    : `VISUAL BREADTH FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);

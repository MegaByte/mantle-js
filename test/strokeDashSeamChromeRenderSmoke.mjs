// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDashSeamChromeRenderSmoke -- real glyph outlines, dashed, drawn by the GPU under importSvg({ compat: 'chrome' }) against Chrome. Chrome continues a dash
// that is on at both ends of a closed subpath through the seam; SVG 2 13.5.7 does not (the default, 'spec', is the oracle smokes' business).
//
// The Arial (or the repo's Roboto fixture) O, B and 8 outlines -- closed contours with holes, every contour a closed dashed subpath with its own
// seam -- stroked with dash patterns, caps and joins, 18 configurations. The reference is Chrome rasterizing the same SVG at 8x, each pixel the
// average of its 64 samples (the AA reference every render smoke here uses). HELD: at every STABLE interior pixel -- one whose 3 x 3 neighbourhood
// in the reference is uniform to within 2/255, so no edge, cap or antialiased ramp is near it -- the GPU's byte is within `TOL` of the reference's. A seam
// that breaks the pattern puts whole dashes in gaps and gaps in dashes there (up to 255/255).
//   node test/strokeDashSeamChromeRenderSmoke.mjs     SMOKE_SRC_DIR=<a src tree> to run another tree
import { readFileSync, existsSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.SMOKE_SRC_DIR || null;
const TOL = +(process.env.SEAM_CHROME_TOL || 16);
const fontPaths = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf'),
];
const fp = fontPaths.find((p) => existsSync(p));
if (!fp) {
  console.log('SKIP strokeDashSeamChromeRenderSmoke: no Arial/Roboto font file');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { MantleFontAsset } = await import('../src/font/fontAsset.js');
const { buildSvgTextGlyphs } = await import('../src/font/textRun.js');
const { segsToPathD } = await import('../src/svg/segment.js');
const font = new MantleFontAsset(new Uint8Array(readFileSync(fp)));
const GLYPH = {};
for (const ch of ['O', 'B', '8'])
  GLYPH[ch] = segsToPathD(buildSvgTextGlyphs(ch, font, 14, 88, 100).glyphs[0].segs, true);

const CONFIGS = [];
for (const ch of ['O', 'B', '8'])
  for (const [cap, join, dash, off] of [
    ['butt', 'miter', '7 4', 0],
    ['round', 'round', '9 5', 2.5],
    ['square', 'bevel', '5 3', 1],
    ['butt', 'round', '11 6', 4],
    ['round', 'miter', '6 6', 3],
    ['square', 'miter', '8 3', 0.5],
  ]) {
    CONFIGS.push({
      name: `${ch} ${cap}/${join} dash ${dash} offset ${off}`,
      svg:
        `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 100 100"><rect width="100" height="100" fill="white"/>` +
        `<path d="${GLYPH[ch]}" fill="none" stroke="black" stroke-width="2.4" stroke-linecap="${cap}" stroke-linejoin="${join}" stroke-dasharray="${dash}" stroke-dashoffset="${off}"/></svg>`,
    });
  }

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (svg) => {
  R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true, compat: 'chrome' }));
  if (R.prepareBundle) R.prepareBundle(b);
  R.setViewport(128, 128); gl.viewport(0, 0, 128, 128);
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(128 * 128 * 4);
  gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const SS = 8, W2 = 128 * SS;
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('width="128" height="128"', 'width="' + W2 + '" height="' + W2 + '"')); await img.decode();
  const c2 = document.createElement('canvas'); c2.width = W2; c2.height = W2;
  const ctx = c2.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W2, W2); ctx.drawImage(img, 0, 0, W2, W2);
  const big = ctx.getImageData(0, 0, W2, W2).data, ref = new Uint8ClampedArray(128 * 128 * 4);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) for (let ch = 0; ch < 4; ch++) {
    let s = 0; for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += big[((y * SS + j) * W2 + x * SS + i) * 4 + ch];
    ref[(y * 128 + x) * 4 + ch] = Math.round(s / (SS * SS));
  }
  const m = new Uint8Array(128 * 128 * 4);
  for (let y = 0; y < 128; y++) m.set(px.subarray((127 - y) * 128 * 4, (128 - y) * 128 * 4), y * 128 * 4);
  return { mantle: Array.from(m), chrome: Array.from(ref) };
};
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(
      readFileSync(
        SRC && p.startsWith('/src/') ? path.join(SRC, p.slice('/src/'.length)) : path.join(ROOT, p),
      ),
    );
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
let failures = 0,
  worstAll = 0;
for (const c of CONFIGS) {
  const r = await page.evaluate((s) => window.__case(s), c.svg);
  const g = (a, x, y) => a[(y * 128 + x) * 4]; // black on white: the red byte carries the ink
  let n = 0,
    worst = 0,
    over = 0,
    at = '';
  for (let y = 1; y < 127; y++)
    for (let x = 1; x < 127; x++) {
      const v = g(r.chrome, x, y);
      let stable = true;
      for (let j = -1; j <= 1 && stable; j++)
        for (let i = -1; i <= 1; i++)
          if (Math.abs(g(r.chrome, x + i, y + j) - v) > 2) {
            stable = false;
            break;
          }
      if (!stable) continue;
      n++;
      const d = Math.abs(g(r.mantle, x, y) - v);
      if (d > worst) {
        worst = d;
        at = `(${x},${y})`;
      }
      if (d > TOL) over++;
    }
  worstAll = Math.max(worstAll, worst);
  const line = `${c.name}: ${n} stable interior px, worst ${worst}/255 ${worst ? 'at ' + at : ''}, ${over} over ${TOL}`;
  if (over) {
    failures++;
    console.error('FAIL: ' + line);
  } else console.log('ok ' + line);
}
await browser.close();
server.close();
console.log(
  `\nworst stable-interior byte difference over ${CONFIGS.length} configurations: ${worstAll}/255`,
);
if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log(
  'strokeDashSeamChromeRenderSmoke: dashed glyph outlines agree with Chrome at stable interiors',
);

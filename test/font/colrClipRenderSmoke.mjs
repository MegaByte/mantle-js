// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrClipRenderSmoke -- the COLRv1 ClipList on the GPU. fontTools fonts (colrSpecClip.ttf, colrSpecClipVar.ttf), the
// reference is Chrome clipping the box outline by the ClipBox rectangle (canvas clip(), 8x supersampled and box-averaged),
// with the boxes and the way they nest/move taken from HarfBuzz's paint callbacks, not from Mantle's reader.
//   A  base glyph box (200,100)-(500,400)          B  box moves with PaintTranslate(100,-50) around the reference
//   C  no ClipBox (the whole box)                  D  own box and the referenced glyph's: both apply
//   E  glyph range record                          G  the referenced box rotates with PaintRotate(30)
//   V  ClipBox format 2 at wght = 1: (150,50)-(600,500)
// Default backend Metal; MANTLE_TEST_GL=swiftshader runs it in software.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FONTS = path.join(ROOT, 'test/fixtures/fonts');
const b64 = (n) => readFileSync(path.join(FONTS, n)).toString('base64');

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="64" height="64"></canvas>
<script type="module">
import * as M from '/src/index.js';
import { registerColorEmojiReaders } from '/src/font/color/index.js';
import { registerVariableFontReaders } from '/src/font/variations/index.js';
registerColorEmojiReaders(); registerVariableFontReaders();
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: true });
const shaders = await M.loadShaders(new URL('/src/shaders/', location.href).href);
const R = M.createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.fonts = {};
window.loadFont = (name, b64) => { window.fonts[name] = new M.MantleFontAsset(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); };
window.draw = async (font, ch, S, W, H, x, y, varCoords) => {
  cv.width = W; cv.height = H;
  const tb = await M.createTextBundle(gl, { font: window.fonts[font], text: ch, style: { fontSizePx: S, layoutWidthEm: 1, fill: [0, 0, 0, 1], ...(varCoords ? { varCoords } : {}) } });
  const b = tb.bundle, g = b.globalBBox;
  R.setViewport(W, H); R.beginFrame([1, 1, 1, 1]);
  const o = { dstRect: [x, y, g[2] * S, g[3] * S], clipToRect: false };
  R.drawBundle(b, o); R.endFrame();
  const dm = Array.from(R.bundleDrawMatrix(b, o));
  const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = new Uint8Array(W * H * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) for (let c = 0; c < 3; c++) out[(j * W + i) * 3 + c] = px[(((H - 1 - j) * W) + i) * 4 + c];
  return { px: Array.from(out), dm, baseline: b.runMetrics.baselineY };
};
// items: [{ pts, clip, rgb }] in bundle em; the clip polygon (or null) limits the fill.
window.refClipped = (items, dm, W, H, S) => {
  const c = document.createElement('canvas'); c.width = W * S; c.height = H * S; const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W * S, H * S); x.scale(S, S);
  x.transform(dm[0], dm[1], dm[3], dm[4], dm[6], dm[7]);
  const path = (pts) => { x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.closePath(); };
  for (const it of items) {
    x.save(); if (it.clip) { path(it.clip); x.clip('nonzero'); }
    x.fillStyle = 'rgb(' + it.rgb.join(',') + ')'; path(it.pts); x.fill('nonzero'); x.restore();
  }
  const d = x.getImageData(0, 0, W * S, H * S).data, out = new Uint8Array(W * H * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) for (let k = 0; k < 3; k++) { let s = 0; for (let b = 0; b < S; b++) for (let a = 0; a < S; a++) s += d[(((j * S + b) * W * S) + (i * S + a)) * 4 + k]; out[(j * W + i) * 3 + k] = Math.round(s / (S * S)); }
  return Array.from(out);
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
    res.end(readFileSync(path.join(ROOT, p)));
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
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 120000,
});
await page.waitForFunction('window.__ready === true', { timeout: 120000 });
for (const n of ['colrSpecClip', 'colrSpecClipVar'])
  await page.evaluate((k, d) => window.loadFont(k, d), n, b64(n + '.ttf'));

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const diff = (a, b) => {
  let s = 0,
    mx = 0,
    c8 = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    s += d;
    if (d > mx) mx = d;
    if (d > 8) c8++;
  }
  return { mean: s / a.length, max: mx, over8: c8 };
};

const rect = (x0, y0, x1, y1) => [
  [x0, y0],
  [x0, y1],
  [x1, y1],
  [x1, y0],
];
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const I = [1, 0, 0, 1, 0, 0];
const rad = (d) => (d * Math.PI) / 180;
const ROT30 = [Math.cos(rad(30)), Math.sin(rad(30)), -Math.sin(rad(30)), Math.cos(rad(30)), 0, 0];
const BOX = rect(100, 0, 700, 600);
const RED = [255, 0, 0],
  BLUE = [0, 102, 255],
  GREEN = [0, 179, 0];
// [font, glyph, [clip rectangles in font units, all applied], paint matrix of the box and the reference, rgb, varCoords]
const CELLS = {
  'A base glyph box': ['colrSpecClip', 'A', [[200, 100, 500, 400]], I, RED],
  'B box moves with the translate': [
    'colrSpecClip',
    'B',
    [[200, 100, 500, 400]],
    [1, 0, 0, 1, 100, -50],
    RED,
  ],
  'C no ClipBox (control)': ['colrSpecClip', 'C', [], I, BLUE],
  'D both boxes apply': [
    'colrSpecClip',
    'D',
    [
      [250, 150, 650, 500],
      [200, 100, 500, 400],
    ],
    I,
    RED,
  ],
  'E glyph range record': ['colrSpecClip', 'E', [[150, 50, 450, 350]], I, GREEN],
  'F glyph range record': ['colrSpecClip', 'F', [[150, 50, 450, 350]], I, RED],
  'G box rotates with the paint': ['colrSpecClip', 'G', [[200, 100, 500, 400]], ROT30, RED],
  'V ClipBox format 2, wght 1': [
    'colrSpecClipVar',
    'A',
    [[150, 50, 600, 500]],
    I,
    RED,
    { wght: 1 },
  ],
  'V ClipBox format 2, wght 0': [
    'colrSpecClipVar',
    'A',
    [[200, 100, 500, 400]],
    I,
    RED,
    { wght: 0 },
  ],
};
const S = 64,
  W = 112,
  H = 112,
  X0 = 8,
  Y0 = 8;
for (const [name, [font, ch, clips, M, rgb, vc]] of Object.entries(CELLS)) {
  const r = await page.evaluate(
    (f, c, s, w, h, x, y, v) => window.draw(f, c, s, w, h, x, y, v),
    font,
    ch,
    S,
    W,
    H,
    X0,
    Y0,
    vc || null,
  );
  const toEm = (p) => [p[0] / 1000, r.baseline - p[1] / 1000];
  // the clip boxes of a glyph reached through a transform move with it: M applies to every clip in the cell except D's outer box
  const moves = (i) => (ch === 'D' && i === 0 ? I : M);
  const items = [
    {
      pts: BOX.map((p) => toEm(apply(M, p))),
      clip: null,
      rgb,
    },
  ];
  // nested clips: draw the box clipped by the intersection (axis-aligned boxes; G rotates, one box)
  const polyClip =
    clips.length === 1 ? rect(...clips[0]).map((p) => toEm(apply(moves(0), p))) : null;
  if (clips.length === 1) items[0].clip = polyClip;
  else if (clips.length === 2) {
    // both axis-aligned and unmoved: intersect them
    const [a, b] = clips;
    items[0].clip = rect(
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
      Math.min(a[2], b[2]),
      Math.min(a[3], b[3]),
    ).map((p) => toEm(p));
  }
  const ref = await page.evaluate(
    (it, dm, w, h, c) => window.refClipped(it, dm, w, h, c),
    items,
    r.dm,
    W,
    H,
    8,
  );
  const d = diff(r.px, ref);
  if (d.mean > 0.25 || d.max > 40 || d.over8 > 40)
    fail(
      `${name}: mean ${d.mean.toFixed(3)} max ${d.max} over8 ${d.over8} against the clipped box`,
    );
  else ok(`${name}: mean ${d.mean.toFixed(3)} max ${d.max} over8 ${d.over8}`);
}
// sensitivity: the unclipped box is far from every clipped cell's reference (the control can fail)
{
  const r = await page.evaluate(() => window.draw('colrSpecClip', 'A', 64, 112, 112, 8, 8, null));
  const toEm = (p) => [p[0] / 1000, r.baseline - p[1] / 1000];
  const ref = await page.evaluate(
    (it, dm) => window.refClipped(it, dm, 112, 112, 8),
    [{ pts: BOX.map(toEm), clip: null, rgb: RED }],
    r.dm,
  );
  const d = diff(r.px, ref);
  if (!(d.mean > 2))
    fail(`sensitivity: the clipped A is within ${d.mean.toFixed(3)} of the UNclipped box`);
  else ok(`sensitivity: clipped A is ${d.mean.toFixed(2)} mean from the unclipped box`);
}

await browser.close();
server.close();
console.log(failures ? `colrClipRender FAIL (${failures})` : 'colrClipRender PASS');
process.exit(failures ? 1 : 0);

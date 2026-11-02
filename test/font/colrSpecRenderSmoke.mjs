// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrSpecRenderSmoke -- COLRv1 paint transforms, skews, clips and conical gradients, on
// the GPU, against controls that do not depend on Mantle:
//   * fonts written by fontTools (test/fixtures/fonts/colrSpec*.ttf, genColrSpecFonts.py), not by the hand-rolled fixture;
//   * the reference for a transformed glyph is Chrome rasterizing the transformed outline as a PATH (8x, box-averaged),
//     with the maps taken from the values handed to fontTools -- never Chrome's font renderer (which dilates small
//     glyphs on macOS) and never Mantle's reader;
//   * the reference for a two-point conical gradient is the analytic rule (largest t with a non-negative radius).
// Cells:
//   *    PaintTransform: identity, translate, scale, rotate 30, shear, flip, general, nested -- the glyph is the right shape
//   *    PaintSkew / PaintSkewAroundCenter, both axes -- and the opposite sign is far from the picture (the control is sensitive)
//   *    edges under a transform paint are as soft as plain text's (max error beside the plain control), at two sizes
//   *    the hit test and globalBBox follow the drawn pixels; the never-drawn base outline (a box) is not hit
//   *    no pixel is painted where the cone's mirror image falls, none is lost beside the apex
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
registerColorEmojiReaders();
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: true });
const shaders = await M.loadShaders(new URL('/src/shaders/', location.href).href);
const R = M.createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.M = M; window.R = R; window.fonts = {};
window.loadFont = (name, b64) => { window.fonts[name] = new M.MantleFontAsset(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); };
// Draw text 'ch' (font size S px, pen at (x, y) = top-left of the layout box) and return the pixels top-down, the
// bundle-em -> px map and the baseline.
window.draw = async (font, ch, S, W, H, x, y, tight = false) => {
  cv.width = W; cv.height = H;
  const tb = await M.createTextBundle(gl, { font: window.fonts[font], text: ch, style: { fontSizePx: S, ...(tight ? {} : { layoutWidthEm: 1 }), fill: [0, 0, 0, 1] } });
  const b = tb.bundle, g = b.globalBBox;
  R.setViewport(W, H); R.beginFrame([1, 1, 1, 1]);
  const o = { dstRect: [x, y, g[2] * S, g[3] * S], clipToRect: false };
  R.drawBundle(b, o); R.endFrame();
  const dm = Array.from(R.bundleDrawMatrix(b, o));
  const px = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = new Uint8Array(W * H * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) for (let c = 0; c < 3; c++) out[(j * W + i) * 3 + c] = px[(((H - 1 - j) * W) + i) * 4 + c];
  window.__tb = tb;
  return { px: Array.from(out), dm, baseline: b.runMetrics.baselineY, gbb: Array.from(g) };
};
// Chrome's reference: polygons (em coords of the bundle) filled under dm at SxS supersampling, box-averaged to 1x.
window.refPolys = (polys, dm, W, H, S, rgb) => {
  const c = document.createElement('canvas'); c.width = W * S; c.height = H * S; const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W * S, H * S); x.scale(S, S);
  x.transform(dm[0], dm[1], dm[3], dm[4], dm[6], dm[7]);
  x.fillStyle = 'rgb(' + rgb.join(',') + ')';
  for (const pts of polys) { x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]))); x.closePath(); x.fill('nonzero'); }
  const d = x.getImageData(0, 0, W * S, H * S).data, out = new Uint8Array(W * H * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) for (let k = 0; k < 3; k++) { let s = 0; for (let b = 0; b < S; b++) for (let a = 0; a < S; a++) s += d[(((j * S + b) * W * S) + (i * S + a)) * 4 + k]; out[(j * W + i) * 3 + k] = Math.round(s / (S * S)); }
  return Array.from(out);
};
// The hit test against the render: uniform-neighborhood pixels only.
window.hitVsRender = (px, W, H, dm) => {
  const b = window.__tb.bundle;
  const drawn = (x, y) => { const i = (y * W + x) * 3; return Math.min(px[i], px[i + 1], px[i + 2]) < 250; };
  let extra = 0, miss = 0, inside = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    let all = true, none = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (drawn(x + dx, y + dy)) none = false; else all = false; }
    const h = M.fillHitShape(b, x + 0.5, y + 0.5, { worldMatrix: new Float32Array(dm) }) >= 0;
    if (all) inside++;
    if (none && h) extra++;
    if (all && !h) miss++;
  }
  return { extra, miss, inside };
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
for (const n of ['colrSpecXf', 'colrSpecRadial'])
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

// ---- the L glyph of the fonts, font units (y up): the outline every Xf glyph paints
const L = [
  [100, 0],
  [100, 700],
  [250, 700],
  [250, 150],
  [600, 150],
  [600, 0],
];
const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const compose = (a, b) => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const T = (dx, dy) => [1, 0, 0, 1, dx, dy];
const aroundC = (m, cx, cy) => compose(compose(T(cx, cy), m), T(-cx, -cy));
const rad = (d) => (d * Math.PI) / 180;
const skewM = (xDeg, yDeg) => [1, Math.tan(rad(yDeg)), -Math.tan(rad(xDeg)), 1, 0, 0]; // fontTools Paint.getTransform: skew(-x, y)
const ROT = (d) => [Math.cos(rad(d)), Math.sin(rad(d)), -Math.sin(rad(d)), Math.cos(rad(d)), 0, 0];
const BLUE = [0, 102, 255];
// Glyph name -> [x, y] matrix in font units. Letters follow genColrSpecFonts.py.
const CELLS = {
  A: [1, 0, 0, 1, 0, 0],
  B: T(100, 50),
  C: [0.5, 0, 0, 0.5, 0, 0],
  D: [0.866, 0.5, -0.5, 0.866, 0, 0],
  E: [1, 0, 0.5, 1, 0, 0],
  F: [-1, 0, 0, 1, 700, 0],
  G: [0.8, 0.4, -0.3, 0.9, 100, 50],
  H: T(100, 50),
  I: [0.5, 0, 0, 0.8, 0, 0],
  J: skewM(20, 0),
  K: skewM(0, 20),
  M: aroundC(skewM(20, -10), 350, 350),
  N: aroundC(ROT(45), 350, 350),
  O: [1, 0, 0, 1, 0, 0],
  P: compose(T(200, 100), [0.5, 0, 0, 0.5, 0, 0]),
};
const S0 = 64,
  W0 = 96,
  H0 = 96,
  X0 = 8,
  Y0 = 8;
// One cell: render, then the reference polygon under the same bundle map.
async function cell(ch, matrix, S = S0, W = W0, H = H0, x = X0, y = Y0) {
  const r = await page.evaluate(
    (c, s, w, h, xx, yy) => window.draw('colrSpecXf', c, s, w, h, xx, yy),
    ch,
    S,
    W,
    H,
    x,
    y,
  );
  const poly = L.map((p) => {
    const q = apply(matrix, p);
    return [q[0] / 1000, r.baseline - q[1] / 1000];
  });
  const ref = await page.evaluate(
    (polys, dm, w, h, c) => window.refPolys(polys, dm, w, h, c, [0, 102, 255]),
    [poly],
    r.dm,
    W,
    H,
    Math.max(8, Math.ceil(264 / S)),
  );
  return { r, ref, d: diff(r.px, ref) };
}

// ---- a transformed glyph is the transformed outline, with edges as soft as plain text's
const plain = await cell('O', CELLS.O);
console.log(
  `control (plain PaintGlyph L): mean ${plain.d.mean.toFixed(3)} max ${plain.d.max} over8 ${plain.d.over8}`,
);
if (!(plain.d.max <= 12))
  fail(
    `the plain control is off its own reference (max ${plain.d.max}): the harness, not the renderer`,
  );
const names = {
  A: 'identity',
  B: 'translate',
  C: 'scale',
  D: 'rotate 30',
  E: 'shear x',
  F: 'flip',
  G: 'general',
  H: 'PaintTranslate',
  I: 'PaintScale',
  J: 'PaintSkew x20',
  K: 'PaintSkew y20',
  M: 'PaintSkewAroundCenter',
  N: 'PaintRotateAroundCenter 45',
  P: 'nested transforms',
};
for (const [ch, nm] of Object.entries(names)) {
  const c = await cell(ch, CELLS[ch]);
  const ink = c.r.px.reduce((n, v, i) => n + (i % 3 === 0 && v < 250 ? 1 : 0), 0);
  // max: AA-cell differences of the reference rasterizer; resampled edges read 51-77. over8: a handful of corner cells.
  if (ink < 100) fail(`${nm}: ${ink} px of ink (a blank or lost glyph)`);
  else if (c.d.mean > 0.25 || c.d.max > 22 || c.d.over8 > 20)
    fail(
      `${nm}: mean ${c.d.mean.toFixed(3)} max ${c.d.max} over8 ${c.d.over8} against the transformed outline`,
    );
  else ok(`${nm}: mean ${c.d.mean.toFixed(3)} max ${c.d.max} over8 ${c.d.over8} (ink ${ink} px)`);
}
// the opposite skew sign is a different picture, far beyond the match above
{
  const wrong = await cell('J', skewM(-20, 0));
  const right = await cell('J', CELLS.J);
  if (!(wrong.d.mean > 5 * right.d.mean && wrong.d.mean > 1))
    fail(
      `the sign control is not sensitive (right ${right.d.mean.toFixed(3)} vs wrong ${wrong.d.mean.toFixed(3)})`,
    );
  else
    ok(
      `PaintSkew sign: right ${right.d.mean.toFixed(3)} vs opposite sign ${wrong.d.mean.toFixed(3)} mean`,
    );
}
// edge softness at a second size and a large one: correct at any scale (an edge blur that is a fixed fraction of the target is not)
for (const [S, W, H] of [
  [24, 40, 40],
  [200, 240, 240],
]) {
  const p = await cell('O', CELLS.O, S, W, H, 8, 8),
    r = await cell('N', CELLS.N, S, W, H, 8, 8);
  if (r.d.max > Math.max(22, p.d.max + 12) || r.d.mean > 0.4)
    fail(
      `at ${S} px: rotated ${r.d.mean.toFixed(3)}/${r.d.max} vs plain ${p.d.mean.toFixed(3)}/${p.d.max}`,
    );
  else
    ok(
      `at ${S} px: RotateAroundCenter 45 mean ${r.d.mean.toFixed(3)} max ${r.d.max} (plain ${p.d.mean.toFixed(3)} / ${p.d.max})`,
    );
}

// ---- hit test and globalBBox follow the pixels; the base outline (a box nothing draws) is not hit
// The bundle is ink-tight here (no layout box), so globalBBox is the ink's own box.
for (const ch of ['A', 'B', 'C', 'D', 'G', 'H', 'I', 'J', 'M', 'N', 'P']) {
  const r = await page.evaluate((c) => window.draw('colrSpecXf', c, 48, 96, 96, 8, 8, true), ch);
  const h = await page.evaluate((px, dm) => window.hitVsRender(px, 96, 96, dm), r.px, r.dm);
  // the ink-tight box: ink pixels outside the bbox (+1 px of AA)
  const g = r.gbb,
    dm = r.dm;
  const toPx = (ex, ey) => [dm[0] * ex + dm[3] * ey + dm[6], dm[1] * ex + dm[4] * ey + dm[7]];
  const c0 = toPx(g[0], g[1]),
    c1 = toPx(g[0] + g[2], g[1] + g[3]);
  const x0 = Math.min(c0[0], c1[0]) - 1.5,
    x1 = Math.max(c0[0], c1[0]) + 1.5,
    y0 = Math.min(c0[1], c1[1]) - 1.5,
    y1 = Math.max(c0[1], c1[1]) + 1.5;
  let outside = 0;
  for (let j = 0; j < 96; j++)
    for (let i = 0; i < 96; i++) {
      const k = (j * 96 + i) * 3;
      if (
        Math.min(r.px[k], r.px[k + 1], r.px[k + 2]) < 245 &&
        (i < x0 || i > x1 || j < y0 || j > y1)
      )
        outside++;
    }
  if (h.inside < 30) fail(`${names[ch]}: only ${h.inside} fully-inked pixels (a blank glyph)`);
  else if (h.extra || h.miss || outside)
    fail(
      `${names[ch]}: hit-but-blank ${h.extra}, drawn-but-no-hit ${h.miss}, ink outside globalBBox ${outside}`,
    );
  else ok(`${names[ch]}: hit agrees with ${h.inside} inked px, bbox holds all ink`);
}

// ---- two-point conical radial gradients paint no mirror cone
// Analytic rule (canvas / Skia / COLRv1): the largest t with r(t) = r0 + t (r1 - r0) >= 0 solves |q - c(t)| = r(t); none = transparent.
const RADIAL = {
  A: [
    [400, 300, 40],
    [600, 300, 120],
  ],
  B: [
    [400, 300, 40],
    [600, 300, 120],
  ],
  C: [
    [400, 300, 40],
    [600, 300, 120],
  ], // apex at x = 300: a mirror cone 200 units wide
  D: [
    [300, 300, 0],
    [500, 300, 150],
  ],
  E: [
    [250, 300, 100],
    [500, 300, 20],
  ],
  F: [
    [300, 300, 50],
    [500, 300, 50],
  ],
  G: [
    [400, 300, 100],
    [450, 300, 300],
  ],
};
const solves = (q, [c0, c1]) => {
  const dx = c1[0] - c0[0],
    dy = c1[1] - c0[1],
    dr = c1[2] - c0[2],
    ex = q[0] - c0[0],
    ey = q[1] - c0[1];
  const A = dx * dx + dy * dy - dr * dr,
    B = -2 * (dx * ex + dy * ey + c0[2] * dr),
    C = ex * ex + ey * ey - c0[2] * c0[2];
  const cand = [];
  if (Math.abs(A) < 1e-9 * (dx * dx + dy * dy + dr * dr + 1)) {
    if (B !== 0) cand.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      cand.push((-B - s) / (2 * A), (-B + s) / (2 * A));
    }
  }
  return cand.some((t) => c0[2] + t * dr >= 0);
};
const names5 = {
  A: 'pad',
  B: 'repeat',
  C: 'reflect',
  D: 'r0=0 offset reflect',
  E: 'shrinking pad',
  F: 'equal radii pad',
  G: 'nested pad',
};
for (const [ch, circles] of Object.entries(RADIAL)) {
  const S = 120,
    W = 130,
    H = 130;
  const dr0 = circles[1][2] - circles[0][2],
    tApex = dr0 !== 0 ? -circles[0][2] / dr0 : 0;
  const apex = [
    circles[0][0] + tApex * (circles[1][0] - circles[0][0]),
    circles[0][1] + tApex * (circles[1][1] - circles[0][1]),
  ];
  const r = await page.evaluate(
    (c, s, w, h) => window.draw('colrSpecRadial', c, s, w, h, 5, 5),
    ch,
    S,
    W,
    H,
  );
  const ex = (X, Y) => {
    const dm = r.dm,
      det = dm[0] * dm[4] - dm[1] * dm[3];
    const ux = X - dm[6],
      uy = Y - dm[7];
    const e = [(dm[4] * ux - dm[3] * uy) / det, (-dm[1] * ux + dm[0] * uy) / det];
    return [e[0] * 1000, (r.baseline - e[1]) * 1000];
  };
  const painted = (i, j) => {
    const k = (j * W + i) * 3;
    return Math.min(r.px[k], r.px[k + 1], r.px[k + 2]) < 200;
  };
  let wrongPaint = 0,
    lost = 0,
    certainBlank = 0,
    certainPaint = 0;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const q = ex(i + 0.5, j + 0.5);
      if (q[0] < 100 + 30 || q[0] > 700 - 30 || q[1] < 30 || q[1] > 600 - 30) continue; // inside the glyph box, clear of its AA edge
      if (Math.hypot(q[0] - apex[0], q[1] - apex[1]) < (2 * 1000) / S) continue; // within ~2 px of the cone's apex, narrower than a pixel
      // certain: the rule agrees at the pixel center and at four points 0.45 px away (the cone edge is anti-aliased)
      const pts = [
        [0, 0],
        [0.45, 0],
        [-0.45, 0],
        [0, 0.45],
        [0, -0.45],
      ].map(([a, b]) => solves(ex(i + 0.5 + a, j + 0.5 + b), circles));
      if (!pts.every((v) => v === pts[0])) continue;
      if (pts[0]) {
        certainPaint++;
        if (!painted(i, j)) lost++;
      } else {
        certainBlank++;
        if (painted(i, j)) wrongPaint++;
      }
    }
  if (certainPaint < 50)
    fail(`${names5[ch]}: the cell paints ${certainPaint} certain px (a blank glyph)`);
  else if (wrongPaint || lost)
    fail(
      `${names5[ch]}: ${wrongPaint} px painted where the rule leaves nothing, ${lost} lost where it paints (of ${certainBlank} blank / ${certainPaint} painted)`,
    );
  else
    ok(
      `${names5[ch]}: matches the analytic cone on ${certainPaint} painted and ${certainBlank} blank px`,
    );
}
// the cells that have a mirror cone must really exercise it
{
  const r = await page.evaluate(() => window.draw('colrSpecRadial', 'D', 120, 130, 130, 5, 5));
  if (!r.px.length) fail('conical gradient sanity');
}

await browser.close();
server.close();
console.log(failures ? `colrSpecRender FAIL (${failures})` : 'colrSpecRender PASS');
process.exit(failures ? 1 : 0);

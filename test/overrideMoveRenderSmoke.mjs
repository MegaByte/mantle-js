// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// overrideMoveRenderSmoke — a row an override moves, rotates or scales is DRAWN where the override puts it, with its
// clip-path and mask moving with it, on every route, against Chrome.
//
// A per-shape override (createOverrideTable: localPosition / localRotation / localScale) is an affine in em space,
// composed before the draw's own map: the element's `transform`, as the native fallback writes it. A vertex stage that
// moves the row's quad or mesh and then samples its curves at the MOVED point, where they are not, draws a moved row
// nowhere, on every route. The CPU
// proof through the real shader texts, and the hit test against it, is test/overrideMoveSmoke.mjs.
//
// Fifteen targets, each authored in a HOME cell on the left and moved by its override into its own cell on the right:
// five cases (a filled curve, a stroked curve, a rect cut by a clip-path, a rect under a one-child mask, a rect under
// a two-child mask, which the renderer bakes when it can) under three overrides (a translation; a 30-degree rotation;
// a (1.4, 0.7) scale). The reference is Chrome rasterizing the same targets authored in <g transform="..."> at their
// destinations, at 8x, each pixel the average of its 64 samples. Nothing may remain at home.
//
// Routes: the classic cover pass with Slug and with AAC, the unified Loop-Blinn route, CPatch, and 'auto'. A moved row
// takes its cover quad on the unified routes (its footprint is read from its own frame), so each route is asked.
// WHAT IS HELD: the INK. A pixel whose ink differs from the reference's by more than half is on the wrong side of an
// outline; at most 3 per override row. Sampled at the moved point, every moved target would be missing. REPORTED, NOT HELD: pixels off by
// more than 32/255.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CELL = 80,
  NC = 5,
  NR = 3,
  W = 2 * NC * CELL,
  H = NR * CELL;
// Each case: (k, cx, cy) -> [defs, element], the element centered on (cx, cy) with ids suffixed k.
const BLOB = (cx, cy) =>
  `M${cx - 10} ${cy - 20} C${cx + 5} ${cy - 30} ${cx + 20} ${cy - 15} ${cx + 15} ${cy} C${cx + 10} ${cy + 15} ${cx - 10} ${cy + 10} ${cx - 15} ${cy} Z`;
const CASES = [
  (k, cx, cy) => ['', `<path id="t${k}" d="${BLOB(cx, cy)}" fill="#000"/>`],
  (k, cx, cy) => [
    '',
    `<path id="t${k}" d="${BLOB(cx, cy)}" fill="none" stroke="#000" stroke-width="4"/>`,
  ],
  (k, cx, cy) => [
    `<clipPath id="c${k}" clipPathUnits="userSpaceOnUse"><circle cx="${cx}" cy="${cy}" r="18"/></clipPath>`,
    `<rect id="t${k}" x="${cx - 22}" y="${cy - 14}" width="44" height="28" fill="#000" clip-path="url(#c${k})"/>`,
  ],
  (k, cx, cy) => [
    `<mask id="m${k}"><circle cx="${cx}" cy="${cy}" r="18" fill="#fff"/></mask>`,
    `<rect id="t${k}" x="${cx - 22}" y="${cy - 14}" width="44" height="28" fill="#000" mask="url(#m${k})"/>`,
  ],
  (k, cx, cy) => [
    `<mask id="m${k}"><rect x="${cx - 22}" y="${cy - 14}" width="44" height="28" fill="#fff"/><circle cx="${cx - 6}" cy="${cy}" r="9" fill="#000"/></mask>`,
    `<rect id="t${k}" x="${cx - 22}" y="${cy - 14}" width="44" height="28" fill="#000" mask="url(#m${k})"/>`,
  ],
];
// Override rows: the linear part; the translation is solved so the home center lands on the destination center.
const ROWS = [
  { name: 'translated', rot: 0, sx: 1, sy: 1 },
  { name: 'rotated 30 degrees', rot: Math.PI / 6, sx: 1, sy: 1 },
  { name: 'scaled (1.4, 0.7)', rot: 0, sx: 1.4, sy: 0.7 },
];
const targets = [];
let defsM = '',
  bodyM = '',
  defsR = '',
  bodyR = '';
ROWS.forEach((row, r) =>
  CASES.forEach((mk, c) => {
    const k = r * NC + c,
      hx = CELL * c + CELL / 2,
      hy = CELL * r + CELL / 2,
      dx = W / 2 + hx,
      dy = hy;
    const cs = Math.cos(row.rot),
      sn = Math.sin(row.rot);
    // M = R(rot) S(scale) (overrides.js writeShape), t = d - M h
    const m00 = cs * row.sx,
      m01 = -sn * row.sy,
      m10 = sn * row.sx,
      m11 = cs * row.sy;
    const tx = dx - (m00 * hx + m01 * hy),
      ty = dy - (m10 * hx + m11 * hy);
    const [d, e] = mk(k, hx, hy);
    defsM += d;
    bodyM += e;
    defsR += d;
    bodyR += `<g transform="matrix(${m00} ${m10} ${m01} ${m11} ${tx} ${ty})">${e}</g>`;
    targets.push({
      id: `t${k}`,
      o: { localPosition: [tx, ty], localRotation: row.rot, localScale: [row.sx, row.sy] },
    });
  }),
);
// Corner dots pin the content box to the canvas, so em -> px is the viewBox mapping.
const DOTS = `<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/><rect x="${W - 0.5}" y="${H - 0.5}" width="0.5" height="0.5" fill="#000"/>`;
const svgOf = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${DOTS}${body}</svg>`;
const SVG_M = svgOf(defsM, bodyM),
  SVG_R = svgOf(defsR, bodyR);

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
window.addEventListener('error', (e) => { window.__err = String(e.message || e); window.__ready = true; });
window.addEventListener('unhandledrejection', (e) => { window.__err = String(e.reason && e.reason.stack || e.reason); window.__ready = true; });
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const TARGETS = ${JSON.stringify(targets)};
// Pixels cross to node as base64 rather than as a JSON array of numbers.
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
window.__case = async (svg, route, kernel) => {
  R.setFillEngine({ route, kernel });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  const ov = createOverrideTable(gl, b);
  // Every row a target imported as: a stroked path's row is named '<id>_stroke', a split one's '<id>_fill' too.
  const ids = b.shapeIds || [];
  let set = 0;
  for (const t of TARGETS) {
    let n = 0;
    for (const id of new Set(ids)) if ((id === t.id || id.startsWith(t.id + '_')) && ov.set(id, t.o)) n++;
    if (n > 0) set++;
  }
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady && route !== 'none') { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${W}, ${H}); gl.viewport(0, 0, ${W}, ${H});
  // TIMERS, not requestAnimationFrame: a headless page under GPU pressure stops running rAF.
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b, { overrides: ov }); R.endFrame(); await new Promise((q) => setTimeout(q, 16)); }
  const px = new Uint8Array(${W} * ${H} * 4);
  gl.readPixels(0, 0, ${W}, ${H}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  ov.dispose && ov.dispose(); b.dispose && b.dispose();
  const m = new Uint8Array(${W} * ${H} * 4);
  for (let y = 0; y < ${H}; y++) m.set(px.subarray((${H} - 1 - y) * ${W} * 4, (${H} - y) * ${W} * 4), y * ${W} * 4);
  return { mantle: b64(m), set };
};
// THE REFERENCE IS BOX-FILTERED: Chrome rasterizes the SVG at 8x and each pixel averages its 64 samples.
window.__ref = async (svg) => {
  const SS = 8, W2 = ${W} * SS, H2 = ${H} * SS;
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('width="${W}" height="${H}"', 'width="' + W2 + '" height="' + H2 + '"')); await img.decode();
  const c2 = document.createElement('canvas'); c2.width = W2; c2.height = H2;
  const ctx = c2.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W2, H2); ctx.drawImage(img, 0, 0, W2, H2);
  const big = ctx.getImageData(0, 0, W2, H2).data, ref = new Uint8ClampedArray(${W} * ${H} * 4);
  for (let y = 0; y < ${H}; y++) for (let x = 0; x < ${W}; x++) for (let ch = 0; ch < 4; ch++) {
    let s = 0; for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += big[((y * SS + j) * W2 + x * SS + i) * 4 + ch];
    ref[(y * ${W} + x) * 4 + ch] = Math.round(s / (SS * SS));
  }
  return b64(ref);
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
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  const err0 = await page.evaluate(() => window.__err || null);
  if (err0) throw new Error(`page script: ${err0}`);
  const u8 = (b) => new Uint8Array(Buffer.from(b, 'base64'));
  const chrome = u8(await page.evaluate((s) => window.__ref(s), SVG_R));
  const WRONG_INK_MAX = 3; // per override row, across its cases
  for (const [route, kernel] of [
    ['none', 'slug'],
    ['none', 'aac'],
    ['lb', 'slug'],
    ['cpatch', 'slug'],
    ['auto', 'slug'],
  ]) {
    const o = await page.evaluate((s, r, k) => window.__case(s, r, k), SVG_M, route, kernel);
    o.mantle = u8(o.mantle);
    if (o.set !== targets.length)
      fail(`route ${route}/${kernel}: the table resolved ${o.set} of ${targets.length} target ids`);
    const rows = ROWS.map(() => ({ wrong: 0, over32: 0, ink: 0, home: 0, ex: [] }));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if ((x < 2 && y < 2) || (x >= W - 2 && y >= H - 2)) continue; // the pinning dots
        const i = (y * W + x) * 4,
          row = rows[Math.min(NR - 1, Math.floor(y / CELL))];
        const lm = (o.mantle[i] + o.mantle[i + 1] + o.mantle[i + 2]) / 765,
          lc = (chrome[i] + chrome[i + 1] + chrome[i + 2]) / 765;
        const d = Math.max(
          Math.abs(o.mantle[i] - chrome[i]),
          Math.abs(o.mantle[i + 1] - chrome[i + 1]),
          Math.abs(o.mantle[i + 2] - chrome[i + 2]),
        );
        if (lc < 0.5) row.ink++;
        if (x < W / 2 && lm < 0.5) row.home++;
        if (d > 32) row.over32++;
        if (Math.abs(lm - lc) > 0.5) {
          row.wrong++;
          if (row.ex.length < 3)
            row.ex.push(`(${x},${y}) ink ${(1 - lm).toFixed(2)} for ${(1 - lc).toFixed(2)}`);
        }
      }
    ROWS.forEach((rw, r) => {
      const e = rows[r];
      const line =
        `route ${route}/${kernel}, ${rw.name}: ${e.wrong} px on the wrong side of an outline of ${e.ink} inked, ` +
        `${e.home} inked px left at home; ${e.over32} px off by more than 32/255`;
      if (e.ink > 1500 && e.wrong <= WRONG_INK_MAX && e.home === 0) ok(line);
      else fail(line + (e.ex.length ? ' -- ' + e.ex.join('; ') : ''));
    });
  }
} finally {
  await browser.close();
  server.close();
}
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\noverrideMoveRenderSmoke: an override-moved row is drawn where it went, with its clip and mask, on every route',
);

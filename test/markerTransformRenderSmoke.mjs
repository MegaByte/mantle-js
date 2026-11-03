// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// markerTransformRenderSmoke — markers are placed in their path's own space and transformed with the path, on the GPU,
// against Chrome (the CPU proof is test/markerTransformSmoke.mjs).
//
// Three paths with markers under six carriers, one per row: two CONFORMAL rows, rotate(30) scale(2) and the reflection
// scale(-2 2), then scale(2 1.5), skewX(30), rotate(30) scale(3 1) and scale(-2 1.5) rotate(20). The columns:
//   1. an unstroked polyline, markerUnits="strokeWidth": a stroked ring at the start and the middle vertex, an
//      asymmetric filled arrow at the end, orient="auto";
//   2. a stroked cubic, orient="auto-start-reverse" arrows at both ends, markerUnits="userSpaceOnUse";
//   3. an unstroked triangle, a stroked square at every vertex, a FIXED orient="30".
// The reference is Chrome rasterizing the same SVG at 8x, each pixel the average of its 64 samples (the AA reference
// every render smoke here uses).
//
// WHAT IS HELD: the INK. Black on white, a pixel's ink is 1 - its luminance; one whose ink differs from the reference's
// by more than half is on the wrong side of an outline. Every row fails for markers placed on the document-space path
// with the CTM's mean scale (undistorted, turned to the transformed tangent, never mirrored), or for a marker child's
// stroke-width -- in marker units -- left at its authored width (the rings draw twice as wide, even on the conformal
// rows). REPORTED, NOT HELD: pixels off by more than 32/255.
//
// VIEWBOX FIT (own page): a marker's viewBox is fitted into its viewport by preserveAspectRatio, on the GPU, against
// Chrome (the CPU proof is test/markerAspectSmoke.mjs).
//
// An asymmetric filled arrow in a viewBox 0 0 10 20, fitted into a 30 x 30 viewport six ways, one per column: the
// default ("xMidYMid meet"), "xMinYMin meet", "xMaxYMax meet", "none", "xMidYMid slice" (an arrow inside the band a
// slice shows, so Chrome's overflow clip takes nothing), and no viewBox at all (the content in the viewport's own
// units); plain, and under rotate(30) scale(2). The reference is Chrome rasterizing the same SVG at 8x, each pixel the
// average of its 64 samples.
//
// WHAT IS HELD: the INK. A pixel whose ink differs from the reference's by more than half is on the wrong side of an
// outline. Scaling each axis on its own would stretch the meet and slice columns, and a "0 0 3 3" stand-in viewBox would draw
// the no-viewBox column ten times too big; the "none" column is the control. REPORTED, NOT HELD: pixels off by more than 32/255.
//
// THE PATH'S CLIP AND MASK (own page): a marker takes the referencing path's clip-path and mask, on the GPU, against Chrome
// (the CPU proof is test/markerClipMaskSmoke.mjs).
//
// Six columns, one per case, each a path that paints nothing with a 16 x 16 square marker on each of its three
// vertices: a userSpaceOnUse clip on the path; the same with marker content that overflows its viewport (the viewport
// clip AND the path's clip); an objectBoundingBox clip (the PATH's box, not the marker's); a clip on the enclosing
// group; a luminance mask on the path; an objectBoundingBox mask. Plain, and under scale(1.5 1.2) rotate(15). The
// reference is Chrome rasterizing the same SVG at 8x, each pixel the average of its 64 samples.
//
// WHAT IS HELD: the INK. A pixel whose ink differs from the reference's by more than half is on the wrong side of an
// outline; at most 3 per row. Without the path's clip and mask every column would draw every marker whole. REPORTED, NOT HELD: pixels off by
// more than 32/255.
//
// VIEWPORT CLIP (own page): a marker's content is clipped to its viewport unless its overflow is visible, on the
// GPU, against Chrome (the CPU proof is test/markerViewportClipSmoke.mjs).
//
// Seven markers, one per column, each with content that overflows its viewport: a disc overflowing a 0 0 10 10 viewBox
// (overflow hidden, the initial value); the same with overflow="visible" (the control: Chrome draws it whole); a wide
// rect under the default "xMidYMid meet" of a 0 0 10 20 viewBox in a 30 x 30 viewport (the clip reaches past the
// viewBox on x); the same under "xMidYMid slice" (a band of the viewBox); no viewBox (a 6 x 4 viewport); a stroked
// square whose stroke reaches out of the viewBox; and orient="auto" on a diagonal with markerUnits="strokeWidth".
// Plain, and under scale(2 1.5) rotate(20) (the marker transformed with its path). The reference is Chrome
// rasterizing the same SVG at 8x, each pixel the average of its 64 samples.
//
// WHAT IS HELD: the INK. A pixel whose ink differs from the reference's by more than half is on the wrong side of an
// outline; at most 3 per row. Without the viewport clip every clipped column would draw its overflow. REPORTED, NOT HELD: pixels off by
// more than 32/255.
//
// Each set draws on its own page (its own canvas size; the clip sets ask for a stencil and depth buffer); the sets share
// the scoring below.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One set's page: a W x H canvas; `ctx` adds context attributes.
const htmlFor = (
  W,
  H,
  ctx = '',
) => `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true${ctx} });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (svg, route) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${W}, ${H}); gl.viewport(0, 0, ${W}, ${H});
  for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(${W} * ${H} * 4);
  gl.readPixels(0, 0, ${W}, ${H}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  // THE REFERENCE IS BOX-FILTERED: Chrome rasterizes the SVG at 8x and each pixel averages its 64 samples.
  const SS = 8, W2 = ${W} * SS, H2 = ${H} * SS;
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('width="${W}" height="${H}"', 'width="' + W2 + '" height="' + H2 + '"')); await img.decode();
  const c2 = document.createElement('canvas'); c2.width = W2; c2.height = H2;
  const ctx = c2.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W2, H2); ctx.drawImage(img, 0, 0, W2, H2);
  const big = ctx.getImageData(0, 0, W2, H2).data, ref = new Uint8ClampedArray(${W} * ${H} * 4);
  for (let y = 0; y < ${H}; y++) for (let x = 0; x < ${W}; x++) for (let ch = 0; ch < 4; ch++) {
    let s = 0; for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += big[((y * SS + j) * W2 + x * SS + i) * 4 + ch];
    ref[(y * ${W} + x) * 4 + ch] = Math.round(s / (SS * SS));
  }
  const m = new Uint8Array(${W} * ${H} * 4);
  for (let y = 0; y < ${H}; y++) m.set(px.subarray((${H} - 1 - y) * ${W} * 4, (${H} - y) * ${W} * 4), y * ${W} * 4);
  return { mantle: Array.from(m), chrome: Array.from(ref) };
};
window.__ready = true;
</script></body></html>`;

const TRANSFORM = (() => {
  const CELL = 104,
    CARRIERS = [
      'rotate(30) scale(2)',
      'scale(-2 2)',
      'scale(2 1.5)',
      'skewX(30)',
      'rotate(30) scale(3 1)',
      'scale(-2 1.5) rotate(20)',
    ];
  const W = 3 * CELL,
    H = CARRIERS.length * CELL;

  // Each column's content is in local coordinates about its origin, within 14 units, so the widest carrier (x3) keeps it
  // inside its 104 px cell.
  const DEFS =
    '<defs>' +
    // an asymmetric arrow (a reflection shows) and a ring whose stroke is in marker units
    '<marker id="arr" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L10 2 L6 5 L10 9 L1 10 Z" fill="#000"/></marker>' +
    '<marker id="ring" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="2.5" markerHeight="2.5" orient="auto"><circle cx="5" cy="5" r="4" fill="none" stroke="#000" stroke-width="3"/></marker>' +
    '<marker id="rev" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0 L10 2 L6 5 L10 9 L1 10 Z" fill="#000"/></marker>' +
    '<marker id="sq" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="30"><rect x="2" y="2" width="6" height="6" fill="none" stroke="#000" stroke-width="2" stroke-linejoin="miter"/></marker>' +
    '</defs>';
  const COLUMNS = [
    '<path d="M-12 -5 L0 6 L12 -5" fill="none" stroke="none" stroke-width="2" marker-start="url(#ring)" marker-mid="url(#ring)" marker-end="url(#arr)"/>',
    '<path d="M-10 8 C-5 -14 5 14 10 -8" fill="none" stroke="#000" stroke-width="1.5" marker-start="url(#rev)" marker-end="url(#rev)"/>',
    '<polygon points="-10,-8 10,-8 0,10" fill="none" stroke="none" marker-start="url(#sq)" marker-mid="url(#sq)" marker-end="url(#sq)"/>',
  ];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    DEFS +
    CARRIERS.map((t, r) =>
      COLUMNS.map(
        (el, c) =>
          `<g transform="translate(${CELL * c + CELL / 2} ${CELL * r + CELL / 2}) ${t}">${el}</g>`,
      ).join(''),
    ).join('') +
    '</svg>';

  return {
    CELL,
    CARRIERS,
    W,
    H,
    svg,
    inkMin: 300,
    dots: false,
    ctx: '',
    what: (t, r) => (r < 2 ? `${t} (conformal)` : t),
  };
})();
const ASPECT = (() => {
  const CELL = 104,
    CARRIERS = ['', 'rotate(30) scale(2)'];
  const W = 6 * CELL,
    H = CARRIERS.length * CELL;

  const ARROW = 'M1 2 L9 6 L5 9 L9 16 L2 18 Z',
    ARROW_BAND = 'M1 6 L9 8 L5 10 L9 13 L2 14 Z';
  const FITS = [
    ['', ARROW],
    ['preserveAspectRatio="xMinYMin meet"', ARROW],
    ['preserveAspectRatio="xMaxYMax meet"', ARROW],
    ['preserveAspectRatio="none"', ARROW],
    ['preserveAspectRatio="xMidYMid slice"', ARROW_BAND],
    [null, ARROW],
  ];
  const DEFS =
    '<defs>' +
    FITS.map(
      ([par, d], i) =>
        `<marker id="m${i}" ${par === null ? '' : 'viewBox="0 0 10 20" ' + par}` +
        ` refX="2" refY="10" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0"><path d="${d}" fill="#000"/></marker>`,
    ).join('') +
    '</defs>';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    DEFS +
    CARRIERS.map((t, r) =>
      FITS.map(
        (_, c) =>
          `<g transform="translate(${CELL * c + 30} ${CELL * r + CELL / 2}) ${t}">` +
          `<path d="M-20 0 L0 0" fill="none" stroke="none" marker-end="url(#m${c})"/></g>`,
      ).join(''),
    ).join('') +
    '</svg>';

  return {
    CELL,
    CARRIERS,
    W,
    H,
    svg,
    inkMin: 1000,
    dots: false,
    ctx: '',
    what: (t) => t || 'plain',
  };
})();
const CLIP_MASK = (() => {
  const CELL = 110,
    CARRIERS = ['', 'scale(1.5 1.2) rotate(15)'];
  // The path (cell-local) and its vertices' markers: 16 x 16 squares centered on each vertex.
  const D = 'M-30 -20 L0 10 L30 20';
  const SQ = (id, big) =>
    `<marker id="${id}" refX="8" refY="8" markerWidth="16" markerHeight="16" markerUnits="userSpaceOnUse" orient="0">` +
    (big
      ? '<path d="M-8 -8 H24 V24 H-8 Z" fill="#000"/>'
      : '<path d="M0 0 H16 V16 H0 Z" fill="#000"/>') +
    '</marker>';
  // [defs for column c (ids suffixed with c), the path's attributes, wrap the path in a clipped group]
  const CASES = [
    [
      (c) =>
        SQ(`m${c}`) +
        `<clipPath id="c${c}"><rect x="-60" y="-60" width="65" height="120"/></clipPath>`,
      (c) => `clip-path="url(#c${c})"`,
      false,
    ],
    [
      (c) =>
        SQ(`m${c}`, true) +
        `<clipPath id="c${c}"><rect x="-60" y="-60" width="65" height="120"/></clipPath>`,
      (c) => `clip-path="url(#c${c})"`,
      false,
    ],
    [
      (c) =>
        SQ(`m${c}`) +
        `<clipPath id="c${c}" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1"/></clipPath>`,
      (c) => `clip-path="url(#c${c})"`,
      false,
    ],
    [
      (c) =>
        SQ(`m${c}`) +
        `<clipPath id="c${c}"><rect x="-6" y="-60" width="70" height="120"/></clipPath>`,
      () => '',
      true,
    ],
    [
      (c) =>
        SQ(`m${c}`) +
        `<mask id="k${c}"><rect x="-60" y="-60" width="120" height="75" fill="white"/></mask>`,
      (c) => `mask="url(#k${c})"`,
      false,
    ],
    [
      (c) =>
        SQ(`m${c}`) +
        `<mask id="k${c}" maskContentUnits="objectBoundingBox"><rect x="0.5" y="0" width="0.5" height="1" fill="white"/></mask>`,
      (c) => `mask="url(#k${c})"`,
      false,
    ],
  ];
  const W = CASES.length * CELL,
    H = CARRIERS.length * CELL;

  // Corner dots pin the content box to the canvas, so em -> px is the viewBox mapping whatever the clips take away.
  const DOTS = `<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/><rect x="${W - 0.5}" y="${H - 0.5}" width="0.5" height="0.5" fill="#000"/>`;
  let defs = '',
    cells = '';
  CARRIERS.forEach((t, r) =>
    CASES.forEach(([df, pa, grouped], c) => {
      const k = r * CASES.length + c;
      defs += df(k);
      const p = `<path d="${D}" fill="none" stroke="none" ${pa(k)} marker-start="url(#m${k})" marker-mid="url(#m${k})" marker-end="url(#m${k})"/>`;
      cells +=
        `<g transform="translate(${CELL * c + CELL / 2} ${CELL * r + CELL / 2}) ${t}">` +
        (grouped ? `<g clip-path="url(#c${k})">${p}</g>` : p) +
        '</g>';
    }),
  );
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>` +
    DOTS +
    cells +
    '</svg>';

  return {
    CELL,
    CARRIERS,
    W,
    H,
    svg,
    inkMin: 500,
    dots: true,
    ctx: ', stencil: true, depth: true',
    what: (t) => t || 'plain',
  };
})();
const VIEWPORT_CLIP = (() => {
  const CELL = 110,
    CARRIERS = ['', 'scale(2 1.5) rotate(20)'];
  const MARKERS = [
    // [marker attributes, content, the path's d and stroke-width]
    [
      'viewBox="0 0 10 10" refX="5" refY="5" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0"',
      '<circle cx="5" cy="5" r="8" fill="#000"/>',
      'M-20 0 L0 0',
      1,
    ],
    [
      'viewBox="0 0 10 10" refX="5" refY="5" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0" overflow="visible"',
      '<circle cx="5" cy="5" r="8" fill="#000"/>',
      'M-20 0 L0 0',
      1,
    ],
    [
      'viewBox="0 0 10 20" refX="5" refY="10" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0"',
      '<rect x="-9" y="3" width="28" height="14" fill="#000"/>',
      'M-20 0 L0 0',
      1,
    ],
    [
      'viewBox="0 0 10 20" preserveAspectRatio="xMidYMid slice" refX="5" refY="10" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0"',
      '<rect x="2" y="1" width="6" height="18" fill="#000"/>',
      'M-20 0 L0 0',
      1,
    ],
    [
      'refX="3" refY="2" markerWidth="6" markerHeight="4" markerUnits="userSpaceOnUse" orient="0"',
      '<rect x="-4" y="-6" width="14" height="16" fill="#000"/>',
      'M-20 0 L0 0',
      1,
    ],
    [
      'viewBox="0 0 10 10" refX="5" refY="5" markerWidth="30" markerHeight="30" markerUnits="userSpaceOnUse" orient="0"',
      '<rect x="1" y="1" width="8" height="8" fill="none" stroke="#000" stroke-width="3"/>',
      'M-20 0 L0 0',
      1,
    ],
    [
      'viewBox="0 0 10 10" refX="2" refY="5" markerWidth="8" markerHeight="8" markerUnits="strokeWidth" orient="auto"',
      '<path d="M-3 -2 L12 5 L-3 12 Z" fill="#000"/>',
      'M-25 -18 L0 0',
      3,
    ],
  ];
  const W = MARKERS.length * CELL,
    H = CARRIERS.length * CELL;

  const DEFS =
    '<defs>' +
    MARKERS.map(([attrs, content], i) => `<marker id="m${i}" ${attrs}>${content}</marker>`).join(
      '',
    ) +
    '</defs>';
  // Corner dots pin the content box to the canvas, so em -> px is the viewBox mapping whatever the clips take away.
  const DOTS = `<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/><rect x="${W - 0.5}" y="${H - 0.5}" width="0.5" height="0.5" fill="#000"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    DEFS +
    DOTS +
    CARRIERS.map((t, r) =>
      MARKERS.map(
        ([, , d, sw], c) =>
          `<g transform="translate(${CELL * c + CELL / 2} ${CELL * r + CELL / 2}) ${t}">` +
          `<path d="${d}" fill="none" stroke="none" stroke-width="${sw}" marker-end="url(#m${c})"/></g>`,
      ).join(''),
    ).join('') +
    '</svg>';

  return {
    CELL,
    CARRIERS,
    W,
    H,
    svg,
    inkMin: 1000,
    dots: true,
    ctx: ', stencil: true, depth: true',
    what: (t) => t || 'plain',
  };
})();

const PAGES = new Map();
const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (PAGES.has(u)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES.get(u));
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
const WRONG_INK_MAX = 3; // per row, across its paths or markers
async function runSet(route0, set) {
  const { CELL, CARRIERS, W, H, svg } = set;
  PAGES.set(route0, htmlFor(W, H, set.ctx));
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto('http://127.0.0.1:' + server.address().port + route0, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });
  for (const route of ['none', 'lb']) {
    const o = await page.evaluate((s, r) => window.__case(s, r), svg, route);
    const rows = CARRIERS.map(() => ({ wrong: 0, over32: 0, ink: 0, ex: [] }));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (set.dots && ((x < 2 && y < 2) || (x >= W - 2 && y >= H - 2))) continue; // the pinning dots
        const i = (y * W + x) * 4,
          row = rows[Math.min(CARRIERS.length - 1, Math.floor(y / CELL))];
        const lm = (o.mantle[i] + o.mantle[i + 1] + o.mantle[i + 2]) / 765,
          lc = (o.chrome[i] + o.chrome[i + 1] + o.chrome[i + 2]) / 765;
        const d = Math.max(
          Math.abs(o.mantle[i] - o.chrome[i]),
          Math.abs(o.mantle[i + 1] - o.chrome[i + 1]),
          Math.abs(o.mantle[i + 2] - o.chrome[i + 2]),
        );
        if (lc < 0.5) row.ink++;
        if (d > 32) row.over32++;
        if (Math.abs(lm - lc) > 0.5) {
          row.wrong++;
          if (row.ex.length < 3)
            row.ex.push(`(${x},${y}) ink ${(1 - lm).toFixed(2)} for ${(1 - lc).toFixed(2)}`);
        }
      }
    CARRIERS.forEach((t, r) => {
      const e = rows[r],
        what = set.what(t, r);
      const line = `route ${route}, ${what}: ${e.wrong} px on the wrong side of an outline (ink off by more than half) of ${e.ink} inked; ${e.over32} px off by more than 32/255`;
      if (e.ink > set.inkMin && e.wrong <= WRONG_INK_MAX) ok(line);
      else fail(line + (e.ex.length ? ' -- ' + e.ex.join('; ') : ''));
    });
  }
  await page.close();
}
for (const [route0, set] of [
  ['/', TRANSFORM],
  ['/aspect', ASPECT],
  ['/clip-mask', CLIP_MASK],
  ['/viewport-clip', VIEWPORT_CLIP],
])
  await runSet(route0, set);
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  "\nmarkerTransformRenderSmoke: markers are placed in their path's space and transformed with it on the GPU;" +
    " their viewBoxes are fitted by preserveAspectRatio; they take their path's clip-path and mask and are clipped to their viewports",
);

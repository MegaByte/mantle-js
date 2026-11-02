// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// paintImageMaskAuditRenderSmoke -- the paint, image and mask behaviors that show in PIXELS,
// on the GPU. The record-level proofs are test/svg/paintImageMaskAuditSmoke.mjs; this is the rendered check.
//
// Each cell renders three documents with the renderer at 128 px (64-unit viewBox, white ground):
//   svg      the document under test, written with the feature under test;
//   control  the same picture authored with simpler features (rects, an explicit
//            gradient, a group wrapper): the render must match it except on a thin band of edge pixels;
//   old      the WRONG reading of the feature, authored literally (a stretched bitmap, a gradient over one unit, a
//            byte-rounded stop, a mask region ignored): the render must DIFFER from svg by at least 48/255 somewhere, so
//            a pass cannot be a picture that the wrong reading also draws.
// Probes are the analytic expectation: a stated point of the 64-unit space must read a stated color.
//
// Cells: an image 20x10 in a 48x48 box under meet, slice (centered and xMinYMin) and with no size; mix-blend-mode on an
// image; a hard gradient stop at 0.5 over a wide shape; a gradient href child that is userSpaceOnUse; a mask region on an
// element whose clip nests.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
const WHITE = [255, 255, 255],
  RED = [255, 0, 0],
  LIME = [0, 255, 0],
  BLUE = [0, 0, 255],
  YELLOW = [255, 255, 0],
  BLACK = [0, 0, 0];

// A minimal RGBA PNG encoder (one IDAT, filter 0 on every row).
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(w, h, px) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      px(x, y).forEach((v, k) => {
        raw[y * (w * 4 + 1) + 1 + x * 4 + k] = v;
      });
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
}
// 20x10: columns 0-4 red, 5-14 lime, 15-19 blue.
const BANDS = png(20, 10, (x) =>
  x < 5 ? [255, 0, 0, 255] : x < 15 ? [0, 255, 0, 255] : [0, 0, 255, 255],
);
const image = (attrs) => `<image href="${BANDS}" image-rendering="pixelated" ${attrs}/>`;
const bands = (x0, x1, x2, x3, y0, y1) =>
  `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="red"/>` +
  `<rect x="${x1}" y="${y0}" width="${x2 - x1}" height="${y1 - y0}" fill="lime"/><rect x="${x2}" y="${y0}" width="${x3 - x2}" height="${y1 - y0}" fill="blue"/>`;

// ---- hard gradient stop: userSpaceOnUse over 12800 units centered on x = 32 ------------------------------------------------
const wide = (o) =>
  doc(
    `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="-6368" y1="0" x2="6432" y2="0">` +
      `<stop offset="0" stop-color="red"/><stop offset="${o}" stop-color="red"/><stop offset="${o}" stop-color="blue"/><stop offset="1" stop-color="blue"/></linearGradient></defs>` +
      '<rect width="64" height="64" fill="url(#g)"/>',
  );
// ---- gradient href child ---------------------------------------------------------------------------------------------------
const ST = '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>';
const href = (child) =>
  doc(
    `<defs><linearGradient id="p">${ST}</linearGradient>${child}</defs><rect width="64" height="64" fill="url(#g)"/>`,
  );
// ---- mask region on an element whose clip nests ----------------------------------------------------------------------------
const nested = (region) =>
  doc(
    `<defs><clipPath id="d"><rect x="0" y="0" width="48" height="64"/></clipPath><clipPath id="c" clip-path="url(#d)"><rect x="12" y="0" width="40" height="64"/></clipPath>` +
      `<mask id="m" maskUnits="userSpaceOnUse" ${region}><rect x="-100" y="-100" width="300" height="300" fill="white"/></mask></defs>` +
      '<rect x="4" y="8" width="56" height="48" fill="red" clip-path="url(#c)" mask="url(#m)"/>',
  );

const CELLS = [
  {
    name: 'image meet in a 48x48 box',
    svg: doc(image('x="8" y="8" width="48" height="48"')),
    control: doc(bands(8, 20, 44, 56, 20, 44)),
    old: doc(bands(8, 20, 44, 56, 8, 56)),
    probes: [
      [12, 32, RED, 1],
      [32, 32, LIME, 1],
      [52, 32, BLUE, 1],
      [32, 12, WHITE, 1],
      [32, 52, WHITE, 1],
    ],
  },
  {
    name: 'image slice (xMidYMid) covers the box',
    svg: doc(image('x="8" y="8" width="48" height="48" preserveAspectRatio="xMidYMid slice"')),
    control: doc('<rect x="8" y="8" width="48" height="48" fill="lime"/>'),
    old: doc(bands(8, 20, 44, 56, 8, 56)),
    probes: [
      [12, 32, LIME, 1],
      [32, 32, LIME, 1],
      [52, 32, LIME, 1],
      [4, 32, WHITE, 1],
      [60, 32, WHITE, 1],
    ],
  },
  {
    name: 'image slice (xMinYMin) keeps the left edge',
    svg: doc(image('x="8" y="8" width="48" height="48" preserveAspectRatio="xMinYMin slice"')),
    control: doc(bands(8, 32, 56, 56, 8, 56)),
    old: doc(bands(8, 20, 44, 56, 8, 56)),
    probes: [
      [12, 32, RED, 1],
      [28, 32, RED, 1],
      [36, 32, LIME, 1],
      [52, 52, LIME, 1],
      [60, 32, WHITE, 1],
    ],
  },
  {
    name: "image with no width or height is the bitmap's size",
    svg: doc(image('x="8" y="8"')),
    control: doc(bands(8, 13, 23, 28, 8, 18)),
    old: doc(''),
    probes: [
      [10, 12, RED, 1],
      [18, 12, LIME, 1],
      [26, 12, BLUE, 1],
      [18, 22, WHITE, 1],
      [30, 12, WHITE, 1],
    ],
  },
  {
    name: 'mix-blend-mode: multiply on an image',
    svg: doc(
      '<rect x="4" y="4" width="56" height="56" fill="yellow"/>' +
        image('x="8" y="8" width="48" height="24" style="mix-blend-mode:multiply"'),
    ),
    control: doc(
      '<rect x="4" y="4" width="56" height="56" fill="yellow"/><g style="mix-blend-mode:multiply">' +
        image('x="8" y="8" width="48" height="24"') +
        '</g>',
    ),
    old: doc(
      '<rect x="4" y="4" width="56" height="56" fill="yellow"/>' +
        image('x="8" y="8" width="48" height="24"'),
    ),
    probes: [
      [12, 20, RED, 2],
      [32, 20, LIME, 2],
      [52, 20, BLACK, 2],
      [32, 44, YELLOW, 1],
    ],
  },
  {
    name: 'a hard stop at 0.5 lands at 0.5 over a wide shape',
    svg: wide('0.5'),
    control: doc(
      '<rect x="0" y="0" width="32" height="64" fill="red"/><rect x="32" y="0" width="32" height="64" fill="blue"/>',
    ),
    old: wide('0.50196'),
    probes: [
      [8, 32, RED, 1],
      [28, 32, RED, 1],
      [36, 32, BLUE, 1],
      [48, 32, BLUE, 1],
    ],
  },
  {
    name: 'a href child gets its own userSpaceOnUse defaults',
    svg: href('<linearGradient id="g" href="#p" gradientUnits="userSpaceOnUse"/>'),
    control: href(
      '<linearGradient id="g" href="#p" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="64" y2="0"/>',
    ),
    old: href(
      '<linearGradient id="g" href="#p" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0"/>',
    ),
    probes: [
      [16, 32, [191, 0, 64], 3],
      [48, 32, [64, 0, 191], 3],
      [2, 32, [247, 0, 8], 4],
    ],
  },
  {
    name: 'a mask region cuts an element whose clip nests',
    svg: nested('x="24" y="0" width="16" height="64"'),
    control: doc('<rect x="24" y="8" width="16" height="48" fill="red"/>'),
    old: nested('x="-100" y="-100" width="300" height="300"'),
    probes: [
      [32, 32, RED, 1],
      [18, 32, WHITE, 1],
      [44, 32, WHITE, 1],
      [32, 4, WHITE, 1],
    ],
  },
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__render = async (sources) => {
  viewport(gl, R); R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const out = [];
  for (const s of sources) {
    const b = createBundle(gl, await importSvg(s, { preserveViewport: true }));
    out.push(Array.from(await paint(gl, R, b))); b.dispose();
  }
  return out;
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
const { launchBrowser } = await import('./_launch.mjs');
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
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const at = (px, x, y) => {
  const i = ((127 - Math.floor(y * 2)) * 128 + Math.floor(x * 2)) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
// pixels that differ from the control by more than 24/255 in some channel: the edge band of a shape may, a surface may not
const badPixels = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4)
    if (
      Math.max(
        Math.abs(a[i] - b[i]),
        Math.abs(a[i + 1] - b[i + 1]),
        Math.abs(a[i + 2] - b[i + 2]),
      ) > 24
    )
      n++;
  return n;
};
for (const c of CELLS) {
  let px;
  try {
    px = await page.evaluate((s) => window.__render(s), [c.svg, c.control, c.old]);
  } catch (e) {
    fail(c.name + ': ' + e.message);
    continue;
  }
  const [a, b, o] = px;
  const vsControl = badPixels(a, b),
    vsOld = maxDiff(a, o);
  const bad = c.probes
    .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
    .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
  const line = `${c.name}: ${vsControl} px differ from the control (of 16384), old differs by ${vsOld}`;
  if (vsControl > 170) fail(line + ' -- render differs from its control');
  else if (vsOld < 48) fail(line + " -- vacuous: the wrong reading's picture is the same");
  else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
  else ok(line);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\npaintImageMaskAuditRenderSmoke: the paint/image/mask cases render as their controls on the GPU',
);

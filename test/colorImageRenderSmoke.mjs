// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colorImageRenderSmoke -- compositing rules that change pixels, on the GPU: a raster <image> is filtered PREMULTIPLIED
// (no dark halo next to a transparent texel), feComposite operator="lighter" is the clamped sum, plus two color rows through the
// real draw (`none` channels and color-mix premultiplied). The grammar itself is test/svg/colorChromeSmoke.mjs.
//
// Each cell renders three documents at 128 px (64-unit viewBox, white ground) as importerGeometryAuditRenderSmoke does:
//   svg      the document under test;
//   control  the same picture authored with features that do not depend on the rule (a gradient of the image's own alpha ramp, a flat fill at
//            the summed color): it must match to within `tol` (default 4/255: bilinear weights are 8-bit);
//   old      what the defect draws, authored literally: the render must DIFFER from it by at least 48/255 somewhere.
// Probes state the analytic expectation of a point (independent of both documents).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;

function png(w, h, rgba) {
  const crcT = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcT[n] = c >>> 0;
  }
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t, d) => {
    const b = Buffer.concat([Buffer.from(t), d]);
    const o = Buffer.alloc(4);
    o.writeUInt32BE(d.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(b));
    return Buffer.concat([o, b, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.slice(y * w * 4, (y + 1) * w * 4)).copy(raw, y * (w * 4 + 1) + 1);
  }
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
}
// 2x1: an opaque red texel, then a transparent one (RGB 0, as a browser decodes it).
const EDGE = png(2, 1, [255, 0, 0, 255, 0, 0, 0, 0]);
// 64x1: red and transparent texels alternate.
const COMB = png(
  64,
  1,
  Array.from({ length: 64 }, (_, i) => (i % 2 ? [0, 0, 0, 0] : [255, 0, 0, 255])).flat(),
);
// The alpha ramp a bilinear filter draws between the two texel centers of EDGE shown over x in [8, 56] (centers at 20 and 44).
const RAMP =
  '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="44" y2="0"><stop offset="0" stop-color="#f00" stop-opacity="1"/><stop offset="1" stop-color="#f00" stop-opacity="0"/></linearGradient>';
const IMG = `<image href="${EDGE}" x="8" y="24" width="48" height="16" preserveAspectRatio="none"/>`;
const BAR = '<rect x="8" y="24" width="48" height="16" fill="url(#g)"/>';
// Over the white ground a half-transparent red is (255,127,127). A straight-alpha filter draws (191,127,127) there: half-dark red.
const HALF_RED = [255, 127, 127],
  OLD_HALF = [191, 127, 127];
const OLD_PATCH =
  '<rect x="28" y="24" width="8" height="16" fill="rgb(127,0,0)" fill-opacity=".5"/>';

const CELLS = [
  {
    name: 'a magnified <image> next to a transparent texel keeps the red (no dark halo)',
    svg: doc(IMG),
    control: doc(`<defs>${RAMP}</defs>${BAR}`),
    old: doc(`<defs>${RAMP}</defs>${BAR}${OLD_PATCH}`),
    probes: [
      [32, 32, HALF_RED, 4],
      [12, 32, [255, 0, 0], 4],
      [52, 32, [255, 255, 255], 2],
    ],
  },
  {
    name: 'the same image under a rotation (the mapped sampler)',
    svg: doc(`<g transform="rotate(30 32 32)">${IMG}</g>`),
    control: doc(`<defs>${RAMP}</defs><g transform="rotate(30 32 32)">${BAR}</g>`),
    old: doc(`<defs>${RAMP}</defs><g transform="rotate(30 32 32)">${BAR}${OLD_PATCH}</g>`),
    probes: [[32, 32, HALF_RED, 4]],
  },
  {
    name: 'an image tile in a raster <pattern>',
    svg: doc(
      `<defs><pattern id="p" patternUnits="userSpaceOnUse" x="8" y="24" width="48" height="16">${IMG.replace('x="8" y="24"', 'x="0" y="0"')}</pattern></defs><rect x="8" y="24" width="48" height="16" fill="url(#p)"/>`,
    ),
    control: doc(`<defs>${RAMP}</defs>${BAR}`),
    old: doc(`<defs>${RAMP}</defs>${BAR}${OLD_PATCH}`),
    probes: [[32, 32, HALF_RED, 4]],
  },
  {
    name: 'an image under opacity .5 (the tint multiplies the straight color, then premultiplies)',
    svg: doc(
      `<image href="${EDGE}" x="8" y="24" width="48" height="16" preserveAspectRatio="none" opacity=".5"/>`,
    ),
    control: doc(
      '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="44" y2="0"><stop offset="0" stop-color="#f00" stop-opacity=".5"/><stop offset="1" stop-color="#f00" stop-opacity="0"/></linearGradient></defs><rect x="8" y="24" width="48" height="16" fill="url(#g)"/>',
    ),
    old: doc(
      '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="44" y2="0"><stop offset="0" stop-color="#f00" stop-opacity=".5"/><stop offset="1" stop-color="#f00" stop-opacity="0"/></linearGradient></defs><rect x="8" y="24" width="48" height="16" fill="url(#g)"/><rect x="28" y="24" width="8" height="16" fill="rgb(127,0,0)" fill-opacity=".25"/>',
    ),
    probes: [[32, 32, [255, 191, 191], 4]],
  },
  {
    name: 'a minified image (mip chain) averages red and transparent to half-transparent red',
    svg: doc(
      `<image href="${COMB}" x="28" y="28" width="8" height="8" preserveAspectRatio="none"/>`,
    ),
    control: doc('<rect x="28" y="28" width="8" height="8" fill="red" fill-opacity=".5"/>'),
    old: doc('<rect x="28" y="28" width="8" height="8" fill="rgb(127,0,0)" fill-opacity=".5"/>'),
    tol: 6,
    probes: [[32, 32, HALF_RED, 6]],
  },
  {
    name: 'feComposite lighter is the clamped sum of the premultiplied inputs',
    svg: doc(
      '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"><feFlood flood-color="#ff8000" flood-opacity=".6" result="a"/><feFlood flood-color="#0080ff" flood-opacity=".6" result="b"/><feComposite in="a" in2="b" operator="lighter"/></filter><rect width="64" height="64" filter="url(#f)"/>',
    ),
    control: doc('<rect width="64" height="64" fill="rgb(153,153,153)"/>'),
    old: doc('<rect width="64" height="64" fill="rgb(194,148,102)"/>'),
    probes: [[32, 32, [153, 153, 153], 2]],
  },
  {
    name: 'rgb(none 255 0): a `none` channel is 0',
    svg: doc('<rect x="8" y="8" width="48" height="48" fill="rgb(none 255 0)"/>'),
    control: doc('<rect x="8" y="8" width="48" height="48" fill="#00ff00"/>'),
    old: doc('<rect x="8" y="8" width="48" height="48" fill="#ffff00"/>'),
    probes: [[32, 32, [0, 255, 0], 1]],
  },
  {
    name: 'color-mix(in srgb, red, transparent) is half-transparent RED (premultiplied), not dark red',
    svg: doc(
      '<rect x="8" y="8" width="48" height="48" fill="color-mix(in srgb, red, transparent)"/>',
    ),
    control: doc('<rect x="8" y="8" width="48" height="48" fill="red" fill-opacity=".5"/>'),
    old: doc('<rect x="8" y="8" width="48" height="48" fill="rgb(128,0,0)" fill-opacity=".5"/>'),
    probes: [[32, 32, HALF_RED, 2]],
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
for (const c of CELLS) {
  let px;
  try {
    px = await page.evaluate((s) => window.__render(s), [c.svg, c.control, c.old]);
  } catch (e) {
    fail(c.name + ': ' + e.message);
    continue;
  }
  const [a, b, o] = px;
  const vsControl = maxDiff(a, b),
    vsOld = maxDiff(a, o);
  const bad = c.probes
    .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
    .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
  const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}`;
  if (vsControl > (c.tol ?? 4)) fail(line + ' -- render differs from its control');
  else if (vsOld < 48) fail(line + ' -- vacuous: the defect picture is the same');
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
  '\ncolorImageRenderSmoke: raster images filter premultiplied, lighter sums, color rows render as their controls on the GPU',
);

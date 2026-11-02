// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterPixelFixRenderSmoke -- filter primitive cases that are easy to draw wrong match Chrome. Each case is a 64-unit
// cell rendered at 128 px by Mantle and by Chrome (an <img> of the same SVG); the mean absolute channel difference over
// the whole cell is held to a bound.
//
// What each case guards: x-ds-group1 and x-ds-chain (feDropShadow on a group/chain must draw its shadow), x-disp-y-G1
// (Y displacement the right way up), dlight-point, x-dl-az90 and x-dl-point-slope (light in the right frame),
// x-conv-shiftTL (kernel taps), x-rot-blur-x (blur axes under a rotation), x-ct-table1-alpha (a one-value alpha table
// fills the region). A point light also needs the surface point's height: Filter Effects 1 puts it at
// Z(x, y) = surfaceScale * A(x, y), not on the canvas plane (dlight-point and x-dl-point-slope read 0.05 and 0.86; on the
// canvas plane, 4.3 and 6.9).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC =
  '<rect x="12" y="12" width="28" height="28" fill="#e04020"/><circle cx="40" cy="40" r="13" fill="#2060d0" fill-opacity=".75"/><rect x="26" y="8" width="6" height="48" fill="#20a040" fill-opacity=".5"/>';
const RECT = '<rect x="18" y="18" width="20" height="20" fill="#e04020"/>';
const REGION = 'filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"';
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
function png(w, h, pixel) {
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type),
      len = Buffer.alloc(4),
      c = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
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
// 8 x 8: left half red, right half blue, flat so smoothing does not matter.
const PNG = png(8, 8, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
const cell = (prim, { body, region = REGION, defs = '' } = {}) =>
  doc(
    `<defs>${defs}<filter id="f" ${region} color-interpolation-filters="sRGB">${prim}</filter></defs>${body ?? `<g filter="url(#f)">${RECT}</g>`}`,
  );
const dmap = (c) =>
  `<feFlood flood-color="${c}" result="m"/><feDisplacementMap in="SourceGraphic" in2="m" scale="12" xChannelSelector="R" yChannelSelector="G"/>`;
const BL = '<feGaussianBlur in="SourceAlpha" stdDeviation="3" result="a"/>';
const BOX = {
  body: '<g filter="url(#f)"><rect x="16" y="16" width="32" height="32" fill="#000"/></g>',
};
const BLURA = '<feGaussianBlur in="SourceAlpha" stdDeviation="2" result="a"/>';

// [id, svg, mean bound]
const CASES = [
  ['x-ds-group1', cell('<feDropShadow dx="5" dy="5" stdDeviation="2"/>'), 2],
  [
    'x-ds-chain',
    cell(
      '<feOffset dx="3" dy="0" result="o"/><feDropShadow in="o" dx="4" dy="4" stdDeviation="1"/>',
    ),
    2,
  ],
  ['ds-default-sd', cell('<feDropShadow dx="5" dy="5"/>'), 2],
  [
    'x-merge-3-srcalpha',
    cell(
      '<feOffset in="SourceAlpha" dx="5" dy="5" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="SourceAlpha"/><feMergeNode in="SourceGraphic"/></feMerge>',
    ),
    2,
  ],
  [
    'merge-3',
    cell(
      '<feGaussianBlur stdDeviation="2" result="b"/><feOffset in="SourceAlpha" dx="5" dy="5" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>',
      { body: `<g filter="url(#f)">${SRC}</g>` },
    ),
    2,
  ],
  [
    'x-img-image-elem',
    cell('<feImage href="#im"/>', {
      defs: `<image id="im" x="6" y="6" width="40" height="30" href="${PNG}"/>`,
    }),
    3,
  ],
  ['x-disp-y-G1', cell(dmap('rgb(128,255,128)')), 2],
  ['x-disp-x-R1', cell(dmap('rgb(255,128,128)')), 2],
  [
    'dlight-point',
    cell(
      BLURA +
        '<feDiffuseLighting in="a" surfaceScale="4" lighting-color="white"><fePointLight x="14" y="10" z="20"/></feDiffuseLighting>',
      { body: `<g filter="url(#f)">${SRC}</g>` },
    ),
    1,
  ],
  [
    'x-dl-az90',
    cell(
      BL +
        '<feDiffuseLighting in="a" surfaceScale="6" lighting-color="white"><feDistantLight azimuth="90" elevation="30"/></feDiffuseLighting>',
      BOX,
    ),
    4,
  ],
  [
    'x-dl-point-slope',
    cell(
      BL +
        '<feDiffuseLighting in="a" surfaceScale="6" lighting-color="white"><fePointLight x="10" y="10" z="12"/></feDiffuseLighting>',
      BOX,
    ),
    2,
  ],
  [
    'x-conv-shiftTL',
    cell('<feConvolveMatrix order="3" kernelMatrix="1 0 0 0 0 0 0 0 0" divisor="1"/>'),
    1.5,
  ],
  [
    'x-rot-blur-x',
    cell('<feGaussianBlur stdDeviation="5 0"/>', {
      body: '<g transform="rotate(45 32 32)" filter="url(#f)"><rect x="24" y="24" width="16" height="16" fill="#e04020"/></g>',
      region: 'filterUnits="userSpaceOnUse" x="-20" y="-20" width="104" height="104"',
    }),
    1.5,
  ],
  [
    'x-ct-table1-alpha',
    cell('<feComponentTransfer><feFuncA type="table" tableValues="0.5"/></feComponentTransfer>'),
    3,
  ],
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
window.__case = async (svg, W, H) => {
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
  const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(W, H); gl.viewport(0, 0, W, H);
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H);
  const ref = ctx.getImageData(0, 0, W, H).data;
  c.remove();
  let sum = 0, max = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 3; k++) {
    const d = Math.abs(px[((H - 1 - y) * W + x) * 4 + k] - ref[(y * W + x) * 4 + k]); sum += d; if (d > max) max = d;
  }
  let dump = null;
  if (window.__dump) { const d = document.createElement('canvas'); d.width = W * 2; d.height = H; const dc = d.getContext('2d');
    const a = dc.createImageData(W, H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < 4; k++) a.data[(y * W + x) * 4 + k] = px[((H - 1 - y) * W + x) * 4 + k];
    dc.putImageData(a, 0, 0); dc.putImageData(new ImageData(new Uint8ClampedArray(ref), W, H), W, 0); dump = d.toDataURL(); }
  return { mean: sum / (W * H * 3), max, dump };
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

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  if (process.env.FF_DUMP)
    await page.evaluate(() => {
      window.__dump = true;
    });
  for (const [id, svg, bound] of CASES) {
    if (process.env.FF_ONLY && !process.env.FF_ONLY.split(',').includes(id)) continue;
    const r = await page.evaluate((s) => window.__case(s, 128, 128), svg);
    if (r.dump)
      (await import('fs')).writeFileSync(
        path.join(process.env.FF_DUMP, id + '.png'),
        Buffer.from(r.dump.split(',')[1], 'base64'),
      );
    const msg = `${id}: mean ${r.mean.toFixed(2)} max ${r.max} (bound ${bound})`;
    if (r.mean <= bound) console.log('ok ' + msg);
    else fail(msg);
  }
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nfilterPixelFixRenderSmoke: the audited filter primitives match Chrome');

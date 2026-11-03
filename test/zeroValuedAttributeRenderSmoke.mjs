// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// zeroValuedAttributeRenderSmoke — attributes that are legitimately 0 render as 0, on both routes,
// against Chrome.
//
// Each value below, read `x || default`, would turn its 0 into the default (the reading -> the answer):
//   <g opacity="0">                 children opaque                   -> nothing (the ground shows)
//   <image opacity="0">             the image opaque                  -> nothing
//   <image fill-opacity="0">        (fill-opacity does not apply to an image; it stays visible)
//   <image opacity="0.5">           half over the ground (the image alpha is the element's opacity)
//   a marker at stroke-width="0"    the marker at stroke width 1      -> nothing
//   feDiffuseLighting diffuseConstant="0"   lit as kd = 1            -> black
//   feDiffuseLighting surfaceScale="0"      tilted by an alpha ramp  -> a flat surface's constant N.L
//   feSpecularLighting specularConstant="0" a highlight              -> the SPEC answer by default: transparent
//                                                                       (the ground shows). A DOCUMENTED CHROME
//                                                                       DIVERGENCE: Blink runs a specular constant
//                                                                       <= 0 as DIFFUSE with kd 0, opaque black;
//                                                                       importSvg({ compat: 'chrome' }) does
//                                                                       too, and is held to Chrome here (see
//                                                                       specularZeroConstantSmoke)
// THE REFERENCE IS CHROME'S rendering of the same SVG, read through a 2D canvas, at points away from
// edges -- except where a case names a `spec` value for the default import, which Chrome departs from
// (it is then checked against Chrome under the case's `compat` import options instead); filters use color-interpolation-filters="sRGB" so the color space is not the question. The
// route is asserted from debugStats. The node smoke is test/zeroValuedAttributeSmoke.mjs.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 100;

// A solid-orange 4 x 4 PNG, built here so the fixture carries no binary.
function png(w, h, rgba) {
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
    for (let x = 0; x < w; x++) raw.set(rgba, y * (w * 4 + 1) + 1 + x * 4);
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
const ORANGE = png(4, 4, [255, 140, 0, 255]);
const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs>${defs}</defs><rect width="${N}" height="${N}" fill="#4060c0"/>${body}</svg>`;
const LIGHT = '<feDistantLight azimuth="0" elevation="30"/>';
const CASES = [
  {
    name: '<g opacity="0">',
    svg: svg(
      '<g opacity="0"><rect x="10" y="10" width="60" height="60" fill="#e00"/><rect x="30" y="30" width="60" height="60" fill="#0a0"/></g>',
    ),
    pts: [
      [20, 20, 'first child'],
      [50, 50, 'the overlap'],
      [80, 80, 'second child'],
    ],
  },
  {
    name: '<image opacity="0">',
    svg: svg(`<image x="20" y="20" width="60" height="60" href="${ORANGE}" opacity="0"/>`),
    pts: [[50, 50, 'image center']],
  },
  {
    name: '<image fill-opacity="0"> stays visible',
    svg: svg(`<image x="20" y="20" width="60" height="60" href="${ORANGE}" fill-opacity="0"/>`),
    pts: [[50, 50, 'image center']],
  },
  {
    name: '<image opacity="0.5">',
    svg: svg(`<image x="20" y="20" width="60" height="60" href="${ORANGE}" opacity="0.5"/>`),
    pts: [[50, 50, 'image center']],
  },
  {
    name: 'a marker at stroke-width 0',
    svg: svg(
      '<path d="M15 50 L75 50" fill="none" stroke="#000" stroke-width="0" marker-end="url(#m)"/>',
      '<marker id="m" markerWidth="12" markerHeight="12" refX="6" refY="6"><circle cx="6" cy="6" r="6" fill="#0c0"/></marker>',
    ),
    pts: [
      [75, 50, "the marker's center"],
      [78, 53, 'inside the marker'],
    ],
  },
  {
    name: 'feDiffuseLighting diffuseConstant="0"',
    svg: svg(
      '<rect x="20" y="20" width="60" height="60" fill="#fff" filter="url(#f)"/>',
      `<filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feDiffuseLighting diffuseConstant="0" lighting-color="#fff">${LIGHT}</feDiffuseLighting></filter>`,
    ),
    pts: [[50, 50, 'the lit rect']],
  },
  {
    name: 'feDiffuseLighting surfaceScale="0" over an alpha ramp',
    svg: svg(
      '<rect x="10" y="20" width="80" height="60" fill="url(#ramp)" filter="url(#f)"/>',
      '<linearGradient id="ramp"><stop offset="0.3" stop-color="#fff" stop-opacity="0"/><stop offset="0.7" stop-color="#fff" stop-opacity="1"/></linearGradient>' +
        `<filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feDiffuseLighting in="SourceAlpha" surfaceScale="0" lighting-color="#fff">${LIGHT}</feDiffuseLighting></filter>`,
    ),
    pts: [
      [50, 50, 'mid ramp'],
      [45, 40, 'mid ramp, higher'],
    ],
  },
  {
    name: 'feSpecularLighting specularConstant="0"',
    svg: svg(
      '<rect x="20" y="20" width="60" height="60" fill="#fff" filter="url(#f)"/>',
      `<filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feSpecularLighting specularConstant="0" specularExponent="1" lighting-color="#fff">${LIGHT}</feSpecularLighting></filter>`,
    ),
    pts: [[50, 50, 'the lit rect']],
    // Default import: Filter Effects' answer, a transparent result over the ground. Chrome draws black.
    spec: [0x40, 0x60, 0xc0, 255],
    compat: { compat: 'chrome' },
  },
];
const ROUTES = ['none', 'lb'];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (svg, pts, route, importOpts) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true, ...(importOpts || {}) }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  let before = null;
  for (let i = 0; i < 4; i++) { if (i === 3) before = Object.assign({}, R.debugStats); R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const uni = (R.debugStats.unifiedFillDraws | 0) - (before.unifiedFillDraws | 0);
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ${N}, ${N}); ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, ${N}, ${N}).data;
  return { uni, pts: pts.map(([x, y, what]) => ({ x, y, what,
    mantle: Array.from(px.slice(((${N} - 1 - y) * ${N} + x) * 4, ((${N} - 1 - y) * ${N} + x) * 4 + 4)),
    chrome: Array.from(ref.slice((y * ${N} + x) * 4, (y * ${N} + x) * 4 + 4)) })) };
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
const ok = (m) => console.log('ok ' + m);
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
// Both grounds are opaque, so the WebGL canvas's premultiplied bytes are its color. Flat points;
// the lighting cases run the same Sobel kernel on both sides.
const TOL = 6;
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const c of CASES)
    for (const route of ROUTES)
      for (const mode of c.spec ? ['default', 'compat'] : ['default']) {
        const r = await page.evaluate(
          (s, p, rt, o) => window.__case(s, p, rt, o),
          c.svg,
          c.pts,
          route,
          mode === 'compat' ? c.compat : null,
        );
        const tag = `${c.name}, route ${route}${c.spec ? `, ${mode === 'compat' ? JSON.stringify(c.compat) : 'default import'}` : ''}`;
        if (route === 'none' && r.uni !== 0)
          fail(`${tag}: the classic arm drew ${r.uni} unified draws`);
        for (const p of r.pts) {
          // The default import of a case with a `spec` value is held to the SPEC, and Chrome's pixel is only
          // reported (a documented divergence); everything else, and the compat import, is held to Chrome.
          const want = c.spec && mode === 'default' ? c.spec : p.chrome;
          const d = Math.max(...p.mantle.map((v, i) => Math.abs(v - want[i])));
          const msg =
            `${tag}, ${p.what} (${p.x},${p.y}): mantle rgba(${p.mantle.join(',')}) ` +
            (want === p.chrome
              ? `chrome rgba(${p.chrome.join(',')})`
              : `spec rgba(${want.join(',')}) [Chrome, a documented divergence: rgba(${p.chrome.join(',')})]`);
          if (d <= TOL) ok(msg);
          else fail(msg + ` -- off by ${d}/255`);
        }
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
console.log('\nzeroValuedAttributeRenderSmoke: zero-valued attributes render as zero, at Chrome');

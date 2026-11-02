// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// feImageOrientationRenderSmoke — an feImage that references an <image> by id draws it the right way
// up, on a square and a 2:1 region, both routes, against Chrome.
//
// A region fit that reads the atlas rows the way the pass's uv runs, up the canvas, while the atlas holds
// the image top row first, draws every id-referenced feImage upside down. Here the image is split TOP
// red / BOTTOM blue, so a flip swaps the two. As in feImageMeetAspectRenderSmoke, the filtered rect is
// the canvas, its filter region is the rect, and the referenced <image> sits in <defs> at that same box
// with the default xMidYMid meet, so Chrome's use-style drawing of it is the region fit.
//
// If Chrome does not draw an element reference from <defs> at all (every point white), the Chrome
// comparison says so and the points are held to the expected picture instead. The node smoke is
// test/feImageOrientationSmoke.mjs.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
// 16 x 16, top half red, bottom half blue: flat well away from the seam, so smoothing does not matter.
const IMG = png(16, 16, (_x, y) => (y < 8 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
const svg = (W, H) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>` +
  `<image id="img" x="0" y="0" width="${W}" height="${H}" href="${IMG}"/>` +
  '<filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feImage href="#img"/></filter>' +
  `</defs><rect width="${W}" height="${H}" fill="#fff"/><rect width="${W}" height="${H}" fill="#000" filter="url(#f)"/></svg>`;
const WHITE = [255, 255, 255, 255],
  RED = [255, 0, 0, 255],
  BLUE = [0, 0, 255, 255];
const CASES = [
  {
    name: 'square region',
    W: 100,
    H: 100,
    pts: [
      [50, 20, 'top half', RED],
      [50, 80, 'bottom half', BLUE],
    ],
  },
  {
    name: '2:1 region',
    W: 200,
    H: 100,
    pts: [
      [100, 20, 'top half', RED],
      [100, 80, 'bottom half', BLUE],
      [20, 50, 'left margin', WHITE],
    ],
  },
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
window.__case = async (svg, W, H, pts, route) => {
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
  const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(W, H); gl.viewport(0, 0, W, H);
  let before = null;
  for (let i = 0; i < 4; i++) { if (i === 3) before = Object.assign({}, R.debugStats); R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
  const uni = (R.debugStats.unifiedFillDraws | 0) - (before.unifiedFillDraws | 0);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, W, H).data;
  c.remove();
  return { uni, pts: pts.map(([x, y, what]) => ({ x, y, what,
    mantle: Array.from(px.slice(((H - 1 - y) * W + x) * 4, ((H - 1 - y) * W + x) * 4 + 4)),
    chrome: Array.from(ref.slice((y * W + x) * 4, (y * W + x) * 4 + 4)) })) };
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
const TOL = 6;
const dist = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const c of CASES)
    for (const route of ['none', 'lb']) {
      const r = await page.evaluate(
        (s, W, H, p, rt) => window.__case(s, W, H, p, rt),
        svg(c.W, c.H),
        c.W,
        c.H,
        c.pts.map((p) => p.slice(0, 3)),
        route,
      );
      const tag = `${c.name}, route ${route}`;
      if (route === 'none' && r.uni !== 0)
        fail(`${tag}: the classic arm drew ${r.uni} unified draws`);
      // Does Chrome draw the reference at all? If every point is the white ground, it does not.
      const chromeDraws = r.pts.some((p) => dist(p.chrome, WHITE) > TOL);
      if (!chromeDraws)
        console.log(
          `note ${tag}: Chrome draws no feImage element reference from <defs>; holding the points to the expected fit`,
        );
      r.pts.forEach((p, i) => {
        const want = chromeDraws ? p.chrome : c.pts[i][3];
        const msg = `${tag}, ${p.what} (${p.x},${p.y}): mantle rgba(${p.mantle.join(',')}) ${chromeDraws ? 'chrome' : 'expected'} rgba(${want.join(',')})`;
        if (dist(p.mantle, want) <= TOL) ok(msg);
        else fail(msg + ` -- off by ${dist(p.mantle, want)}/255`);
      });
      if (chromeDraws) {
        const agrees = r.pts.every((p, i) => dist(p.chrome, c.pts[i][3]) <= TOL);
        if (agrees) ok(`${tag}: Chrome draws the expected fit`);
        else
          console.log(
            `note ${tag}: Chrome's points differ from the expected fit -- the Chrome comparison above is the judge`,
          );
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
console.log('\nfeImageOrientationRenderSmoke: an id-referenced feImage draws the right way up');

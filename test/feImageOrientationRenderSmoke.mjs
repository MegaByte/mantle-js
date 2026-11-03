// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// feImageOrientationRenderSmoke — an feImage that references an <image> by id draws it the right way
// up, on a square and a 2:1 region, both routes, against Chrome.
//
// A region fit that reads the atlas rows the way the pass's uv runs, up the canvas, while the atlas holds
// the image top row first, draws every id-referenced feImage upside down. Here the image is split TOP
// red / BOTTOM blue, so a flip swaps the two. As in the meet-aspect cases below, the filtered rect is
// the canvas, its filter region is the rect, and the referenced <image> sits in <defs> at that same box
// with the default xMidYMid meet, so Chrome's use-style drawing of it is the region fit.
//
// If Chrome does not draw an element reference from <defs> at all (every point white), the Chrome
// comparison says so and the points are held to the expected picture instead. The node smoke is
// test/feImageOrientationSmoke.mjs.
//
// MEET ASPECT (same page): an feImage's "meet" fit uses the filter region's own aspect, on a 2:1 and a
// 1:2 region, both routes, against Chrome. A region fit that takes the region as square stretches a
// square image in a 2:1 region across all of it. The setup is the one above (Filter Effects 1 draws an
// element reference like a <use>, so Chrome draws that image at its own viewport -- which, by
// construction, is the fit into the region), with a square image split left half red / right half blue,
// so the vertical placement cannot hide in a flip: in the 2:1 region the margins left and right are the
// white ground and the middle half is red then blue; in the 1:2 region the margins are above and below.
// The node smoke is test/feImageMeetAspectSmoke.mjs.
//
// EXTERNAL HREF (the _chromeRef page): an <feImage href="data:image/png;base64,..."> draws its raster
// where Chrome does: fitted by preserveAspectRatio into the primitive subregion and clipped to it, with
// the subregion in either primitiveUnits and defaulting to the filter region. The reference is Chrome's
// rendering of the same SVG (test/_chromeRef.mjs), on white. An feImage that resolved "#id" only would
// leave an untyped node in the graph for an external href, and the filter would draw nothing Chrome
// draws. feImageExternalSmoke pins the import, the placement math and the pixel mapping in node; this is
// the pixels. The image is 8x8 in four 4x4 quadrants (red, green / blue, yellow), and every point read is
// a quadrant's middle, where any resampling filter returns the quadrant's color.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openChromeRef, rgbaAt } from './_chromeRef.mjs';

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
// 16 x 16, left half red, right half blue (the meet-aspect cases).
const MEET_IMG = png(16, 16, (x) => (x < 8 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
const svg = (W, H, img = IMG) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>` +
  `<image id="img" x="0" y="0" width="${W}" height="${H}" href="${img}"/>` +
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

const MEET_CASES = [
  {
    name: '2:1 region',
    W: 200,
    H: 100,
    pts: [
      [20, 50, 'left margin', WHITE],
      [65, 50, 'left half', RED],
      [135, 50, 'right half', BLUE],
      [180, 50, 'right margin', WHITE],
    ],
  },
  {
    name: '1:2 region',
    W: 100,
    H: 200,
    pts: [
      [50, 20, 'top margin', WHITE],
      [25, 100, 'left half', RED],
      [75, 100, 'right half', BLUE],
      [50, 180, 'bottom margin', WHITE],
    ],
  },
];

// The external-href cases: four filters with data: PNG hrefs, read at quadrant middles.
const Q = {
  tl: [255, 0, 0, 255],
  tr: [0, 160, 0, 255],
  bl: [0, 0, 255, 255],
  br: [255, 200, 0, 255],
};
const EXT_IMG = png(8, 8, (x, y) => (y < 4 ? (x < 4 ? Q.tl : Q.tr) : x < 4 ? Q.bl : Q.br));

const EXT_W = 240,
  EXT_H = 120;
const EXT_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${EXT_W}" height="${EXT_H}" viewBox="0 0 ${EXT_W} ${EXT_H}"><defs>` +
  // A: no subregion -> the filter region (the rect's box), meet: a 50x50 image centered in 100x50.
  `<filter id="a" x="0" y="0" width="1" height="1"><feImage href="${EXT_IMG}"/></filter>` +
  // B: a userSpaceOnUse subregion far from the filtered shape, stretched (none).
  `<filter id="b" filterUnits="userSpaceOnUse" x="0" y="0" width="${EXT_W}" height="${EXT_H}">` +
  `<feImage href="${EXT_IMG}" x="130" y="10" width="100" height="40" preserveAspectRatio="none"/></filter>` +
  // C: xMaxYMax slice into 60x30: the image is 60x60 at y 50..110; only its bottom half (y 80..110) shows.
  `<filter id="c" filterUnits="userSpaceOnUse" x="0" y="0" width="${EXT_W}" height="${EXT_H}">` +
  `<feImage href="${EXT_IMG}" x="10" y="80" width="60" height="30" preserveAspectRatio="xMaxYMax slice"/></filter>` +
  // D: objectBoundingBox primitive units: the right half of the rect's box, stretched.
  `<filter id="d" primitiveUnits="objectBoundingBox"><feImage href="${EXT_IMG}" x="0.5" y="0" width="0.5" height="1" preserveAspectRatio="none"/></filter>` +
  `</defs>` +
  `<rect x="10" y="10" width="100" height="50" fill="#000" filter="url(#a)"/>` +
  `<rect x="220" y="100" width="10" height="10" fill="#000" filter="url(#b)"/>` +
  `<rect x="100" y="100" width="10" height="10" fill="#000" filter="url(#c)"/>` +
  `<rect x="130" y="60" width="100" height="56" fill="#000" filter="url(#d)"/>` +
  `</svg>`;

const EXT_PTS = [
  [47, 22, Q.tl, 'A: region fit, top-left quadrant'],
  [72, 22, Q.tr, 'A: top-right'],
  [47, 47, Q.bl, 'A: bottom-left'],
  [72, 47, Q.br, 'A: bottom-right'],
  [20, 35, WHITE, 'A: letterbox (transparent)'],
  [155, 20, Q.tl, 'B: userSpaceOnUse subregion, stretched, top-left'],
  [205, 20, Q.tr, 'B: top-right'],
  [155, 40, Q.bl, 'B: bottom-left'],
  [205, 40, Q.br, 'B: bottom-right'],
  [25, 95, Q.bl, 'C: slice, the visible bottom-left'],
  [55, 95, Q.br, 'C: the visible bottom-right'],
  [25, 70, WHITE, 'C: the image above its subregion (clipped)'],
  [192, 74, Q.tl, 'D: objectBoundingBox subregion, top-left'],
  [218, 74, Q.tr, 'D: top-right'],
  [192, 102, Q.bl, 'D: bottom-left'],
  [218, 102, Q.br, 'D: bottom-right'],
  [150, 88, WHITE, "D: the box's left half (outside the subregion)"],
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
  for (const [cases, img] of [
    [CASES, IMG],
    [MEET_CASES, MEET_IMG],
  ])
    for (const c of cases)
      for (const route of ['none', 'lb']) {
        const r = await page.evaluate(
          (s, W, H, p, rt) => window.__case(s, W, H, p, rt),
          svg(c.W, c.H, img),
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
// The external-href cases on the _chromeRef page, opened in this browser: closing the ref closes its page.
{
  await page.close();
  let refPage = null;
  const ref = await openChromeRef(async () => ({
    newPage: async () => (refPage = await browser.newPage()),
    close: async () => refPage && refPage.close(),
  }));
  try {
    const { mantle, chrome } = await ref.render(EXT_SVG, { w: EXT_W, h: EXT_H, ground: 'white' });
    for (const [x, y, want, what] of EXT_PTS) {
      const m = rgbaAt(mantle, EXT_W, x, y),
        c = rgbaAt(chrome, EXT_W, x, y);
      const d = Math.max(...m.map((v, i) => Math.abs(v - c[i])));
      const dw = Math.max(...c.map((v, i) => Math.abs(v - want[i])));
      const msg = `${what} (${x},${y}): mantle rgba(${m.join(',')}) chrome rgba(${c.join(',')})`;
      if (dw > 4)
        fail(msg + ` — the reference itself is not rgba(${want.join(',')}); the case is mis-set`);
      else if (d <= 4) ok(msg);
      else fail(msg + ` — off by ${d}/255`);
    }
    for (const e of ref.pageErrors) fail('page: ' + e);
  } catch (e) {
    fail('setup: ' + e.message);
  }
  await ref.close();
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  "\nfeImageOrientationRenderSmoke: an id-referenced feImage draws the right way up and meets the region's own aspect;" +
    ' an external feImage is fitted into its subregion and clipped to it, as Chrome does',
);

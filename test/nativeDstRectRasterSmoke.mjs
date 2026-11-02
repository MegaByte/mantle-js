// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeDstRectRasterSmoke.mjs: dstRect pixels. The same bundle is drawn into the same dstRect by the WebGL renderer and by the
// native SVG scene (rasterized by the browser) and the two images are compared: the ink's bounding box, and the pixels. The art has a
// padded viewBox on purpose (the native default fits the viewBox, the rect fits the content bbox), a hard-edged rect and a circle so a
// stretched ('none') or cropped ('slice' + clipToRect) draw announces itself.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = `<!DOCTYPE html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createNativeScene } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><rect x="40" y="20" width="100" height="50" fill="#1b3a6b"/><circle cx="70" cy="45" r="18" fill="#f5c542"/><rect x="100" y="30" width="30" height="30" fill="#e04a3a"/></svg>';
async function rasterNative(scene, W, H) {
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); await img.decode();
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(img, 0, 0, W, H);
  return Array.from(g.getImageData(0, 0, W, H).data);
}
window.__case = async (W, H, opts, space) => {
  const gc = document.createElement('canvas'); gc.width = W; gc.height = H; document.body.appendChild(gc);
  const gl = gc.getContext('webgl2', { antialias: false, depth: true, preserveDrawingBuffer: true });
  const R = createRenderer(gl, shaders, { precompileFillsBudgetMs: 5000 }); await R.ready; R.setViewport(W, H);
  const imported = await importSvg(SVG, { retainSource: true });
  const b = createBundle(gl, imported);
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) await R.awaitLbReady(b, 20000);
  for (let i = 0; i < 4; i++) { gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); R.beginFrame(null); R.drawBundle(b, opts); R.endFrame(); }
  const raw = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const glPx = new Array(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W * 4; x++) glPx[y * W * 4 + x] = raw[(H - 1 - y) * W * 4 + x];
  const scene = createNativeScene(document.createElement('div'), { coordinateSpace: space });
  scene.setViewport(W, H);
  scene.beginFrame([1, 1, 1, 1]); scene.drawBundle(imported, opts); scene.endFrame();
  return { gl: glPx, native: await rasterNative(scene, W, H) };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  try {
    const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    const b = readFileSync(f);
    res.writeHead(200, {
      'content-type': f.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : 'text/plain; charset=utf-8',
    });
    res.end(b);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let failures = 0;
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await openReady(page, `http://127.0.0.1:${server.address().port}/`, { ready: 'flag' });

const inkBox = (px, W, H) => {
  let x0 = 1e9,
    y0 = 1e9,
    x1 = -1,
    y1 = -1,
    n = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (px[i] < 200 || px[i + 1] < 200 || px[i + 2] < 200) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  return { n, box: n ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : [0, 0, 0, 0] };
};
const CASES = [
  [256, 192, { dstRect: [0, 0, 256, 192] }, 'whole viewport'],
  [256, 192, { dstRect: [64, 32, 128, 64] }, 'meet, wide rect'],
  [256, 192, { dstRect: [20, 20, 80, 150] }, 'meet, tall rect'],
  [256, 192, { dstRect: [64, 32, 128, 128], fit: 'xMinYMin meet' }, 'xMinYMin meet'],
  [256, 192, { dstRect: [64, 32, 128, 128], fit: 'xMaxYMax meet' }, 'xMaxYMax meet'],
  [256, 192, { dstRect: [80, 40, 100, 100], fit: 'xMidYMid slice' }, 'slice, clipped'],
  [
    256,
    192,
    { dstRect: [80, 40, 100, 100], fit: 'xMidYMid slice', clipToRect: false },
    'slice, unclipped',
  ],
  [256, 192, { dstRect: [30, 30, 180, 60], fit: 'none' }, 'none (stretch)'],
  [192, 256, { dstRect: [10, 100, 170, 100] }, 'portrait viewport'],
];
for (const space of ['bundle', 'viewport']) {
  for (const [W, H, opts, name] of CASES) {
    const { gl, native } = await page.evaluate(
      (w, h, o, s) => window.__case(w, h, o, s),
      W,
      H,
      opts,
      space,
    );
    const a = inkBox(gl, W, H),
      b = inkBox(native, W, H);
    let big = 0;
    for (let i = 0; i < gl.length; i += 4)
      if (
        Math.max(
          Math.abs(gl[i] - native[i]),
          Math.abs(gl[i + 1] - native[i + 1]),
          Math.abs(gl[i + 2] - native[i + 2]),
        ) > 64
      )
        big++;
    const boxOk = a.n > 0 && a.box.every((v, k) => Math.abs(v - b.box[k]) <= 2);
    const label = `${space} ${W}x${H} ${name}: GL ink ${a.box} (${a.n} px), native ink ${b.box} (${b.n} px), ${big} px differ by more than 64/255`;
    // pixels that differ are the antialiased edges (and the circle's rim); a displaced or mis-scaled draw differs over its whole area
    if (boxOk && big <= 0.04 * a.n + 40) console.log('ok ' + label);
    else {
      failures++;
      console.error('FAIL ' + label);
    }
  }
}
await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nnativeDstRectRasterSmoke: all checks passed');

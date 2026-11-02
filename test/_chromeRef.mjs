// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _chromeRef.mjs — render one SVG twice in one page: through Mantle (WebGL2) and through Chrome's own
// SVG engine (the markup as an <img>, drawn into a 2D canvas), and hand both back for comparison.
//
// Both come back as STRAIGHT (unpremultiplied) RGBA, top row first, `w * h * 4` bytes: the WebGL
// canvas is premultiplied and bottom-up, the 2D canvas's getImageData is straight and top-down, so
// the Mantle side is flipped and divided here and a caller compares like with like.
//
// The Mantle import uses `preserveViewport: true`, so the draw fits the SVG's viewBox to the canvas
// exactly as the <img> does; give every SVG a viewBox and width/height equal to (w, h). `ground` is
// 'transparent' (read ALPHA: both sides cleared to 0,0,0,0) or 'white' (read COLOR: both sides over
// an opaque white canvas). `importOpts` is merged into importSvg's options.
//
//   import { launchBrowser } from './_launch.mjs';
//   const ref = await openChromeRef(launchBrowser);
//   const { mantle, chrome, drew } = await ref.render(svg, { w, h, ground, importOpts });
//   ...
//   await ref.close();
//
// The caller passes test/_launch.mjs's launchBrowser in, so every render smoke that uses this still
// imports the launcher itself -- which is how testLaneBackendSmoke tells a browser test from a node one.
import { openReady } from './_pageReady.mjs';
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="16" height="16"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
window.__render = async (svg, w, h, ground, importOpts) => {
  cv.width = w; cv.height = h;
  const b = createBundle(gl, await importSvg(svg, Object.assign({ preserveViewport: true }, importOpts || {})));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  const clear = ground === 'white' ? [1, 1, 1, 1] : [0, 0, 0, 0];
  R.setViewport(w, h); gl.viewport(0, 0, w, h);
  for (let i = 0; i < 4; i++) { R.beginFrame(clear); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const drew = Object.assign({}, (R.debugStats.engines || {}).draws || {});
  b.dispose && b.dispose();
  // Flip to top-down and unpremultiply.
  const mantle = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4, d = (y * w + x) * 4, a = px[s + 3];
    mantle[d + 3] = a;
    if (a) for (let k = 0; k < 3; k++) mantle[d + k] = Math.min(255, Math.round(px[s + k] * 255 / a));
  }
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const c2 = document.createElement('canvas'); c2.width = w; c2.height = h;
  const ctx = c2.getContext('2d');
  if (ground === 'white') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(img, 0, 0, w, h);
  const chrome = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
  return { mantle: b64(mantle), chrome: b64(chrome), drew };
};
window.__ready = true;
</script></body></html>`;

export async function openChromeRef(launchBrowser) {
  const server = http.createServer((req, res) => {
    try {
      const u = req.url.split('?')[0];
      if (u === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
      }
      const p = decodeURIComponent(u);
      res.writeHead(200, {
        'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript',
      });
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
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // the page says when it is ready (window.__ready), inside ONE deadline shared with the navigation (_pageReady.mjs / pageTimeoutFor): no per-helper ceiling
  await openReady(page, 'http://127.0.0.1:' + server.address().port + '/', {
    ready: 'flag',
    name: '_chromeRef',
  });
  return {
    pageErrors,
    async render(svg, { w, h, ground = 'white', importOpts = null } = {}) {
      const r = await page.evaluate(
        (s, W, H, g, o) => window.__render(s, W, H, g, o),
        svg,
        w,
        h,
        ground,
        importOpts,
      );
      return {
        w,
        h,
        drew: r.drew,
        mantle: new Uint8Array(Buffer.from(r.mantle, 'base64')),
        chrome: new Uint8Array(Buffer.from(r.chrome, 'base64')),
      };
    },
    async close() {
      await browser.close();
      server.close();
    },
  };
}

/// The RGBA at (x, y) of a top-down straight buffer `w` pixels wide.
export function rgbaAt(buf, w, x, y) {
  const i = (y * w + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

/// Per-channel statistics of |a - b| over the rect [x0, x1) x [y0, y1): the mean and the max over all
/// four channels, and how many pixels differ by more than `tol` on any channel.
export function diffStats(a, b, w, [x0, y0, x1, y1], tol = 8) {
  let sum = 0,
    max = 0,
    n = 0,
    over = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      let m = 0;
      for (let k = 0; k < 4; k++) {
        const d = Math.abs(a[i + k] - b[i + k]);
        sum += d;
        if (d > m) m = d;
      }
      if (m > max) max = m;
      if (m > tol) over++;
      n++;
    }
  return { mean: sum / (4 * Math.max(1, n)), max, over, n };
}

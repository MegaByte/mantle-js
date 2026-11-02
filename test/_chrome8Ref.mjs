// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _chrome8Ref.mjs -- like _chromeRef.mjs, but the Chrome side is the AA reference: Chrome's own SVG engine drawn at 8x and
// BOX-AVERAGED down (in premultiplied space) to the cell size, so its edge pixels carry true coverage, not one point sample per pixel.
// Mantle is drawn at 1x. Both come back as STRAIGHT RGBA, top row first, `w * h * 4` bytes.
//
// Compare with `compare(a, b, w, h, { tol, edge })`: `edge` (the Chrome buffer) excludes every pixel whose 3x3 neighborhood is not flat
// there, so the number is about fills, ramps and placement, not a half-pixel of coverage on an outline.
//
//   const ref = await openChrome8Ref(launchBrowser);
//   const { mantle, chrome } = await ref.render(svg, { w, h });
//   const s = compare(mantle, chrome, w, h, { edge: chrome });
import { openReady } from './_pageReady.mjs';
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HTML = `<!DOCTYPE html><html><body style="margin:0"><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
window.__render = async (svg, w, h, o) => {
  if (o.globals) Object.assign(globalThis, o.globals);   // probes: switches a probe reads from globalThis
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; document.body.appendChild(cv);
  const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
  const R = createRenderer(gl, shaders, o.rendererOpts || {}); if (R.ready) await R.ready;
  if (o.route) R.setFillEngine({ route: o.route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, Object.assign({ preserveViewport: true }, o.importOpts || {})));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady && (!o.route || o.route === 'lb')) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.prewarmBundle(b); R.precompileFills();   // the loading call: the frames below draw the programs a game has after loading, not the first-draw stand-ins
  const clear = o.ground === 'white' ? [1, 1, 1, 1] : [0, 0, 0, 0];
  R.setViewport(w, h); gl.viewport(0, 0, w, h);
  // o.overrideSets: [[shape id, override fields], ...] -- an override table drawn with the bundle (the element-transform-as-override cells).
  let table = null;
  const drawOpts = Object.assign({}, o.drawOpts || {});
  if (o.overrideSets) { table = createOverrideTable(gl, b); for (const [k, v] of o.overrideSets) table.set(k, v); drawOpts.overrides = table; }
  for (let i = 0; i < 4; i++) { R.beginFrame(clear); R.drawBundle(b, o.drawOpts || o.overrideSets ? drawOpts : undefined); R.endFrame(); }
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const drew = Object.assign({}, (R.debugStats && R.debugStats.engines && R.debugStats.engines.draws) || {});
  b.dispose && b.dispose(); if (R.dispose) R.dispose();
  { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }   // a page holds at most 16 live contexts; one is made per render
  cv.remove();
  const mantle = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4, d = (y * w + x) * 4, a = px[s + 3];
    mantle[d + 3] = a;
    if (a) for (let k = 0; k < 3; k++) mantle[d + k] = Math.min(255, Math.round(px[s + k] * 255 / a));
  }
  const chromeSvg = o.chromeSvg || svg;
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(chromeSvg); await img.decode();
  const S = o.S || 8;
  const c2 = document.createElement('canvas'); c2.width = w * S; c2.height = h * S;
  const x2 = c2.getContext('2d', { willReadFrequently: true });
  if (o.ground === 'white') { x2.fillStyle = '#fff'; x2.fillRect(0, 0, w * S, h * S); }
  x2.drawImage(img, 0, 0, w * S, h * S);
  const d = x2.getImageData(0, 0, w * S, h * S).data;
  const chrome = new Uint8Array(w * h * 4);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    let r = 0, g = 0, bl = 0, a = 0;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const q = ((yy * S + j) * w * S + xx * S + i) * 4, al = d[q + 3];
      r += d[q] * al; g += d[q + 1] * al; bl += d[q + 2] * al; a += al;
    }
    const n = S * S, o2 = (yy * w + xx) * 4;
    chrome[o2 + 3] = Math.round(a / n);
    if (a > 0) { chrome[o2] = Math.round(r / a); chrome[o2 + 1] = Math.round(g / a); chrome[o2 + 2] = Math.round(bl / a); }
  }
  // Chrome at 1x too: where the browser snaps something to whole pixels, this is what it draws.
  const c1 = document.createElement('canvas'); c1.width = w; c1.height = h;
  const x1 = c1.getContext('2d', { willReadFrequently: true });
  if (o.ground === 'white') { x1.fillStyle = '#fff'; x1.fillRect(0, 0, w, h); }
  x1.drawImage(img, 0, 0, w, h);
  const chrome1 = new Uint8Array(x1.getImageData(0, 0, w, h).data.buffer);
  return { mantle: b64(mantle), chrome: b64(chrome), chrome1: b64(chrome1), drew };
};
window.__ready = true;
</script></body></html>`;

export async function openChrome8Ref(launchBrowser) {
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
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 160));
  });
  try {
    await openReady(page, 'http://127.0.0.1:' + server.address().port + '/', {
      ready: 'flag',
      name: '_chrome8Ref',
    });
  } catch (error) {
    try {
      await browser.close();
    } catch (cleanupError) {
      pageErrors.push('browser cleanup: ' + cleanupError.message);
    } finally {
      await new Promise((done) => server.close(done));
    }
    throw new Error(
      'Chrome8 reference setup failed: ' +
        error.message +
        (pageErrors.length ? '\n' + pageErrors.join('\n') : ''),
      { cause: error },
    );
  }
  const u8 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
  return {
    page,
    pageErrors,
    async render(
      svg,
      {
        w = 128,
        h = 128,
        ground = 'white',
        S = 8,
        importOpts = null,
        rendererOpts = null,
        drawOpts = null,
        chromeSvg = null,
        route = null,
        overrideSets = null,
        globals = null,
      } = {},
    ) {
      const r = await page.evaluate((s, W, H, o) => window.__render(s, W, H, o), svg, w, h, {
        ground,
        S,
        importOpts,
        rendererOpts,
        drawOpts,
        chromeSvg,
        route,
        overrideSets,
        globals,
      });
      return {
        w,
        h,
        drew: r.drew,
        mantle: u8(r.mantle),
        chrome: u8(r.chrome),
        chrome1: u8(r.chrome1),
      };
    },
    async close() {
      await browser.close();
      server.close();
    },
  };
}

/// Statistics of |a - b| over a w x h pair of straight RGBA buffers: the mean over the compared channels, the max, how many pixels
/// differ by more than `tol` on any channel, and how many pixels were compared. `edge` (a buffer) skips every pixel whose 3x3
/// neighborhood in it is not flat (differs by more than 2 on a channel), so a half pixel of coverage on an outline is not scored.
/// A pixel transparent in both is skipped on the color channels.
export function compare(a, b, w, h, { tol = 8, edge = null } = {}) {
  let sum = 0,
    max = 0,
    n = 0,
    over = 0,
    wx = -1,
    wy = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (edge) {
        let flat = true;
        const i0 = (y * w + x) * 4;
        for (let dy = -1; dy <= 1 && flat; dy++)
          for (let dx = -1; dx <= 1 && flat; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx)),
              yy = Math.min(h - 1, Math.max(0, y + dy)),
              j = (yy * w + xx) * 4;
            for (let k = 0; k < 4; k++)
              if (Math.abs(edge[j + k] - edge[i0 + k]) > 2) {
                flat = false;
                break;
              }
          }
        if (!flat) continue;
      }
      const i = (y * w + x) * 4;
      let m = 0;
      for (let k = 0; k < 4; k++) {
        if (k < 3 && a[i + 3] === 0 && b[i + 3] === 0) continue;
        const d = Math.abs(a[i + k] - b[i + k]);
        sum += d;
        if (d > m) m = d;
      }
      if (m > max) {
        max = m;
        wx = x;
        wy = y;
      }
      if (m > tol) over++;
      n++;
    }
  return { mean: sum / (4 * Math.max(1, n)), max, over, n, at: wx < 0 ? null : [wx, wy] };
}

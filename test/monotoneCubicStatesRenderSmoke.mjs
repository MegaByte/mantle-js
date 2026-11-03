// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// monotoneCubicStatesRenderSmoke -- the draw states that do not touch a bundle's cubics (an external clip that passes everything, one sprite of a sheet, a row collapsed by an override's zero scale)
// draw the picture the plain draw draws, at several scales, on either side of the certified-monotone program (MANTLE_NO_CUBIC_SPLITS).
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html>');
    return;
  }
  const f = path.resolve(root, '.' + decodeURIComponent(u.pathname));
  if (!f.startsWith(root + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : 'text/plain');
    res.end(readFileSync(f));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
};
const cap = capWallTime('monotoneCubicStatesRenderSmoke', stop);
console.log(gpuThrottleBanner());
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal', '--enable-gpu'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await installGpuThrottle(page);
  const rows = await page.evaluate(async () => {
    const api = await import('/src/index.js');
    const shaders = await api.loadShaders(new URL('/src/shaders/', location.href));
    // two rows of monotone cubics; the second is what the zero-scale override and the sprite range take away
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="a" d="M10 10 C20 20 40 40 60 90 L10 90Z" fill="#c33"/><path id="b" d="M60 10 C70 11 85 20 90 60 L60 60Z" fill="#36c"/></svg>`;
    const sec = await api.importSvg(svg, { preserveViewport: true });
    const size = 512,
      canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw Error('WebGL2 required');
    const read = () => {
      const p = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, p);
      return p;
    };
    const clip = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, clip);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const out = [];
    for (const k of [1, 0.37, 0.051, 3.3]) {
      const worldMatrix = new Float32Array([k, 0, 0, 0, k, 0, 0, 0, 1]);
      for (const kernel of ['aac', 'slug']) {
        const R = api.createRenderer(gl, shaders, { aacPoints: false });
        await R.ready;
        R.setFillEngine({ route: 'none', kernel });
        R.setViewport(size, size);
        const b = api.createBundle(gl, sec);
        await R.precompileFillsAsync({});
        const hideB = api.createOverrideTable(gl, b);
        hideB.set(1, { visibility: 0 });
        const zeroB = api.createOverrideTable(gl, b);
        zeroB.set(1, { localScale: [0, 1] });
        // Warm the state until a whole pass builds nothing, then read one frame of it.
        const shot = async (fn) => {
          const frame = () => {
            R.beginFrame([1, 1, 1, 1]);
            fn();
            R.endFrame();
          };
          await R.warmScene([{ draw: frame }], { maxPasses: 16 });
          frame();
          return read();
        };
        const cmp = (a, c) => {
          let n = 0,
            max = 0,
            ink = 0;
          for (let i = 0; i < a.length; i += 4) {
            let m = 0;
            for (let j = 0; j < 4; j++) m = Math.max(m, Math.abs(a[i + j] - c[i + j]));
            if (m) n++;
            max = Math.max(max, m);
            if (a[i] !== 255 || a[i + 1] !== 255 || a[i + 2] !== 255) ink++;
          }
          return { n, max, ink };
        };
        const plain = await shot(() => R.drawBundle(b, { worldMatrix }));
        const clipped = await shot(() =>
          R.drawBundle(b, { worldMatrix, extClipTex: clip, extClipMode: 1 }),
        );
        const hidden = await shot(() => R.drawBundle(b, { worldMatrix, overrides: hideB }));
        const zero = await shot(() => R.drawBundle(b, { worldMatrix, overrides: zeroB }));
        const sprite = await shot(() => R.drawSprite(b, [0, 0], { worldMatrix }));
        out.push({
          k,
          kernel,
          clip: cmp(plain, clipped),
          zero: cmp(hidden, zero),
          sprite: cmp(hidden, sprite),
          err: gl.getError(),
        });
        R.dispose();
      }
    }
    return out;
  });
  for (const r of rows) {
    console.log(JSON.stringify(r));
    const t = `scale ${r.k} ${r.kernel}`;
    ok(
      r.clip.ink > 0 && r.clip.max <= 1,
      `${t}: a clip that passes everything draws the plain picture (${r.clip.n} px, max ${r.clip.max}/255)`,
    );
    ok(
      r.zero.max <= 1,
      `${t}: a zero-scale row draws what a hidden row draws (${r.zero.n} px, max ${r.zero.max}/255)`,
    );
    ok(
      r.sprite.max <= 1,
      `${t}: a one-row sprite draws what the rest hidden draws (${r.sprite.n} px, max ${r.sprite.max}/255)`,
    );
    ok(r.err === 0, `${t}: no GL error (${r.err})`);
  }
} catch (e) {
  console.error(e);
  fail++;
} finally {
  clearTimeout(cap);
  await stop();
}
console.log(fail ? `\n${fail} FAILED` : '\nPASS');
process.exit(fail ? 1 : 0);

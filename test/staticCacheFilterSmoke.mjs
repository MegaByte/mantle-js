// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// A node using the whole-asset cache whose SVG carries a filter
// (here feGaussianBlur, which exercises the filter region's offscreen RT +
// composite) must bake correctly. Composites must target the cache FBO
// during a bake, not the canvas — otherwise the blit comes back blank/wrong.
// Asserts RMSE(live, cached) stays low.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const mime = (p) =>
  p.endsWith('.html')
    ? 'text/html'
    : p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
const server = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://l');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  let b = null;
  try {
    b = readFileSync(path.join(ROOT, p));
  } catch {}
  if (b) {
    r.writeHead(200, { 'content-type': mime(p) });
    r.end(b);
  } else {
    r.writeHead(404);
    r.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;
const BLUR = readFileSync(
  new URL('../examples/smoke/staticCacheFilter__BLUR.svg', import.meta.url),
  'utf8',
);
const br = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const pg = await br.newPage();
await pg.setViewport({ width: 300, height: 300 });
pg.on('pageerror', (e) => console.error('[page]', e.message));
await pg.goto(url, { waitUntil: 'load', timeout: 15000 });
await pg.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
  timeout: 15000,
  polling: 100,
});
const out = await pg.evaluate(async (BLUR) => {
  const { importSvg, createBundle, CacheStrategy } = await import('/src/index.js');
  const gl = window.__mantleGl,
    r = window.__mantleRenderer,
    cnv = document.getElementById('glcanvas');
  cnv.width = 300;
  cnv.height = 300;
  r.setViewport(300, 300);
  const grab = () => {
    const px = new Uint8Array(cnv.width * cnv.height * 4);
    gl.readPixels(0, 0, cnv.width, cnv.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  let nonbg = 0;
  const b = createBundle(gl, await importSvg(BLUR));
  const liveHandle = r.createBundleHandle(b);
  const cachedHandle = r.createBundleHandle(b, {
    staticCache: { strategy: CacheStrategy.ForceWholeAsset },
  });
  // Card-sized, fully on-screen source and destination: the cache must
  // translate the already-filtered raster without losing or double-shifting it.
  const initial = new Float32Array([0.45, 0, 0, 0, 0.45, 0, -0.25, 0, 1]);
  const moved = new Float32Array([0.45, 0, 0, 0, 0.45, 0, 0.25, 0, 1]);
  const draw = (handle, worldMatrix) => {
    r.beginFrame([1, 1, 1, 1]);
    handle.draw({ worldMatrix });
    r.endFrame();
    return grab();
  };
  const live = draw(liveHandle, initial);
  const cached = draw(cachedHandle, initial);
  const cachedMoved = draw(cachedHandle, moved);
  const liveMoved = draw(liveHandle, moved);
  let se = 0;
  for (let i = 0; i < live.length; i++) se += (live[i] - cached[i]) ** 2;
  let movedSe = 0;
  for (let i = 0; i < liveMoved.length; i++) movedSe += (liveMoved[i] - cachedMoved[i]) ** 2;
  for (let i = 0; i < live.length; i += 4)
    if (live[i] > 50 || live[i + 1] > 50 || live[i + 2] > 50) nonbg++;
  const redBounds = (px) => {
    let x0 = 300,
      y0 = 300,
      x1 = -1,
      y1 = -1,
      count = 0;
    for (let y = 0; y < 300; y++)
      for (let x = 0; x < 300; x++) {
        const i = (y * 300 + x) * 4;
        if (px[i] > 200 && px[i + 1] < 100 && px[i + 2] < 50) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
          count++;
        }
      }
    return [x0, y0, x1, y1, count];
  };
  return {
    rmse: Math.sqrt(se / live.length),
    movedRmse: Math.sqrt(movedSe / liveMoved.length),
    liveNonBg: nonbg,
    px: live.length / 4,
    cacheValid: cachedHandle.staticCache?.isCacheValid,
    liveMovedRed: redBounds(liveMoved),
    cachedMovedRed: redBounds(cachedMoved),
  };
}, BLUR);
await br.close();
server.close();
console.log(
  `  live non-bg px=${out.liveNonBg}; RMSE(initial)=${out.rmse.toFixed(2)}; RMSE(translated)=${out.movedRmse.toFixed(2)}; red=${JSON.stringify(out.liveMovedRed)}/${JSON.stringify(out.cachedMovedRed)}`,
);
const [lx0, ly0, lx1, ly1, ln] = out.liveMovedRed;
const [cx0, cy0, cx1, cy1, cn] = out.cachedMovedRed;
const aligned =
  Math.abs(lx0 - cx0) <= 2 &&
  Math.abs(ly0 - cy0) <= 2 &&
  Math.abs(lx1 - cx1) <= 2 &&
  Math.abs(ly1 - cy1) <= 2;
const ok =
  out.liveNonBg > 1000 && out.cacheValid && out.rmse < 6 && ln > 1000 && cn > 1000 && aligned;
console.log(
  ok
    ? 'staticCacheFilterSmoke: PASS'
    : 'staticCacheFilterSmoke: FAIL (filtered cache diverged after translation)',
);
process.exit(ok ? 0 : 1);

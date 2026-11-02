// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// arcDeepZoomRenderSmoke -- a native arc stays filled at any zoom, under the walk itself.
//
// The walk clips an arc to a pixel's y window by solving for the angle at each edge of it. An angle up to 2 pi is a float with an ulp of 2^-21, so from a radius of 2^21
// device px both solves can return one float, and a piece taken as having no length would read 0: whole rows, then all of them. The piece still crosses the window, and its y
// ends are known. On a real GPU, against the exact shape in float64: an ellipse, a path of arcs and a gradient-filled circle (none of them tagged for a closed form), at
// several points of the outline, upright and under the rotated-map walker, a mirror and an anisotropic map; and a pinned engine's walk on a tagged circle. Every pixel further
// from the true edge than the float format's own error (a few pixels plus a multiple of 2^-24 of the radius and of the matrix's reach) is right.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 512;
const ELLIPSE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><ellipse cx="64" cy="64" rx="48" ry="36" fill="#d33"/></svg>';
const ARCS =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M16 64 A48 48 0 1 1 112 64 A48 48 0 1 1 16 64 Z" fill="#d33"/></svg>';
const GRADIENT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g"><stop offset="0" stop-color="#d33"/><stop offset="1" stop-color="#d33"/></linearGradient></defs><circle cx="64" cy="64" r="48" fill="url(#g)"/></svg>';
const CIRCLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="48" fill="#d33"/></svg>';
const cSd = (x, y) => Math.hypot(x - 64, y - 64) - 48,
  eSd = (x, y) => Math.hypot((x - 64) / 48, (y - 64) / 36) - 1;
const cAt = (t) => [64 + 48 * Math.cos(t), 64 + 48 * Math.sin(t)],
  eAt = (t) => [64 + 48 * Math.cos(t), 64 + 36 * Math.sin(t)];
const SHAPES = {
  ellipse: { svg: ELLIPSE, sd: eSd, at: eAt },
  'path of arcs': { svg: ARCS, sd: cSd, at: cAt },
  'gradient-filled circle': { svg: GRADIENT, sd: cSd, at: cAt },
};
const MAPS = {
  upright: [1, 0, 0, 1],
  turned: [
    Math.cos(Math.PI / 6),
    Math.sin(Math.PI / 6),
    -Math.sin(Math.PI / 6),
    Math.cos(Math.PI / 6),
  ],
  mirrored: [-1, 0, 0, 1],
  anisotropic: [1, 0, 0, 1 / 64],
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${W}" height="${W}"></canvas><script type="module">
const api = await import('/src/index.js');
const shaders = await api.loadShaders(new URL('/src/shaders/', location.href).href);
const gl = document.getElementById('c').getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, depth: true, stencil: true });
window.__device = () => { const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); };
window.__run = async (svg, matrices, engine) => {
  const r = api.createRenderer(gl, shaders, { nonBlocking: false, asyncShaderCompile: false }); if (r.ready) await r.ready;
  if (engine) r.setFillEngine(engine);
  r.setViewport(${W}, ${W});
  const b = api.createBundle(gl, await api.importSvg(svg, { preserveViewport: true }));
  const out = [];
  for (const m of matrices) {
    const wm = new Float32Array(m);
    const draw = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, ${W}, ${W}); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT); r.drawBundle(b, { worldMatrix: wm }); };
    draw(); if (r.ready) await r.ready;
    draw();
    const p = new Uint8Array(${W * W * 4}); gl.readPixels(0, 0, ${W}, ${W}, gl.RGBA, gl.UNSIGNED_BYTE, p);
    const a = new Uint8Array(${W * W}); for (let i = 0; i < a.length; i++) a[i] = p[i * 4 + 3];
    let s = ''; for (let k = 0; k < a.length; k += 8192) s += String.fromCharCode.apply(null, a.subarray(k, k + 8192));
    out.push({ a: btoa(s), route: JSON.stringify((r.debugStats.engines || {}).viaRoute || {}), glError: gl.getError() });
  }
  b.dispose(); r.dispose();
  return out;
};
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
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
      ? ['--no-sandbox', '--enable-unsafe-swiftshader']
      : ['--no-sandbox', '--use-angle=metal', '--use-gl=angle'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await openReady(page, `http://127.0.0.1:${server.address().port}/`, {
  name: 'arcDeepZoomRenderSmoke',
});
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const device = await page.evaluate(() => window.__device());
if (process.env.MANTLE_TEST_GL !== 'swiftshader')
  ok(
    /Apple|Metal/.test(device) && !/SwiftShader|software/i.test(device),
    `physical Metal device: ${device}`,
  );

const matrix = (L0, z, ex, ey) => {
  const L = L0.map((v) => v * z),
    px = ex / 64 - 1,
    py = 1 - ey / 64;
  return [
    L[0],
    L[1],
    0,
    L[2],
    L[3],
    0,
    0.125 - (L[0] * px + L[2] * py),
    0.0625 - (L[1] * px + L[3] * py),
    1,
  ];
};
const run = async (svg, ms, engine) => {
  const rs = await page.evaluate((s, m, e) => window.__run(s, m, e), svg, ms, engine || null);
  for (const r of rs) r.px = Buffer.from(r.a, 'base64');
  return rs;
};
const wrongFar = (px, m0, sd, reach) => {
  const m = m0.map(Math.fround),
    det = m[0] * m[4] - m[3] * m[1],
    toEm = (i, j) => {
      const qx = (i / W) * 2 - 1 - m[6],
        qy = (j / W) * 2 - 1 - m[7];
      return [((m[4] * qx - m[3] * qy) / det + 1) * 64, (1 - (-m[1] * qx + m[0] * qy) / det) * 64];
    };
  let wrong = 0,
    ink = 0,
    inside = 0;
  for (let j = 0; j < W; j++)
    for (let i = 0; i < W; i++) {
      const v = px[j * W + i],
        [x, y] = toEm(i + 0.5, j + 0.5),
        inS = sd(x, y) < 0;
      if (v) ink++;
      if (inS) inside++;
      if (inS === v >= 128) continue;
      let same = true;
      for (const [a, b] of [
        [-reach, -reach],
        [reach, -reach],
        [-reach, reach],
        [reach, reach],
      ]) {
        const [xx, yy] = toEm(i + 0.5 + a, j + 0.5 + b);
        if (sd(xx, yy) < 0 !== inS) {
          same = false;
          break;
        }
      }
      if (same) wrong++;
    }
  return { wrong, ink, inside };
};
const Z = [14, 16, 18, 20];
const check = (label, r, m, sd, zl) => {
  const Rpx = 48 * (W / 128) * 2 ** zl,
    reach = 2 + 8 * (Rpx + (2 ** zl * W) / 2) * 2 ** -24;
  const { wrong, ink, inside } = wrongFar(r.px, m, sd, reach);
  ok(
    r.glError === 0 && wrong === 0,
    `${label}, zoom 2^${zl}: ${wrong} px wrong further than ${reach.toFixed(1)} px from the outline (ink ${ink}, inside ${inside}; ${r.route})`,
  );
};
for (const [sn, sh] of Object.entries(SHAPES))
  for (const [mn, L0] of Object.entries(MAPS))
    for (const deg of [-45, -90, -120, 30]) {
      const [ex, ey] = sh.at((deg * Math.PI) / 180),
        ms = Z.map((zl) => matrix(L0, 2 ** zl, ex, ey)),
        rs = await run(sh.svg, ms);
      rs.forEach((r, k) => check(`${sn}, ${mn}, ${deg} deg`, r, ms[k], sh.sd, Z[k]));
    }
// The walk is the pinned engines' too: a pinned kernel draws a tagged circle by it, and stays filled.
for (const [name, engine] of [
  ['route none, kernel slug', { route: 'none', kernel: 'slug' }],
  ['route none, kernel aac', { route: 'none', kernel: 'aac' }],
]) {
  const [ex, ey] = cAt(-Math.PI / 4),
    ms = Z.map((zl) => matrix(MAPS.upright, 2 ** zl, ex, ey)),
    rs = await run(CIRCLE, ms, engine);
  rs.forEach((r, k) => check(`pinned ${name}, tagged circle`, r, ms[k], cSd, Z[k]));
}
await browser.close();
server.close();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);

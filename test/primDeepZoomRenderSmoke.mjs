// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primDeepZoomRenderSmoke -- a tagged circle or round rect takes a closed form past the arc walk's float32 bound, and nothing moves under it.
//
// The walk places an arc through its angle, and an angle up to 2 pi is a float with an ulp of 2^-21, so from a radius of 2^21 device px its edge is pixels off and growing.
// On a real GPU, against the exact shape in float64:
//   - past the bound, every pixel further from the true edge than the float format's own error (a few pixels plus a multiple of 2^-24 of the radius) is right, at
//     several points of the outline and under a rotated, mirrored and anisotropic map, and the same at any authored scale;
//   - on the arc itself at 2^18 and 2^20 it reads fewer wrong pixels than the walk of the pin (what the closed form is for);
//   - under the bound the default program draws what a pinned walk draws, to the rounding of two compiles;
//   - a pinned engine keeps its walk, and `primitives: 'on'` and the default do not;
//   - and a native arc that is NOT tagged for a closed form stays filled at any zoom under the walk itself (below).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 512;
const CIRCLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><circle cx="64" cy="64" r="48" fill="#d33"/></svg>';
const RRECT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="16" y="16" width="96" height="96" rx="32" fill="#d33"/></svg>';
const CIRCLE_SMALL =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0.125 0.125"><circle cx="0.0625" cy="0.0625" r="0.046875" fill="#d33"/></svg>';
const CIRCLE_LARGE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 131072 131072"><circle cx="65536" cy="65536" r="49152" fill="#d33"/></svg>';
const cSd = (s) => (x, y) => Math.hypot(x - 64 * s, y - 64 * s) - 48 * s;
const rSd = (x, y) => {
  const ex = Math.abs(x - 64) - 16,
    ey = Math.abs(y - 64) - 16;
  return Math.min(Math.max(ex, ey), 0) + Math.hypot(Math.max(ex, 0), Math.max(ey, 0)) - 32;
};
const SHAPES = {
  circle: {
    svg: CIRCLE,
    sd: cSd(1),
    radius: 48,
    at: (t) => [64 + 48 * Math.cos(t), 64 + 48 * Math.sin(t)],
  },
  'round rect': {
    svg: RRECT,
    sd: rSd,
    radius: 32,
    at: (t) => [
      64 + Math.sign(Math.cos(t) || 1) * 16 + 32 * Math.cos(t),
      64 + Math.sign(Math.sin(t) || 1) * 16 + 32 * Math.sin(t),
    ],
  },
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
const PIN_SLUG = { route: 'none', kernel: 'slug' };

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
    out.push({ a: btoa(s), key: r.debugStats.drawnFillVariantKey || '', route: JSON.stringify((r.debugStats.engines || {}).viaRoute || {}), glError: gl.getError() });
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
  name: 'primDeepZoomRenderSmoke',
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

// clip = L * plane + t, plane = (2x / size - 1, 1 - 2y / size); the outline point (ex, ey) lands on clip (0.125, 0.0625)
const matrix = (L0, z, ex, ey, size = 128) => {
  const L = L0.map((v) => v * z),
    px = (2 * ex) / size - 1,
    py = 1 - (2 * ey) / size;
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
// A pixel is WRONG when it reads the wrong side of the true outline and the whole square `reach` device px around it lies on one side.
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

// PAST THE BOUND. In px at the top of the draw's scale, the radius is 2^k: the zooms are 2^12.4 .. 2^20 of a shape that fills most of the canvas.
// One renderer and bundle per shape draws every map, angle and zoom (the program is chosen per draw).
const Z = [14, 16, 18, 20];
for (const [sn, sh] of Object.entries(SHAPES)) {
  const sets = [];
  for (const [mn, L0] of Object.entries(MAPS))
    for (const deg of [-45, -90, -120, 30]) {
      const [ex, ey] = sh.at((deg * Math.PI) / 180);
      sets.push({ mn, deg, ms: Z.map((zl) => matrix(L0, 2 ** zl, ex, ey)) });
    }
  const all = await run(
    sh.svg,
    sets.flatMap((t) => t.ms),
  );
  sets.forEach(({ mn, deg, ms }, q) => {
    const rs = all.slice(q * Z.length, (q + 1) * Z.length);
    rs.forEach((r, k) => {
      const Rpx = sh.radius * (W / 128) * 2 ** Z[k];
      // the float format's error: 2^-24 of the radius (the distance), and of the matrix's own reach on the canvas (a turned matrix's terms do not cancel), with room for the pixel's coordinate and interpolation
      const reach = 2 + 8 * (Rpx + (2 ** Z[k] * W) / 2) * 2 ** -24;
      const { wrong, ink, inside } = wrongFar(r.px, ms[k], sh.sd, reach);
      ok(
        r.glError === 0 && wrong === 0 && (inside === 0 || ink > 0),
        `${sn}, ${mn}, ${deg} deg, zoom 2^${Z[k]}: ${wrong} px wrong further than ${reach.toFixed(1)} px from the outline (ink ${ink}, inside ${inside}; ${r.route})`,
      );
    });
  });
}

// UNDER THE WALK ITSELF: a native arc stays filled at any zoom.
//
// The walk clips an arc to a pixel's y window by solving for the angle at each edge of it. An angle up to 2 pi is a float with an ulp of 2^-21, so from a radius of 2^21
// device px both solves can return one float, and a piece taken as having no length would read 0: whole rows, then all of them. The piece still crosses the window, and its y
// ends are known. Against the exact shape in float64: an ellipse, a path of arcs and a gradient-filled circle (none of them tagged for a closed form), at several points of
// the outline, upright and under the rotated-map walker, a mirror and an anisotropic map; and a pinned engine's walk on a tagged circle. Every pixel further from the true
// edge than the float format's own error (a few pixels plus a multiple of 2^-24 of the radius and of the matrix's reach) is right. One renderer and bundle per shape draws
// every map, angle and zoom, as above.
{
  const ELLIPSE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><ellipse cx="64" cy="64" rx="48" ry="36" fill="#d33"/></svg>';
  const ARCS =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M16 64 A48 48 0 1 1 112 64 A48 48 0 1 1 16 64 Z" fill="#d33"/></svg>';
  const GRADIENT =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><linearGradient id="g"><stop offset="0" stop-color="#d33"/><stop offset="1" stop-color="#d33"/></linearGradient></defs><circle cx="64" cy="64" r="48" fill="url(#g)"/></svg>';
  const cSd1 = cSd(1),
    eSd = (x, y) => Math.hypot((x - 64) / 48, (y - 64) / 36) - 1;
  const cAt = (t) => [64 + 48 * Math.cos(t), 64 + 48 * Math.sin(t)],
    eAt = (t) => [64 + 48 * Math.cos(t), 64 + 36 * Math.sin(t)];
  const ARC_SHAPES = {
    ellipse: { svg: ELLIPSE, sd: eSd, at: eAt },
    'path of arcs': { svg: ARCS, sd: cSd1, at: cAt },
    'gradient-filled circle': { svg: GRADIENT, sd: cSd1, at: cAt },
  };
  const check = (label, r, m, sd, zl) => {
    const Rpx = 48 * (W / 128) * 2 ** zl,
      reach = 2 + 8 * (Rpx + (2 ** zl * W) / 2) * 2 ** -24;
    const { wrong, ink, inside } = wrongFar(r.px, m, sd, reach);
    ok(
      r.glError === 0 && wrong === 0,
      `${label}, zoom 2^${zl}: ${wrong} px wrong further than ${reach.toFixed(1)} px from the outline (ink ${ink}, inside ${inside}; ${r.route})`,
    );
  };
  for (const [sn, sh] of Object.entries(ARC_SHAPES)) {
    const sets = [];
    for (const [mn, L0] of Object.entries(MAPS))
      for (const deg of [-45, -90, -120, 30]) {
        const [ex, ey] = sh.at((deg * Math.PI) / 180);
        sets.push({
          label: `${sn}, ${mn}, ${deg} deg`,
          ms: Z.map((zl) => matrix(L0, 2 ** zl, ex, ey)),
        });
      }
    const all = await run(
      sh.svg,
      sets.flatMap((t) => t.ms),
    );
    sets.forEach(({ label, ms }, q) =>
      all
        .slice(q * Z.length, (q + 1) * Z.length)
        .forEach((r, k) => check(label, r, ms[k], sh.sd, Z[k])),
    );
  }
  // The walk is the pinned engines' too: a pinned kernel draws a tagged circle by it, and stays filled.
  for (const [name, engine] of [
    ['route none, kernel slug', PIN_SLUG],
    ['route none, kernel aac', { route: 'none', kernel: 'aac' }],
  ]) {
    const [ex, ey] = cAt(-Math.PI / 4),
      ms = Z.map((zl) => matrix(MAPS.upright, 2 ** zl, ex, ey)),
      rs = await run(CIRCLE, ms, engine);
    rs.forEach((r, k) => check(`pinned ${name}, tagged circle`, r, ms[k], cSd1, Z[k]));
  }
}

// WHAT THE CLOSED FORM IS FOR: the walk's edge is off by the radius times the angle's ulp, the closed form's by the coordinates'.
for (const [sn, sh, deg] of [
  ['circle', SHAPES.circle, -90],
  ['round rect', SHAPES['round rect'], -120],
]) {
  const [ex, ey] = sh.at((deg * Math.PI) / 180),
    ms = [18, 20].map((zl) => matrix(MAPS.upright, 2 ** zl, ex, ey));
  const def = await run(sh.svg, ms),
    pin = await run(sh.svg, ms, PIN_SLUG);
  ms.forEach((m, k) => {
    const a = wrongFar(def[k].px, m, sh.sd, 0).wrong,
      b = wrongFar(pin[k].px, m, sh.sd, 0).wrong;
    ok(
      a < b,
      `${sn}, ${deg} deg, zoom 2^${[18, 20][k]}: the closed form reads ${a} px on the wrong side of the outline, the walk ${b}`,
    );
  });
}

// ANY AUTHORED SCALE: a power of two scales every float exactly, so the shape reads the same pixels (the gate is in device px, not em).
{
  const [ex, ey] = SHAPES.circle.at(-Math.PI / 4),
    z = 2 ** 16,
    zs = [z];
  const refM = zs.map(() => matrix(MAPS.upright, z, ex, ey));
  const [ref] = await run(CIRCLE, refM);
  for (const [name, svg, size] of [
    ['1/1024', CIRCLE_SMALL, 0.125],
    ['1024', CIRCLE_LARGE, 131072],
  ]) {
    const s = size / 128,
      [o] = await run(svg, [matrix(MAPS.upright, z, ex * s, ey * s, size)]);
    let n = 0,
      mx = 0;
    for (let i = 0; i < o.px.length; i++) {
      const d = Math.abs(o.px[i] - ref.px[i]);
      if (d) n++;
      if (d > mx) mx = d;
    }
    ok(
      mx <= 1,
      `the circle authored at ${name} reads the same pixels at 2^16: ${n} differ, max ${mx}`,
    );
  }
}

// UNDER THE BOUND: the default's program and a pinned walk's differ by the gate alone. 1/255 is the rounding between two compiles.
for (const [sn, sh] of Object.entries(SHAPES)) {
  const [ex, ey] = sh.at(-Math.PI / 4);
  const zs = [1, 3, 16, 1024, 2 ** 12];
  const ms = zs.map((z) => matrix(MAPS.upright, z, ex, ey));
  const def = await run(sh.svg, ms),
    pin = await run(sh.svg, ms, PIN_SLUG);
  zs.forEach((z, k) => {
    let n = 0,
      mx = 0;
    for (let i = 0; i < def[k].px.length; i++) {
      const d = Math.abs(def[k].px[i] - pin[k].px[i]);
      if (d) n++;
      if (d > mx) mx = d;
    }
    ok(
      mx <= 1,
      `${sn} at scale ${z}, radius 2^${Math.log2(sh.radius * (W / 128) * z).toFixed(1)} px: the default draws the walk (${n} differ, max ${mx})`,
    );
  });
}

// THE PIN. A pinned engine, or primitives off, compiles the gate out; the default and an explicit primitives: 'on' keep it.
{
  const [ex, ey] = SHAPES.circle.at(-Math.PI / 4),
    m = [matrix(MAPS.upright, 2 ** 18, ex, ey)];
  for (const [name, engine, wants] of [
    ['default', null, false],
    ['route none, kernel slug', PIN_SLUG, true],
    ['kernel aac', { kernel: 'aac' }, true],
    ['kernel hard-band', { kernel: 'hard-band' }, true],
    ['primitives off', { primitives: 'off' }, true],
  ]) {
    const [r] = await run(CIRCLE, m, engine);
    ok(
      r.key.includes('MANTLE_PRIM_WALK') === wants,
      `${name}: the program ${wants ? 'keeps the walk' : 'may take the closed form'} (${r.key || 'base program'})`,
    );
  }
}
await browser.close();
server.close();
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);

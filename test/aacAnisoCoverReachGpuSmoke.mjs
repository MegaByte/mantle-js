// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// A raw AAC cover under an AXIS-ALIGNED ANISOTROPIC map (x1.3 by y0.55, no rotation or shear) must reach every pixel its box
// touches. The cover corner's bisector push is half a pixel along ONE screen direction (~0.19 px along y at 0.55/1.3), and
// a program that adds the affine support only for rotated maps would lose any pixel row a shape's extreme pokes less than
// ~0.3 px into (10 pixels, 20 alpha bytes at some sub-pixel phases). Scored against an INDEPENDENT exact-area oracle, at the authored
// scale and with the geometry scaled by 2^-20 and 2^20 (no absolute epsilon).
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rot = (d, s = 1) => {
  const c = Math.cos((d * Math.PI) / 180) * s,
    n = Math.sin((d * Math.PI) / 180) * s;
  return [c, n, 0, -n, c, 0, 0, 0, 1];
};
const sh = (M, dx, dy) => {
  const m = M.slice();
  m[6] += (dx * 2) / 128;
  m[7] += (dy * 2) / 128;
  return m;
};
const AX = [1.3, 0, 0, 0, 0.55, 0, 0, 0, 1],
  AY = [0.55, 0, 0, 0, 1.3, 0, 0, 0, 1]; // axis-aligned ANISOTROPIC maps
const CASES = [
  { name: 'aniso-x1.3-y.55 dy.75', size: 128, k: 0, M: sh(AX, 0, 0.75) },
  { name: 'aniso-x1.3-y.55 dx.75', size: 128, k: 0, M: sh(AX, 0.75, 0) },
  { name: 'aniso-x.55-y1.3 dy.75', size: 128, k: 0, M: sh(AY, 0, 0.75) },
  { name: 'aniso-x.55-y1.3 dx.75', size: 128, k: 0, M: sh(AY, 0.75, 0) },
  { name: 'aniso dy.75 2^-20', size: 128, k: -20, M: sh(AX, 0, 0.75) },
  { name: 'aniso dy.75 2^20', size: 128, k: 20, M: sh(AX, 0, 0.75) },
];
const MAX_ERR = 2; // alpha bytes against exact area: raw AAC measures <= 1.1 on these maps; the short cover loses a faint row (20 bytes, 10 pixels)
const server = http.createServer((q, res) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html>');
    return;
  }
  const f = path.resolve(root, '.' + decodeURIComponent(u.pathname));
  if (!f.startsWith(root + path.sep) || f.includes('/generated/')) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', /\.m?js$/.test(f) ? 'text/javascript' : 'text/plain');
    res.end(readFileSync(f));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  server.close();
};
const cap = capWallTime('aacAnisoCoverReach', stop, 180000);
console.log(gpuThrottleBanner());
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  await installGpuThrottle(page);
  for (const c of CASES) {
    const r = await page.evaluate(async (c) => {
      const api = await import('/src/index.js'),
        shaders = await api.loadShaders(new URL('/src/shaders/', location.href));
      (await import('/src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false);
      const N = c.size,
        VB = 128,
        S = 2 ** c.k,
        M = c.M;
      const Q = [
        [95.8, 63.85, 95.8, 94.6, 64.3, 94.6],
        [64.3, 94.6, 32.8, 94.6, 32.8, 63.85],
        [32.8, 63.85, 32.8, 33.1, 64.3, 33.1],
        [64.3, 33.1, 95.8, 33.1, 95.8, 63.85],
      ];
      const f6 = (v) => (v * S).toPrecision(9);
      const d =
        'M' +
        f6(Q[0][0]) +
        ',' +
        f6(Q[0][1]) +
        Q.map((q) => 'Q' + f6(q[2]) + ',' + f6(q[3]) + ' ' + f6(q[4]) + ',' + f6(q[5])).join('') +
        'Z';
      const mk = (x, y) =>
        `<rect x="${f6(x)}" y="${f6(y)}" width="${f6(1)}" height="${f6(1)}" fill="#fff" fill-opacity="0.01"/>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f6(VB)} ${f6(VB)}"><path fill="#fff" d="${d}"/>${mk(0, 0)}${mk(127, 127)}</svg>`;
      // Exact-area oracle. World matrix: row vectors, y up, NDC translation; the fit maps the viewBox onto the N px target.
      const h = VB / 2,
        as = M[0],
        bs = -M[1],
        cs = -M[3],
        ds = M[4];
      const e = h - as * h - cs * h + M[6] * h,
        f = h - bs * h - ds * h - M[7] * h,
        sc = N / VB;
      const X = (x, y) => [(as * x + cs * y + e) * sc, (bs * x + ds * y + f) * sc];
      const poly = [];
      const K = 2048;
      for (const q of Q)
        for (let k = 0; k < K; k++) {
          const t = k / K,
            u = 1 - t;
          poly.push(
            X(
              u * u * q[0] + 2 * u * t * q[2] + t * t * q[4],
              u * u * q[1] + 2 * u * t * q[3] + t * t * q[5],
            ),
          );
        }
      const clip = (P, x0, y0) => {
        let cur = P;
        for (const dd of [
          (p) => p[0] - x0,
          (p) => x0 + 1 - p[0],
          (p) => p[1] - y0,
          (p) => y0 + 1 - p[1],
        ]) {
          const out = [];
          for (let i = 0; i < cur.length; i++) {
            const a = cur[i],
              b = cur[(i + 1) % cur.length],
              da = dd(a),
              db = dd(b);
            if (da >= 0) out.push(a);
            if (da >= 0 !== db >= 0) {
              const t = da / (da - db);
              out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
            }
          }
          cur = out;
          if (!cur.length) return 0;
        }
        let A = 0;
        for (let i = 0; i < cur.length; i++) {
          const a = cur[i],
            b = cur[(i + 1) % cur.length];
          A += a[0] * b[1] - b[0] * a[1];
        }
        return Math.abs(A) / 2;
      };
      const orc = new Float64Array(N * N),
        touched = new Set();
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i],
          b = poly[(i + 1) % poly.length];
        for (let y = Math.floor(Math.min(a[1], b[1])); y <= Math.floor(Math.max(a[1], b[1])); y++)
          for (let x = Math.floor(Math.min(a[0], b[0])); x <= Math.floor(Math.max(a[0], b[0])); x++)
            if (x >= 0 && y >= 0 && x < N && y < N) touched.add(y * N + x);
      }
      for (const id of touched) {
        const x = id % N,
          y = (id - x) / N;
        orc[id] = 255 * clip(poly, x, y);
      }
      for (let y = 0; y < N; y++) {
        const yc = y + 0.5,
          xs = [];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i],
            b = poly[(i + 1) % poly.length];
          if (a[1] <= yc !== b[1] <= yc)
            xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
        xs.sort((p, q) => p - q);
        for (let k = 0; k + 1 < xs.length; k += 2)
          for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x < N && x + 0.5 < xs[k + 1]; x++)
            if (!touched.has(y * N + x)) orc[y * N + x] = 255;
      }
      for (const [mx, my] of [
        [0, 0],
        [127, 127],
      ]) {
        const P = [X(mx, my), X(mx + 1, my), X(mx + 1, my + 1), X(mx, my + 1)];
        for (
          let y = Math.max(0, Math.floor(Math.min(...P.map((p) => p[1]))));
          y <= Math.min(N - 1, Math.floor(Math.max(...P.map((p) => p[1]))));
          y++
        )
          for (
            let x = Math.max(0, Math.floor(Math.min(...P.map((p) => p[0]))));
            x <= Math.min(N - 1, Math.floor(Math.max(...P.map((p) => p[0]))));
            x++
          )
            orc[y * N + x] += 0.01 * 255 * clip(P, x, y);
      }
      const cv = document.createElement('canvas');
      cv.width = cv.height = N;
      const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (/swiftshader|llvmpipe|software/i.test(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)))
        throw Error('Physical GPU required');
      const progs = new Map(),
        srcs = [];
      for (const key of [
        'drawArrays',
        'drawArraysInstanced',
        'drawElements',
        'drawElementsInstanced',
      ]) {
        const fn = gl[key].bind(gl);
        gl[key] = (...a) => {
          const p = gl.getParameter(gl.CURRENT_PROGRAM);
          if (!progs.has(p)) {
            progs.set(p, 1);
            srcs.push(
              gl
                .getAttachedShaders(p)
                .map((s) => gl.getShaderSource(s))
                .join('\n'),
            );
          }
          return fn(...a);
        };
      }
      const bundle = api.createBundle(gl, await api.importSvg(svg, { preserveViewport: true }));
      const rr = api.createRenderer(gl, shaders, { aacFill: true, aacPoints: false });
      rr.setFillEngine({ route: 'none', kernel: 'aac' }); // raw AAC cover, an axis-aligned anisotropic map
      rr.setViewport(N, N);
      const score = (px) => {
        let max = 0,
          miss = 0,
          stray = 0,
          at = null;
        for (let y = 0; y < N; y++)
          for (let x = 0; x < N; x++) {
            const o = orc[y * N + x],
              a = px[((N - 1 - y) * N + x) * 4 + 3];
            if (Math.abs(a - o) > max) {
              max = Math.abs(a - o);
              at = [x, y, a, +o.toFixed(2)];
            }
            if (o >= 2.5 && a === 0) miss++;
            if (o < 1 && a >= 3) stray++;
          }
        return { max, miss, stray, at };
      };
      const frames = [];
      for (let i = 0; i < 3; i++) {
        rr.beginFrame([0, 0, 0, 0]);
        rr.drawBundle(bundle, { worldMatrix: M });
        rr.endFrame();
        if (!(await window.__gpuFence(gl, 30000))) throw Error('fence');
        const px = new Uint8Array(N * N * 4);
        gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
        frames.push({
          ...score(px),
          nprog: srcs.length,
          defs: [
            ...new Set(
              srcs.flatMap((s) =>
                [...s.matchAll(/^\s*#define\s+(MANTLE_AAC|MANTLE_ROTATED_MAP)\s*$/gm)].map(
                  (m) => m[1],
                ),
              ),
            ),
          ].join('+'),
        });
        await window.__gpuIdle(2);
      }
      if (gl.getError()) throw Error('GL error');
      const out = {
        frames,
        slug: rr.debugStats.engines.draws.slug,
        ledger: JSON.stringify(rr.debugStats.engines.draws),
        anyRot: srcs.some((s) => /^\s*#define\s+MANTLE_ROTATED_MAP\s*$/m.test(s)),
      };
      bundle.dispose();
      rr.dispose();
      gl.getExtension('WEBGL_lose_context').loseContext();
      return out;
    }, c);
    console.log(
      `  ${c.name}: ledger ${r.ledger}, rotated-map program ${r.anyRot}; frame max/missing/stray: ` +
        r.frames
          .map(
            (f) =>
              `${f.max.toFixed(2)}/${f.miss}/${f.stray} at ${JSON.stringify(f.at)} progs ${f.nprog} ${f.defs}`,
          )
          .join('  '),
    );
    assert(
      r.frames.every((f) => /MANTLE_AAC/.test(f.defs)) && !r.anyRot,
      c.name + ': drawn by the axis-aligned AAC program',
    );
    r.frames.forEach((f, i) => {
      assert(
        f.max <= MAX_ERR,
        `${c.name} frame ${i + 1}: ${f.max.toFixed(2)} alpha bytes from the exact area (limit ${MAX_ERR})`,
      );
      assert.equal(f.miss, 0, `${c.name} frame ${i + 1}: missing ink`);
      assert.equal(f.stray, 0, `${c.name} frame ${i + 1}: stray ink`);
    });
  }
  console.log('aacAnisoCoverReachGpuSmoke PASS');
} finally {
  cap.clear();
  await stop();
}

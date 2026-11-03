// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacAffineCoverReachGpuSmoke — an AAC cover reaches every pixel its box touches under thin and
// anisotropic maps, on the physical GPU, scored against references no renderer data enters:
//   aacAffineCoverReachGpu   thin affine maps: AAC, the Slug alias and the fast instanced path
//                            against the 8x SVG box reference; an exact concave affine fade
//   aacAnisoCoverReachGpu    axis-aligned anisotropic maps (x1.3 by y0.55 and transposed) against
//                            an exact-area oracle, at the authored scale and at 2^-20 and 2^20
// Each case runs on its own page in one browser; see _caseHost.mjs. As for the probes, shader
// sources come from the workspace, never from the generated cache.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// aacAffineCoverReachGpu — exact box-integral fills must retain their AA support under thin affine maps.
// Covers AAC, the Slug alias, and the fast instanced vertex path on physical GPU.
// Scale controls use the existing independent 8x SVG box reference.
async function aacAffineCoverReachGpu(host) {
  const fx = JSON.parse(
    readFileSync(path.join(root, 'test/fixtures/aac-affine-cover-reach.json'), 'utf8'),
  );
  const page = await host.browser.newPage();
  await page.goto(host.page('<!doctype html>'));
  await installGpuThrottle(page);
  const slugCase = { ...fx.cases[0], name: 'slug-thin-128', size: 128, kernel: 'slug' };
  const cases = fx.cases.concat([
    slugCase,
    { ...slugCase, name: 'slug-instanced-thin-128', instanced: true },
    { ...slugCase, name: 'aac-instanced-thin-128', kernel: 'aac', instanced: true },
  ]);
  for (const c of cases) {
    const r = await page.evaluate(async (c) => {
      const api = await import('/src/index.js'),
        shaders = await api.loadShaders(new URL('/src/shaders/', location.href));
      (await import('/src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false);
      const N = c.size,
        VBM = c.VB || 128;
      const dm =
        '<rect x="0" y="0" width="1" height="1" fill="#fff" fill-opacity="0.01"/><rect x="127" y="127" width="1" height="1" fill="#fff" fill-opacity="0.01"/>';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VBM} ${VBM}">${c.body}${c.marker || dm}</svg>`;
      // Chrome 8x box reference of the UNSCALED shape under the same map (world matrix: row vectors, y up, NDC translation).
      const M = c.worldMatrix,
        h = 64,
        cx = 64,
        cy = 64,
        as = M[0],
        bs = -M[1],
        cs = -M[3],
        ds = M[4];
      const e = cx - as * cx - cs * cy + M[6] * h,
        f = cy - bs * cx - ds * cy - M[7] * h;
      const refSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${8 * N}" height="${8 * N}" viewBox="0 0 128 128"><g transform="matrix(${as} ${bs} ${cs} ${ds} ${e} ${f})">${c.refBody || c.body}${dm}</g></svg>`;
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(refSvg);
      await img.decode();
      const c8 = document.createElement('canvas');
      c8.width = c8.height = 8 * N;
      const g8 = c8.getContext('2d');
      g8.drawImage(img, 0, 0, 8 * N, 8 * N);
      const d8 = g8.getImageData(0, 0, 8 * N, 8 * N).data;
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
      const rr = api.createRenderer(gl, shaders, {
        aacFill: c.kernel !== 'slug',
        aacPoints: false,
      });
      rr.setFillEngine({ route: 'none', kernel: c.kernel || 'aac' });
      rr.setViewport(N, N);
      let px;
      // the fast instance path draws once ITS program has linked (a draw whose program is still linking takes the per-instance loop, the same picture): wait for that
      // event, not for a fixed number of frames (3 frames is not reliably enough)
      for (let i = 0; i < (c.instanced ? 400 : 3); i++) {
        if (c.instanced && i >= 3 && rr.debugStats.instancedFastCount > 0) break;
        rr.beginFrame([0, 0, 0, 0]);
        if (c.instanced) rr.drawBundleInstanced(bundle, [{ worldMatrix: M }, { worldMatrix: M }]);
        else rr.drawBundle(bundle, { worldMatrix: M });
        rr.endFrame();
        if (!(await window.__gpuFence(gl, 30000))) throw Error('fence');
        px = new Uint8Array(N * N * 4);
        gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
        await window.__gpuIdle(2);
      }
      if (gl.getError()) throw Error('GL error');
      let missing = 0,
        over8 = 0,
        maxErr = 0;
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          let s = 0;
          for (let j = 0; j < 8; j++)
            for (let i = 0; i < 8; i++) s += d8[((y * 8 + j) * 8 * N + x * 8 + i) * 4 + 3];
          const single = s / 64,
            ref = c.instanced ? 255 * (1 - (1 - single / 255) ** 2) : single,
            mine = px[((N - 1 - y) * N + x) * 4 + 3];
          if (ref >= 2.5 && mine === 0) missing++;
          const err = Math.abs(mine - ref);
          if (err > 8) over8++;
          if (err > maxErr) maxErr = err;
        }
      const out = {
        aac: rr.debugStats.engines.draws.aac || 0,
        slug: rr.debugStats.engines.draws.slug || 0,
        fast: rr.debugStats.instancedFastCount || 0,
        rot: srcs.some((s) => /^\s*#define\s+MANTLE_ROTATED_MAP\s*$/m.test(s)),
        missing,
        over8,
        maxErr,
      };
      bundle.dispose();
      rr.dispose();
      gl.getExtension('WEBGL_lose_context').loseContext();
      return out;
    }, c);
    console.log(
      `  ${c.name}: AAC ${r.aac}, Slug ${r.slug}, fast ${r.fast}, rotated-map program ${r.rot}, missing ${r.missing}, over-8 ${r.over8}, worst ${r.maxErr.toFixed(2)}`,
    );
    assert(
      (c.kernel === 'slug' ? r.slug > 0 && r.aac === 0 : r.aac > 0) && r.rot,
      c.name + ': intended rotated-map kernel drew',
    );
    if (c.instanced) assert(r.fast > 0, c.name + ': fast instance path drew');
    assert.equal(
      r.missing,
      fx.maxMissing,
      c.name + ': pixels the pixel box touches but the cover did not reach',
    );
    assert.equal(
      r.over8,
      fx.maxOver,
      c.name + ': pixels more than 8 alpha bytes from the box reference',
    );
  }

  // Exact polygon/pixel intersection; no renderer data participates in the reference.
  const result = await page.evaluate(async () => {
    const api = await import('/src/index.js');
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (!dbg || /software|swiftshader|llvmpipe/i.test(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)))
      throw Error('Physical GPU required');
    const points = [
      [12, 10],
      [116, 10],
      [116, 36],
      [88, 36],
      [88, 92],
      [108, 92],
      [108, 116],
      [24, 116],
      [24, 88],
      [40, 88],
      [40, 56],
      [12, 56],
    ];
    const path = 'M' + points.map((p) => p.join(' ')).join('L') + 'Z';
    const svg = (alpha) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path id="p" fill="#207fda" fill-opacity="${alpha}" d="${path}"/></svg>`;
    const a = api.createBundle(gl, await api.importSvg(svg(0), { preserveViewport: true }));
    const b = api.createBundle(gl, await api.importSvg(svg(0.83), { preserveViewport: true }));
    a.globalBBox = b.globalBBox = [0, 0, 128, 128];
    const morph = api.createShapeMorph(gl, a, b);
    morph.bundle.globalBBox = [0, 0, 128, 128];
    const R = api.createRenderer(
      gl,
      await api.loadShaders(new URL('/src/shaders/', location.href)),
      { aacFill: true, aacPoints: false },
    );
    R.setViewport(64, 64);
    const M = new Float32Array([1, 0, 0, 0, 1 / 64, 0, 3 / 512, 5 / 512, 1]);
    const poly = points.map(([x, y]) => [
      (x / 64 - 1 + M[6] + 1) * 32,
      (1 - (1 - y / 64) * M[4] - M[7]) * 32,
    ]);
    function clip(p, axis, wall, sign) {
      const z = [];
      for (let i = 0; i < p.length; i++) {
        const a = p[i],
          b = p[(i + 1) % p.length],
          u = sign * (a[axis] - wall),
          v = sign * (b[axis] - wall);
        if (u >= 0) z.push(a);
        if (u >= 0 !== v >= 0) {
          const t = u / (u - v);
          z.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
      }
      return z;
    }
    function area(x, y) {
      let p = poly;
      for (const [a, w, s] of [
        [0, x, 1],
        [0, x + 1, -1],
        [1, y, 1],
        [1, y + 1, -1],
      ]) {
        p = clip(p, a, w, s);
        if (!p.length) return 0;
      }
      let sum = 0;
      for (let i = 0; i < p.length; i++) {
        const a = p[i],
          b = p[(i + 1) % p.length];
        sum += a[0] * b[1] - a[1] * b[0];
      }
      return Math.min(1, Math.abs(sum) / 2);
    }
    const coverage = Array.from({ length: 4096 }, (_, i) => area(i % 64, i >> 6)),
      rows = [];
    try {
      for (const kernel of ['aac', 'slug'])
        for (const t of [0.5, 254 / 255, 1])
          for (const bg of [
            [0, 0, 0, 0],
            [1, 1, 1, 1],
          ])
            for (const layers of [1, 2]) {
              R.setFillEngine({ route: 'none', kernel, commit: false });
              morph.setT(t);
              const start = performance.now();
              R.beginFrame(bg);
              for (let i = 0; i < layers; i++) R.drawBundle(morph, { worldMatrix: M });
              R.endFrame();
              if (!(await window.__gpuFence(gl, 30000)))
                throw Error('Affine derivative fence failed');
              await window.__gpuIdle(performance.now() - start);
              const px = new Uint8Array(64 * 64 * 4);
              gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
              let maxByte = 0;
              for (let y = 0; y < 64; y++)
                for (let x = 0; x < 64; x++) {
                  const alpha = coverage[y * 64 + x] * (0.83 * t),
                    color = bg.map((v) => v * 255);
                  for (let j = 0; j < layers; j++)
                    for (let k = 0; k < 4; k++)
                      color[k] = Math.round(
                        (k === 3 ? 255 : [32, 127, 218][k]) * alpha + color[k] * (1 - alpha),
                      );
                  const at = ((63 - y) * 64 + x) * 4;
                  for (let k = 0; k < 4; k++)
                    maxByte = Math.max(maxByte, Math.abs(px[at + k] - color[k]));
                }
              if (maxByte > layers)
                throw Error(
                  'Affine derivative ' + JSON.stringify({ kernel, t, layers, bg, maxByte }),
                );
              rows.push({ kernel, t, layers, background: bg[3], maxByte });
            }
      if (gl.getError()) throw Error('Affine derivative GL error');
      return rows;
    } finally {
      morph.dispose();
      a.dispose();
      b.dispose();
      R.dispose();
      gl.getExtension('WEBGL_lose_context').loseContext();
    }
  });
  console.log(
    '  exact concave affine fade: ' +
      result.length +
      ' physical-GPU states, worst ' +
      Math.max(...result.map((r) => r.maxByte)) +
      ' bytes',
  );

  console.log('aacAffineCoverReachGpu PASS');
  await page.close();
  return 0;
}

// aacAnisoCoverReachGpu — a raw AAC cover under an AXIS-ALIGNED ANISOTROPIC map (x1.3 by y0.55, no rotation or shear) must reach every pixel its box
// touches. The cover corner's bisector push is half a pixel along ONE screen direction (~0.19 px along y at 0.55/1.3), and
// a program that adds the affine support only for rotated maps would lose any pixel row a shape's extreme pokes less than
// ~0.3 px into (10 pixels, 20 alpha bytes at some sub-pixel phases). Scored against an INDEPENDENT exact-area oracle, at the authored
// scale and with the geometry scaled by 2^-20 and 2^20 (no absolute epsilon).
async function aacAnisoCoverReachGpu(host) {
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
  const page = await host.browser.newPage();
  await page.goto(host.page('<!doctype html>'));
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
  console.log('aacAnisoCoverReachGpu PASS');
  await page.close();
  return 0;
}

const host = await openCaseHost(
  root,
  { headless: 'new', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'] },
  { deny: (p) => p.includes('/generated/') },
);
// Each case had a 180 s wall cap of its own.
const cap = capWallTime('aacAffineCoverReach', () => host.close(), 360000);
console.log(gpuThrottleBanner());
let failures;
try {
  failures = await runCases(host, [
    ['aacAffineCoverReachGpu', aacAffineCoverReachGpu],
    ['aacAnisoCoverReachGpu', aacAnisoCoverReachGpu],
  ]);
} finally {
  cap.clear();
}
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('aacAffineCoverReachGpuSmoke PASS');

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Exact box-integral fills must retain their AA support under thin affine maps.
// Covers AAC, the Slug alias, and the fast instanced vertex path on physical GPU.
// Scale controls use the existing independent 8x SVG box reference.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = JSON.parse(
  readFileSync(path.join(root, 'test/fixtures/aac-affine-cover-reach.json'), 'utf8'),
);
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
const cap = capWallTime('aacAffineCoverReach', stop, 180000);
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

  console.log('aacAffineCoverReachGpuSmoke PASS');
} finally {
  cap.clear();
  await stop();
}

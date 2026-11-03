// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Prepared morphs must upload the current pose before an analytic-cover fallback.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime } from './_gpuThrottle.mjs';
const HOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.MANTLE_MORPH_FALLBACK_ROOT || HOST);
const fixture = {
  svg: readFileSync(HOST + '/examples/smoke/lbGpuMorph__SRC.svg', 'utf8'),
  morphSvgDst: readFileSync(HOST + '/examples/smoke/lbGpuMorph__DST.svg', 'utf8'),
  cp: JSON.parse(readFileSync(HOST + '/test/fixtures/cpatch-morph-readiness.json', 'utf8'))
    .cases[0],
};
const server = http.createServer((req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html>');
      return;
    }
    const f = path.resolve(ROOT, '.' + decodeURIComponent(u.pathname));
    if (!f.startsWith(ROOT + '/src/')) throw Error('Path');
    res.setHeader('Content-Type', f.endsWith('.glsl') ? 'text/plain' : 'text/javascript');
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
const cap = capWallTime('Morph cover pose', stop, 180000);
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
  });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  await installGpuThrottle(page);
  const report = await page.evaluate(async (fixture) => {
    globalThis.__MANTLE_DEBUG__ = true;
    const M = await import('/src/index.js');
    const shaders = await M.loadShaders(new URL('/src/shaders/', location.href));
    const rows = [],
      N = 128;
    const states = [
      { t: 0 },
      { t: 0.25 },
      { t: 0.75, matrixAlpha: 0.47, cover: true },
      { t: 1 },
      { t: 0.2 },
      { t: 0.6, rgb: true, cover: true },
      { t: 0.4 },
      { t: 0.9, forceCover: true, cover: true },
      { t: 0.5 },
    ];
    for (const baseRoute of ['lb', 'cpatch'])
      for (const kernel of ['slug', 'aac']) {
        const shape =
          baseRoute === 'lb'
            ? fixture
            : {
                svg: fixture.cp.svg.replaceAll('fill-opacity="0.5"', 'fill-opacity="1"'),
                morphSvgDst: fixture.cp.morphSvgDst.replaceAll(
                  'fill-opacity="0.5"',
                  'fill-opacity="1"',
                ),
              };
        const sides = [];
        for (const route of [baseRoute, 'none']) {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = N;
          const gl = canvas.getContext('webgl2', {
            antialias: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: true,
            depth: true,
            stencil: true,
          });
          const ext = gl.getExtension('WEBGL_debug_renderer_info'),
            device = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
          if (/software|swiftshader|llvmpipe/i.test(device)) throw Error('Physical GPU required');
          const r = M.createRenderer(gl, shaders, {
            aacFill: kernel === 'aac',
            aacPoints: false,
            psoWarmIdle: () => true,
          });
          if (r.ready) await r.ready;
          r.setViewport(N, N);
          r.setFillEngine({ route, kernel });
          const a = M.createBundle(gl, await M.importSvg(shape.svg, { preserveViewport: true })),
            b = M.createBundle(
              gl,
              await M.importSvg(shape.morphSvgDst, { preserveViewport: true }),
            );
          const m = M.createShapeMorph(gl, a, b);
          m.setT(0);
          if (route !== 'none') {
            if (route === 'cpatch') await r.warmCPatchPool();
            r.beginFrame([0, 0, 0, 0]);
            r.drawBundle(m);
            r.endFrame();
            r.prepareBundle(m.bundle);
            if (!(await r.awaitEngine(m, route, 60000))) throw Error(route + ' preparation');
          }
          sides.push({ gl, r, m, a, b, route, device });
        }
        const draw = async (s, state) => {
          s.r.setFillEngine({
            route: s.route !== 'none' && state.forceCover ? 'none' : s.route,
            kernel,
          });
          s.m.setT(state.t);
          const opts = {};
          if (state.matrixAlpha != null || state.rgb)
            opts.colorMatrix = new Float32Array([
              state.rgb ? 0.8 : 1,
              0,
              0,
              0,
              0,
              1,
              0,
              0,
              0,
              0,
              1,
              0,
              0,
              0,
              0,
              state.matrixAlpha ?? 1,
            ]);
          const before = structuredClone(s.r.debugStats.engines),
            t0 = performance.now();
          s.r.beginFrame([0, 0, 0, 0]);
          s.r.drawBundle(s.m, opts);
          s.r.endFrame();
          if (!(await window.__gpuFence(s.gl, 20000))) throw Error('Fence');
          await window.__gpuIdle(performance.now() - t0);
          const pixels = new Uint8Array(N * N * 4);
          s.gl.readPixels(0, 0, N, N, s.gl.RGBA, s.gl.UNSIGNED_BYTE, pixels);
          if (s.gl.getError()) throw Error('GL error');
          const after = s.r.debugStats.engines,
            delta = {};
          for (const [k, v] of Object.entries(after.draws || {}))
            delta[k] = v - ((before.draws || {})[k] || 0);
          return { pixels, delta };
        };
        // Visit both shader classes before checking the first frame of each transition.
        for (let cycle = 0; cycle < 3; cycle++)
          for (const state of states)
            for (const s of sides) {
              await draw(s, state);
              s.r.prewarmBundle(s.m);
              s.r.precompileFills();
            }
        for (let i = 0; i < states.length; i++) {
          const state = states[i],
            a = await draw(sides[0], state),
            b = await draw(sides[1], state);
          let max = 0,
            n = 0;
          for (let j = 0; j < a.pixels.length; j += 4) {
            let e = 0;
            for (let k = 0; k < 4; k++)
              e = Math.max(e, Math.abs(a.pixels[j + k] - b.pixels[j + k]));
            max = Math.max(max, e);
            if (e > 1) n++;
          }
          const later = await draw(sides[0], state);
          let repeated = 0;
          for (let j = 0; j < a.pixels.length; j++)
            repeated = Math.max(repeated, Math.abs(a.pixels[j] - later.pixels[j]));
          rows.push({
            baseRoute,
            kernel,
            stateIndex: i,
            state,
            device: sides[0].device,
            draws: a.delta,
            maxCoverDiff: max,
            pixelsOverOne: n,
            repeatedMax: repeated,
          });
        }
        for (const s of sides) {
          s.m.dispose();
          s.a.dispose();
          s.b.dispose();
          s.r.dispose();
          s.gl.getExtension('WEBGL_lose_context').loseContext();
        }
      }
    return { rows };
  }, fixture);
  if (process.env.MANTLE_MORPH_FALLBACK_REPORT)
    writeFileSync(process.env.MANTLE_MORPH_FALLBACK_REPORT, JSON.stringify(report, null, 2) + '\n');
  for (const r of report.rows) {
    console.log(
      r.kernel,
      r.stateIndex,
      'draws',
      JSON.stringify(r.draws),
      'max',
      r.maxCoverDiff,
      'repeat',
      r.repeatedMax,
    );
    if (r.state.cover) {
      assert(!(r.draws[r.baseRoute] > 0), JSON.stringify(r));
      assert((r.draws.slug || 0) + (r.draws.aac || 0) > 0, JSON.stringify(r));
      assert(r.maxCoverDiff <= 1, JSON.stringify(r));
    } else assert(r.draws[r.baseRoute] > 0, JSON.stringify(r));
    assert(r.repeatedMax <= 1, JSON.stringify(r));
  }
  console.log('Morph cover pose GPU PASS:', report.rows.length, 'first-frame transitions');
} finally {
  cap.clear();
  await stop();
}

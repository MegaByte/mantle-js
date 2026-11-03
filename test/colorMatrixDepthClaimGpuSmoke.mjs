// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Physical GPU ownership controls at both ends of the paint alpha range.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = {
  ...(process.env.MANTLE_MATRIX_DEPTH_BASELINE_ROOT
    ? { baseline: path.resolve(process.env.MANTLE_MATRIX_DEPTH_BASELINE_ROOT) }
    : {}),
  candidate: root,
};
const output = process.env.MANTLE_MATRIX_DEPTH_REPORT;
const hash = (b) => createHash('sha256').update(b).digest('hex');
function sourceHashes(base) {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  return Object.fromEntries(
    walk(base + '/src').map((p) => [path.relative(base, p), hash(readFileSync(p))]),
  );
}
const report = {
  sourceHashes: Object.fromEntries(Object.entries(roots).map(([v, r]) => [v, sourceHashes(r)])),
  testHash: hash(readFileSync(fileURLToPath(import.meta.url))),
  cachePolicy: 'Retained, untimed physical GPU correctness. No performance/cold claim.',
  rows: [],
};
const save = () => {
  if (output) writeFileSync(output, JSON.stringify(report) + '\n');
};
const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html>');
      return;
    }
    const [v, ...parts] = decodeURIComponent(url.pathname).slice(1).split('/');
    const base = roots[v],
      file = base && path.resolve(base, parts.join('/'));
    if (!base || !file.startsWith(base + '/') || file.includes('/generated/')) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', file.endsWith('.glsl') ? 'text/plain' : 'text/javascript');
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  server.close();
};
const cap = capWallTime('color matrix depth ownership', stop, 300000);
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
  });
  report.browser = await browser.version();
  for (const version of Object.keys(roots)) {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    await installGpuThrottle(page);
    const rows = await page.evaluate(async (version) => {
      globalThis.__MANTLE_DEBUG__ = true;
      globalThis.__MANTLE_NO_SDF_PRIMS = true;
      const api = await import('/' + version + '/src/index.js');
      const shaders = await api.loadShaders(
        new URL('/' + version + '/src/shaders/', location.href),
      );
      (await import('/' + version + '/src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false);
      const paths = {
        line: 'M4 4H28V28H4Z',
        quad: 'M4 4Q16 2 28 4Q30 16 28 28Q16 30 4 28Q2 16 4 4Z',
        cubic: 'M4 4C10 2 22 2 28 4L28 28C22 30 10 30 4 28Z',
        nativeArc: 'M26 16A10 10 0 1 1 6 16A10 10 0 1 1 26 16Z',
      };
      const out = [];
      // Reuse geometry and programs while testing every mutable paint state.
      for (const route of ['lb', 'cpatch'])
        for (const kind of Object.keys(paths)) {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 32;
          const gl = canvas.getContext('webgl2', {
            antialias: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: true,
            depth: true,
            stencil: true,
          });
          if (!gl) throw Error('WebGL2');
          const dbg = gl.getExtension('WEBGL_debug_renderer_info'),
            device = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
          if (/software|swiftshader|llvmpipe/i.test(device)) throw Error('Physical GPU required');
          const programs = new Map(),
            lbFill = {},
            events = [],
            shaderEvents = [];
          let phase = 'setup';
          for (const op of ['compileShader', 'linkProgram']) {
            const f = gl[op].bind(gl);
            gl[op] = (...args) => {
              shaderEvents.push({ phase, op });
              return f(...args);
            };
          }
          for (const op of [
            'drawArrays',
            'drawArraysInstanced',
            'drawElements',
            'drawElementsInstanced',
          ]) {
            const f = gl[op].bind(gl);
            gl[op] = (...args) => {
              const p = gl.getParameter(gl.CURRENT_PROGRAM);
              if (!programs.has(p)) {
                programs.set(p, programs.size + 1);
                lbFill[programs.get(p)] = gl
                  .getAttachedShaders(p)
                  .some((s) => /^\s*#define\s+MANTLE_LB_FILL\s*$/m.test(gl.getShaderSource(s)));
              }
              events.push({
                phase,
                op,
                args,
                program: programs.get(p),
                depth: gl.isEnabled(gl.DEPTH_TEST),
                depthFunc: gl.getParameter(gl.DEPTH_FUNC),
                depthWrite: gl.getParameter(gl.DEPTH_WRITEMASK),
              });
              return f(...args);
            };
          }
          const r = api.createRenderer(gl, shaders, {
            cpatchFill: route === 'cpatch',
            aacFill: true,
            aacPoints: false,
            psoWarmIdle: () => true,
          });
          r.setViewport(32, 32);
          r.setFillEngine({ route, kernel: 'aac', commit: false });
          if (route === 'cpatch') await r.warmCPatchPool();
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="white" fill-opacity="${1}" d="${paths[kind]}"/></svg>`;
          const b = api.createBundle(gl, await api.importSvg(svg, { preserveViewport: true }));
          r.prepareBundle(b);
          if (!(await r.awaitEngine(b, route, 20000))) throw Error('Requested engine not ready');
          for (const mode of [
            'matrix',
            'offset',
            'rgbControl',
            'alphaFromRed',
            'alphaFromGreen',
            'alphaFromBlue',
          ])
            for (const alpha of [0.00395, 0.997, 1]) {
              if (mode.startsWith('alphaFrom') && alpha === 1) continue;
              events.length = 0;
              shaderEvents.length = 0;
              const drawsBefore = { ...r.debugStats.engines.draws };
              const matrix = new Float32Array([
                mode === 'rgbControl' ? alpha : 1,
                0,
                0,
                mode === 'alphaFromRed' ? alpha : 0,
                0,
                1,
                0,
                mode === 'alphaFromGreen' ? alpha : 0,
                0,
                0,
                1,
                mode === 'alphaFromBlue' ? alpha : 0,
                0,
                0,
                0,
                mode === 'matrix' ? alpha : mode.startsWith('alphaFrom') ? 0 : 1,
              ]);
              const offset = new Float32Array([0, 0, 0, alpha - 1]);
              const drawOptions =
                mode === 'offset' ? { colorMatrixOffset: offset } : { colorMatrix: matrix };
              const setAlpha = (value) => {
                if (mode === 'offset') offset[3] = value - 1;
                else
                  matrix[
                    mode === 'rgbControl'
                      ? 0
                      : mode === 'alphaFromRed'
                        ? 3
                        : mode === 'alphaFromGreen'
                          ? 7
                          : mode === 'alphaFromBlue'
                            ? 11
                            : 15
                  ] = value;
              };
              const otherAlpha = alpha === 0.00395 ? 0.997 : 0.00395;
              const snap = async (label) => {
                phase = label;
                const start = performance.now();
                r.beginFrame([0, 0, 0, 0]);
                r.drawBundle(b, drawOptions);
                r.endFrame();
                if (!(await window.__gpuFence(gl, 20000))) throw Error('Fence');
                const px = new Uint8Array(4096);
                gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, px);
                if (gl.getError()) throw Error('GL error');
                await window.__gpuIdle(performance.now() - start);
                return Array.from(px);
              };
              // Warm both alpha states until a whole pass builds nothing, then idle once for the warm's wall time.
              const warmStart = performance.now();
              const warmState = (label, value) => ({
                name: label,
                draw: () => {
                  phase = label;
                  setAlpha(value);
                  r.prewarmBundle(b);
                  r.beginFrame([0, 0, 0, 0]);
                  r.drawBundle(b, drawOptions);
                  r.endFrame();
                },
              });
              r.prewarmBundle(b);
              r.precompileFills();
              const warm = await r.warmScene(
                [warmState('warm', alpha), warmState('warm-other', otherAlpha)],
                { maxPasses: 16, fenceTimeoutMs: 20000 },
              );
              await window.__gpuIdle(performance.now() - warmStart);
              setAlpha(alpha);
              const first = await snap('first'),
                later = await snap('later');
              setAlpha(otherAlpha);
              const other = await snap('other-state');
              setAlpha(alpha);
              const claim = b._lbDepthClaim,
                claimGen = b._lbDepthClaimGen;
              // Force only the existing ownership state, retaining identical shaders,
              // geometry, textures and paint. This isolates the eligibility predicate.
              b._lbDepthClaim = true;
              b._lbDepthClaimGen = b._geomGen | 0;
              const claimed = await snap('forced-ownership');
              b._lbDepthClaim = claim;
              b._lbDepthClaimGen = claimGen;
              const restored = await snap('restored');
              out.push({
                version,
                spec: { route, kind, mode, alpha },
                device,
                first,
                later,
                other,
                otherAlpha,
                claimed,
                restored,
                events: events.slice(),
                shaderEvents: shaderEvents.slice(),
                lbFill: { ...lbFill },
                warmComplete: warm.complete,
                ledger: {
                  ...structuredClone(r.debugStats.engines),
                  draws: Object.fromEntries(
                    Object.entries(r.debugStats.engines.draws).map(([key, n]) => [
                      key,
                      n - (drawsBefore[key] || 0),
                    ]),
                  ),
                },
              });
            }
          r.dispose();
          b.dispose();
          gl.getExtension('WEBGL_lose_context').loseContext();
        }
      (
        await import('/' + version + '/src/renderer/occupancyWorkerPool.js')
      ).disposeOccupancyWorker();
      (await import('/' + version + '/src/renderer/cpatchWorkerPool.js')).disposeCpatchPool();
      return out;
    }, version);
    report.rows.push(...rows);
    save();
    await page.close();
    for (const row of rows) {
      const changed = row.first.filter((v, i) => v !== row.claimed[i]).length;
      console.log(version, JSON.stringify(row.spec), 'ownership changed channels', changed);
    }
  }
  for (const [v, r] of Object.entries(roots))
    assert.deepEqual(sourceHashes(r), report.sourceHashes[v]);
  assert.equal(hash(readFileSync(fileURLToPath(import.meta.url))), report.testHash);
  report.sourceStable = report.harnessStable = true;
  if (process.env.MANTLE_MATRIX_DEPTH_DIAGNOSIS !== '1')
    for (const row of report.rows) {
      assert.deepEqual(row.first, row.later);
      assert.deepEqual(row.first, row.restored);
      assert(
        !row.shaderEvents.some((e) =>
          ['first', 'later', 'other-state', 'forced-ownership', 'restored'].includes(e.phase),
        ),
        'No visible shader compile/link',
      );
      const fills = row.events.filter(
        (e) => ['first', 'later', 'restored'].includes(e.phase) && row.lbFill[e.program],
      );
      assert(fills.length, 'Actual unified fill');
      if (row.version === 'candidate' && row.spec.alpha < 1 && row.spec.mode !== 'rgbControl') {
        assert(
          fills.every((e) => e.depth && e.depthFunc === 513 && e.depthWrite),
          'Translucent pieces must claim once',
        );
        assert.deepEqual(row.first, row.claimed, 'Automatic and forced ownership images');
      }
      if (row.spec.alpha === 1 || row.spec.mode === 'rgbControl')
        assert(
          fills.every((e) => !e.depth || e.depthFunc !== 513),
          'Opaque control keeps its existing depth mode',
        );
      // Every pixel square in this rectangle lies wholly inside all four
      // authored silhouettes, including the exact radius-10 native circle.
      if (row.version === 'candidate') {
        const expected =
          row.spec.mode === 'rgbControl'
            ? [Math.round(255 * row.spec.alpha), 255, 255, 255]
            : Array(4).fill(Math.round(255 * row.spec.alpha));
        for (let y = 10; y < 22; y++)
          for (let x = 10; x < 22; x++) {
            const i = ((31 - y) * 32 + x) * 4;
            assert.deepEqual(
              row.first.slice(i, i + 4),
              expected,
              'Independent fully covered pixel ' + JSON.stringify({ ...row.spec, x, y }),
            );
            const otherExpected =
              row.spec.mode === 'rgbControl'
                ? [Math.round(255 * row.otherAlpha), 255, 255, 255]
                : Array(4).fill(Math.round(255 * row.otherAlpha));
            assert.deepEqual(
              row.other.slice(i, i + 4),
              otherExpected,
              'Mutable matrix/offset ' + JSON.stringify({ ...row.spec, x, y }),
            );
          }
      }
      const draws = row.ledger.draws;
      if (row.spec.route === 'lb') assert(draws.lb > 0);
      else assert(draws.cpatch > 0 || (row.spec.kind === 'line' && draws.lb > 0));
    }
  const base = new Map(
    report.rows.filter((r) => r.version === 'baseline').map((r) => [JSON.stringify(r.spec), r]),
  );
  for (const row of report.rows.filter((r) => r.version === 'candidate' && r.spec.alpha === 1))
    if (base.size)
      assert.deepEqual(
        row.first,
        base.get(JSON.stringify(row.spec)).first,
        'Opaque complete images remain exact',
      );
  report.independentInteriorPixels =
    report.rows.filter((r) => r.version === 'candidate').length * 144;
  report.finished = new Date().toISOString();
  report.passed = process.env.MANTLE_MATRIX_DEPTH_DIAGNOSIS !== '1';
  save();
  console.log(
    report.passed
      ? 'colorMatrixDepthClaimGpuSmoke PASS'
      : 'colorMatrixDepthClaimGpuSmoke DIAGNOSIS retained; numerical assertions skipped',
  );
} catch (e) {
  report.error = e.stack;
  save();
  throw e;
} finally {
  cap.clear();
  await stop();
}

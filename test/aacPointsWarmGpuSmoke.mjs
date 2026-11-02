// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Prove loading warms the actual AAC point program, before any visible draw.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.env.MANTLE_WARM_BASELINE_ROOT;
const overridePath = process.env.MANTLE_WARM_PROGRAM_OVERRIDE;
if (baseline && overridePath) throw Error('Choose baseline tree or program-count override');
const overrides = overridePath
  ? new Map(Object.entries(JSON.parse(readFileSync(overridePath, 'utf8'))))
  : new Map();
const overrideRequests = {};
const hash = (s) => createHash('sha256').update(s).digest('hex');
const sources = (base) => {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => {
        const f = path.join(d, e.name);
        return e.isDirectory() ? walk(f) : [[path.relative(base, f), hash(readFileSync(f))]];
      });
  return Object.fromEntries(walk(base + '/src'));
};
const report = {
  sourceHashes: sources(root),
  harnessHash: hash(readFileSync(fileURLToPath(import.meta.url))),
  cache: 'Retained. Actual compile/draw-path control; no cold pipeline or throughput ranking.',
  rows: [],
};
if (baseline) report.baselineHashes = sources(baseline);
if (overridePath)
  report.programCountOverride = {
    path: overridePath,
    hash: hash(readFileSync(overridePath)),
    modules: Object.fromEntries([...overrides].map(([p, s]) => [p, hash(s)])),
  };
const save = () => {
  if (process.env.MANTLE_WARM_REPORT)
    writeFileSync(process.env.MANTLE_WARM_REPORT, JSON.stringify(report, null, 2) + '\n');
};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html>');
    return;
  }
  const old = u.pathname.startsWith('/__baseline/'),
    base = old ? baseline : root;
  if (!base || u.pathname.includes('/generated/')) {
    res.writeHead(404).end();
    return;
  }
  const f = path.resolve(
    base,
    '.' + decodeURIComponent(old ? u.pathname.slice('/__baseline'.length) : u.pathname),
  );
  if (!f.startsWith(base + '/')) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : 'text/plain');
    const rel = path.relative(root, f);
    if (!old && overrides.has(rel)) {
      overrideRequests[rel] = (overrideRequests[rel] || 0) + 1;
      res.end(overrides.get(rel));
    } else res.end(readFileSync(f));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
};
const cap = capWallTime('aacPointsWarmGpuSmoke', stop);
console.log(gpuThrottleBanner());
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
  });
  report.browser = await browser.version();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  await installGpuThrottle(page);
  for (const prefix of baseline ? ['/__baseline', ''] : ['']) {
    const rows = await page.evaluate(async (prefix) => {
      const api = await import(prefix + '/src/index.js'),
        shaders = await api.loadShaders(new URL(prefix + '/src/shaders/', location.href));
      const wrap = (body) =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${body}</svg>`;
      const small = Array.from(
        { length: 12 },
        (_, i) =>
          `<path fill="#2469ae" fill-opacity=".65" d="M${120 + i * 40} 320 q8 -12 16 0 q-8 12 -16 0Z"/>`,
      ).join('');
      const out = [];
      for (const mode of [
        'pair',
        'stripe',
        'auto',
        'draw-false',
        'points-disabled',
        'slug',
        'large',
        'gradient',
      ]) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 128;
        const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
        if (!gl) throw Error('WebGL2 required');
        const ext = gl.getExtension('WEBGL_debug_renderer_info'),
          device = ext
            ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER);
        if (/swiftshader|llvmpipe|software/i.test(device))
          throw Error('Physical GPU required: ' + device);
        let phase = 'setup';
        const compiles = [],
          events = [],
          programs = new Map(),
          compiledSources = {};
        const compile = gl.compileShader.bind(gl);
        gl.compileShader = (s) => {
          compiles.push({ phase, type: gl.getShaderParameter(s, gl.SHADER_TYPE) });
          return compile(s);
        };
        for (const key of [
          'drawArrays',
          'drawArraysInstanced',
          'drawElements',
          'drawElementsInstanced',
        ]) {
          const draw = gl[key].bind(gl);
          gl[key] = (...args) => {
            const p = gl.getParameter(gl.CURRENT_PROGRAM);
            if (!programs.has(p)) {
              const sources = gl.getAttachedShaders(p).map((s) => gl.getShaderSource(s));
              programs.set(p, programs.size + 1);
              compiledSources[programs.get(p)] = sources;
            }
            events.push({
              phase,
              key,
              args,
              program: programs.get(p),
              scissor: gl.isEnabled(gl.SCISSOR_TEST)
                ? Array.from(gl.getParameter(gl.SCISSOR_BOX))
                : null,
            });
            return draw(...args);
          };
        }
        const opts = {
          aacFill: mode === 'slug' ? false : mode === 'auto' ? 'auto' : true,
          precompileFillsBudgetMs: 100000,
          ...(mode === 'points-disabled' ? { aacPoints: false } : {}),
        };
        const r = api.createRenderer(gl, shaders, opts);
        if (mode === 'auto') r.setLoopBlinnFill('off');
        else r.setFillEngine({ route: 'none', kernel: mode === 'slug' ? 'slug' : 'aac' });
        r.setViewport(128, 128);
        const body =
          mode === 'large'
            ? '<path fill="#2469ae" fill-opacity=".65" d="M100 100 Q500 0 900 100 L900 900 L100 900Z"/>'
            : mode === 'gradient'
              ? '<defs><linearGradient id="g"><stop stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
                small.replaceAll('#2469ae', 'url(#g)')
              : small;
        const t0 = performance.now(),
          sec = await api.importSvg(wrap(body), {
            preserveViewport: true,
            pairBands: mode !== 'stripe',
          }),
          importMs = performance.now() - t0;
        const t1 = performance.now(),
          b = api.createBundle(gl, sec),
          uploadMs = performance.now() - t1;
        phase = 'loading';
        const start = performance.now(),
          attempts = r.precompileFills({ draw: mode !== 'draw-false' }),
          loadingSubmitMs = performance.now() - start;
        await window.__gpuFence(gl, 30000);
        const loadingWallMs = performance.now() - start;
        await window.__gpuIdle(loadingWallMs);
        const snap = async (label) => {
          phase = label;
          const start = performance.now();
          r.beginFrame([0, 0, 0, 0]);
          r.drawBundle(b);
          r.endFrame();
          const submitMs = performance.now() - start;
          await window.__gpuFence(gl, 30000);
          const wallMs = performance.now() - start;
          const px = new Uint8Array(128 * 128 * 4);
          gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px);
          if (gl.getError()) throw Error('GL error ' + mode);
          if (!px.some((v, i) => i % 4 === 3 && v)) throw Error('Empty ' + mode);
          return { submitMs, wallMs, pixels: Array.from(px) };
        };
        const first = await snap('first-visible');
        await window.__gpuIdle(first.wallMs);
        const later = await snap('later-visible');
        let maxByte = 0;
        for (let i = 0; i < first.pixels.length; i++)
          maxByte = Math.max(maxByte, Math.abs(first.pixels[i] - later.pixels[i]));
        out.push({
          mode,
          device,
          attempts,
          importMs,
          uploadMs,
          loadingSubmitMs,
          loadingWallMs,
          compiles,
          events,
          compiledSources,
          first,
          later,
          maxByte,
          ledger: structuredClone(r.debugStats.engines),
        });
        b.dispose();
        r.dispose();
        gl.getExtension('WEBGL_lose_context').loseContext();
      }
      if (!prefix) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 512;
        const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
        let phase = 'setup';
        const creations = [],
          usedPoints = [];
        const create = gl.createProgram.bind(gl);
        gl.createProgram = () => {
          const p = create();
          creations.push({ phase, p });
          return p;
        };
        const points = gl.drawArraysInstanced.bind(gl);
        gl.drawArraysInstanced = (...a) => {
          if (a[0] === gl.POINTS)
            usedPoints.push({ phase, p: gl.getParameter(gl.CURRENT_PROGRAM) });
          return points(...a);
        };
        const r = api.createRenderer(gl, shaders, {
          aacFill: true,
          aacPoints: true,
          aacPointsMaxPx: 4,
          psoWarmIdle: () => false,
        });
        r.setFillEngine({ route: 'none', kernel: 'aac' });
        const b = api.createBundle(
          gl,
          await api.importSvg(wrap(small), { preserveViewport: true }),
        );
        const draw = (n) => {
          r.setViewport(n, n);
          r.beginFrame([0, 0, 0, 0]);
          r.drawBundle(b);
          r.endFrame();
        };
        phase = 'cover';
        const cover = await r.warmScene([{ name: 'large cover', draw: () => draw(512) }], {
          maxPasses: 32,
          fenceTimeoutMs: 30000,
        });
        const coverPointDraws = usedPoints.filter((e) => e.phase === 'cover').length;
        cv.width = cv.height = 128;
        phase = 'point';
        let first = null;
        const warm = await r.warmScene(
          [
            {
              name: 'cold point helper',
              draw: async () => {
                draw(128);
                await window.__gpuFence(gl, 30000);
                if (!first) {
                  first = new Uint8Array(128 * 128 * 4);
                  gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, first);
                }
              },
            },
          ],
          { maxPasses: 32, fenceTimeoutMs: 30000 },
        );
        const pointPrograms = creations.filter((e) => e.phase === 'point'),
          pointDraws = usedPoints.filter((e) => e.phase === 'point');
        phase = 'later';
        draw(128);
        await window.__gpuFence(gl, 30000);
        const later = new Uint8Array(128 * 128 * 4);
        gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, later);
        let maxByte = 0,
          ink = 0;
        for (let i = 0; i < later.length; i++) {
          maxByte = Math.max(maxByte, Math.abs(later[i] - first[i]));
          if (i % 4 === 3 && later[i]) ink++;
        }
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        out.push({
          mode: 'program-accounting',
          device: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
          cover,
          warm,
          coverPointDraws,
          helperOnly:
            pointPrograms.length <= 1 &&
            pointDraws.length > 0 &&
            pointDraws.every((e) => e.p === pointDraws[0].p) &&
            (pointPrograms.length === 0 || pointDraws.some((e) => e.p === pointPrograms[0].p)),
          actualProgramsCreated: pointPrograms.length,
          pointDraws: pointDraws.length,
          laterProgramsCreated: creations.filter((e) => e.phase === 'later').length,
          maxByte,
          ink,
          error: gl.getError(),
        });
        b.dispose();
        r.dispose();
        gl.getExtension('WEBGL_lose_context').loseContext();
      }
      return out;
    }, prefix);
    report.rows.push({ source: prefix ? 'baseline' : 'candidate', rows });
    save();
  }
  if (overridePath) {
    assert.equal(hash(readFileSync(overridePath)), report.programCountOverride.hash);
    report.programCountOverride.requests = overrideRequests;
    assert(Object.keys(overrideRequests).length, 'program-count override was not served');
  }
  assert.deepEqual(sources(root), report.sourceHashes);
  if (baseline) assert.deepEqual(sources(baseline), report.baselineHashes);
  assert.equal(hash(readFileSync(fileURLToPath(import.meta.url))), report.harnessHash);
  report.sourceStable = true;
  report.harnessStable = true;
  report.finished = new Date().toISOString();
  save();
  for (const version of report.rows)
    for (const row of version.rows) {
      if (row.mode === 'program-accounting') {
        assert(
          /Metal/.test(row.device) && !/SwiftShader/i.test(row.device),
          'actual Metal accounting control',
        );
        assert(
          row.cover.complete && row.coverPointDraws === 0 && row.helperOnly && row.pointDraws > 0,
          'one point helper program draws, created either by the bundle prewarm (parallel compile) or by the warm pass',
        );
        assert.equal(
          row.warm.states[0].programsCreated,
          row.actualProgramsCreated,
          'warm report counts the actual helper program creation',
        );
        assert(
          row.warm.complete && (row.actualProgramsCreated === 0 || row.warm.states[0].passes >= 2),
          'a helper-creation pass requires a later stable pass',
        );
        assert.equal(row.laterProgramsCreated, 0);
        assert.equal(row.maxByte, 0);
        assert(
          row.ink > 0 && row.error === 0,
          'real nonblank helper frames match without GL errors',
        );
        console.log(JSON.stringify(row));
        continue;
      }
      const fixed = version.source === 'candidate',
        point = (e) => e.key === 'drawArraysInstanced' && e.args[0] === 0;
      const loading = row.events.filter((e) => e.phase === 'loading'),
        first = row.events.filter((e) => e.phase === 'first-visible'),
        later = row.events.filter((e) => e.phase === 'later-visible');
      assert.equal(row.maxByte, 0, 'first/later images ' + row.mode);
      assert.equal(row.compiles.filter((e) => e.phase === 'later-visible').length, 0);
      if (['pair', 'stripe', 'auto', 'draw-false'].includes(row.mode)) {
        assert(first.some(point), 'actual point route ' + row.mode);
        assert(later.some(point));
        if (row.mode === 'draw-false') {
          assert.equal(loading.length, 0, 'draw:false must issue no draw');
        } else {
          assert.equal(loading.some(point), fixed, 'point warm absent on baseline');
          assert.equal(
            row.compiles.filter((e) => e.phase === 'first-visible').length,
            fixed ? 0 : 2,
            'first-use compile',
          );
          if (fixed) {
            const warms = loading.filter(point);
            assert(warms.every((e) => e.scissor?.join() === '0,0,1,1'));
            assert(
              first.every((e) => !e.scissor),
              'warm scissor restored',
            );
            assert(
              first.filter(point).every((e) => warms.some((w) => w.program === e.program)),
              'first visible reuses actual warmed point program',
            );
          }
        }
      } else if (fixed && ['slug', 'large', 'gradient'].includes(row.mode)) {
        // the default kernel is the exact walk the point route runs, and the gate is the depth-scaled point budget, so a small Slug
        // draw and a single 128 px shape (about 17k points) take the point route; an 8 px, AAC-only gate would decline them.
        assert(first.some(point) && later.some(point), 'actual point route ' + row.mode);
      } else {
        assert(
          !loading.some(point) && !first.some(point) && !later.some(point),
          'decline remains cover ' + row.mode,
        );
      }
      console.log(
        JSON.stringify({
          source: version.source,
          mode: row.mode,
          warmPoints: loading.filter(point).length,
          visibleCompiles: row.compiles.filter((e) => e.phase === 'first-visible').length,
          maxByte: row.maxByte,
        }),
      );
    }
  if (baseline) {
    for (const row of report.rows[0].rows) {
      if (['slug', 'large'].includes(row.mode)) continue;
      const next = report.rows[1].rows.find((r) => r.mode === row.mode);
      assert.deepEqual(next.first.pixels, row.first.pixels, 'baseline/candidate image ' + row.mode);
    }
  }
  report.passed = true;
  save();
  console.log('aacPointsWarmGpuSmoke PASS');
} catch (e) {
  report.error = e.stack;
  save();
  throw e;
} finally {
  cap.clear();
  await stop();
}

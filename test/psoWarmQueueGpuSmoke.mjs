// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// On a real GPU: loading calls that stop before a later unique pipeline.
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
const originalFillPass = process.env.MANTLE_WARM_ERROR_ORIGINAL_FILL_PASS;
if (baseline && originalFillPass) throw Error('Use one original-source control at a time');
let originalServes = 0;
const hash = (s) => createHash('sha256').update(s).digest('hex');
const sourceHashes = (base) => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => {
        const f = path.join(dir, e.name);
        return e.isDirectory() ? walk(f) : [[path.relative(base, f), hash(readFileSync(f))]];
      });
  return Object.fromEntries(walk(path.join(base, 'src')));
};
const report = {
  sourceHashes: sourceHashes(root),
  harnessHash: hash(readFileSync(fileURLToPath(import.meta.url))),
  cache: 'retained; execution regression, no cold compile or throughput claim',
  rows: [],
};
if (baseline) report.baselineHashes = sourceHashes(baseline);
if (originalFillPass)
  report.sourceOverride = {
    path: originalFillPass,
    sha256: hash(readFileSync(originalFillPass)),
    scope:
      'Original fillPass exception cleanup; all other sources are current. Expected regression witness, not a release correctness pass.',
  };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html>');
    return;
  }
  const old = u.pathname.startsWith('/__baseline/');
  const base = old ? baseline : root;
  if (!base) {
    res.writeHead(404).end();
    return;
  }
  const f = path.resolve(
    base,
    '.' + decodeURIComponent(old ? u.pathname.slice('/__baseline'.length) : u.pathname),
  );
  if (!f.startsWith(base + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : 'text/plain');
    if (originalFillPass && u.pathname === '/src/renderer/fillPass.js') {
      originalServes++;
      res.end(readFileSync(originalFillPass));
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
const cap = capWallTime('psoWarmQueueGpuSmoke', stop);
console.log(gpuThrottleBanner());
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal', '--enable-gpu'],
  });
  report.browser = await browser.version();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await installGpuThrottle(page);
  for (const prefix of baseline ? ['/__baseline', ''] : ['']) {
    const rows = await page.evaluate(async (prefix) => {
      const api = await import(prefix + '/src/index.js');
      const shaders = await api.loadShaders(new URL(prefix + '/src/shaders/', location.href));
      const svg = (body) =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`;
      const solid = await api.importSvg(
        svg('<path d="M10 10 L50 10 L50 50 L10 50 Z" fill="#f00"/>'),
        { preserveViewport: true },
      );
      const stroke = await api.importSvg(
        svg('<path d="M10 10 L50 10 L50 50" fill="none" stroke="#0a0" stroke-width="3"/>'),
        { preserveViewport: true },
      );
      const out = [];
      for (const mode of [
        'duplicates-draw',
        'duplicates-no-draw',
        'budget-idle',
        'scene-recolor',
        'scene-instance',
        'warm-failure',
        'warm-failure-scissor',
      ]) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const gl = canvas.getContext('webgl2', { premultipliedAlpha: true });
        if (!gl) throw Error('WebGL2 required');
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const device = ext
          ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER);
        if (/swiftshader|llvmpipe|software/i.test(device))
          throw Error('Physical GPU required: ' + device);
        let phase = 'setup',
          compiles = 0,
          rejectWarmDraw = false,
          rejectedCall = null,
          rejections = 0;
        const events = [],
          programs = new Map();
        const compile = gl.compileShader.bind(gl);
        gl.compileShader = (s) => {
          compiles++;
          compile(s);
        };
        for (const op of ['drawArrays', 'drawArraysInstanced']) {
          const draw = gl[op].bind(gl);
          gl[op] = (...args) => {
            const p = gl.getParameter(gl.CURRENT_PROGRAM);
            if (!programs.has(p)) programs.set(p, programs.size + 1);
            const defs = [
              ...new Set(
                gl
                  .getAttachedShaders(p)
                  .flatMap((s) =>
                    [...gl.getShaderSource(s).matchAll(/^\s*#define\s+(MANTLE_\w+)/gm)].map(
                      (m) => m[1],
                    ),
                  ),
              ),
            ];
            events.push({
              phase,
              op,
              program: programs.get(p),
              defs,
              args,
              scissor: gl.isEnabled(gl.SCISSOR_TEST)
                ? Array.from(gl.getParameter(gl.SCISSOR_BOX))
                : null,
            });
            if (rejectWarmDraw) {
              rejectWarmDraw = false;
              rejectedCall = { op, args };
              rejections++;
              throw Error('pipeline draw rejected');
            }
            draw(...args);
          };
        }
        const budget = mode === 'budget-idle' ? 0 : 100000;
        const r = api.createRenderer(gl, shaders, {
          psoWarmIdle: () => mode === 'budget-idle',
          precompileFillsBudgetMs: budget,
          aacPoints: false,
        }); // Keep these checks on fill variants rather than the point route.
        r.setFillEngine({ route: 'none', kernel: 'slug' });
        r.setViewport(64, 64);
        const sceneMode = mode.startsWith('scene-');
        const sceneData = sceneMode
          ? await api.importSvg(
              svg(
                '<path fill="#d433a9" fill-opacity=".5" d="M4 20C4 0 36 0 36 20C36 40 4 40 4 20Z"/><path fill="#348bc4" fill-opacity=".63" d="M18 12L56 16L38 58Z"/>',
              ),
              { preserveViewport: true },
            )
          : null;
        const b = api.createBundle(
          gl,
          sceneMode
            ? sceneData
            : mode === 'budget-idle' || mode.startsWith('warm-failure')
              ? solid
              : stroke,
        );
        if (mode.startsWith('warm-failure')) {
          await r.ready;
          const callerRect = mode === 'warm-failure-scissor' ? [8, 9, 20, 21] : null;
          const referenceRenderer = api.createRenderer(gl, shaders, {
            aacPoints: false,
            psoWarmIdle: () => false,
          });
          referenceRenderer.setFillEngine({ route: 'none', kernel: 'slug' });
          referenceRenderer.setViewport(64, 64);
          await referenceRenderer.ready;
          const referenceBundle = api.createBundle(gl, solid);
          phase = 'failure-reference';
          referenceRenderer.beginFrame([0, 0, 0, 0]);
          if (callerRect) referenceRenderer.setScissorRect(...callerRect);
          referenceRenderer.drawBundle(referenceBundle);
          referenceRenderer.endFrame();
          const reference = new Uint8Array(64 * 64 * 4);
          gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, reference);
          referenceBundle.dispose();
          referenceRenderer.dispose();
          gl.disable(gl.SCISSOR_TEST);
          gl.clearColor(0, 0, 0, 0);
          gl.clearDepth(1);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
          r.invalidateRenderState();
          if (callerRect) r.setScissorRect(...callerRect);
          else r.clearScissorRect();
          const recoveries = [],
            scissors = [];
          let beforeRecoveryCompiles = null;
          phase = 'failed-pipeline';
          rejectWarmDraw = true;
          const warm = await r.warmScene(
            [
              { name: 'failed-internal-pipeline', draw() {} },
              {
                name: 'recovery-draw',
                draw() {
                  if (beforeRecoveryCompiles === null) beforeRecoveryCompiles = compiles;
                  phase = 'recovery-draw';
                  scissors.push(
                    gl.isEnabled(gl.SCISSOR_TEST)
                      ? Array.from(gl.getParameter(gl.SCISSOR_BOX))
                      : null,
                  );
                  if (!rejectedCall) throw Error('Internal warm draw was not reached');
                  gl[rejectedCall.op](...rejectedCall.args);
                  const pixels = new Uint8Array(64 * 64 * 4);
                  gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                  recoveries.push(pixels);
                },
              },
            ],
            { maxPasses: 4, fenceTimeoutMs: 60000 },
          );
          let maxByte = 0,
            maxReferenceError = 0;
          for (const pixels of recoveries)
            for (let i = 0; i < pixels.length; i++) {
              maxByte = Math.max(maxByte, Math.abs(pixels[i] - recoveries[0][i]));
              maxReferenceError = Math.max(maxReferenceError, Math.abs(pixels[i] - reference[i]));
            }
          const ink = (p) => p.reduce((n, v, i) => n + (i % 4 === 3 && v > 0 ? 1 : 0), 0);
          const glError = gl.getError();
          if (!ink(reference) || glError)
            throw Error('Failure recovery reference or GPU error ' + glError);
          out.push({
            mode,
            device,
            warm,
            rejections,
            callerRect,
            scissors,
            visibleCompiles: compiles - beforeRecoveryCompiles,
            maxByte,
            maxReferenceError,
            referenceInk: ink(reference),
            recoveryInk: recoveries.map(ink),
            glError,
            events,
          });
          b.dispose();
          r.dispose();
          gl.getExtension('WEBGL_lose_context')?.loseContext();
          continue;
        }
        if (sceneMode) {
          await r.ready;
          const instance = mode === 'scene-instance';
          r.setFillEngine({
            route: instance ? 'none' : 'cpatch',
            kernel: instance ? 'aac' : 'slug',
            primitives: 'off',
          });
          r.prepareBundle(b);
          if (!instance && !(await r.awaitEngine(b, 'cpatch', 60000)))
            throw Error('CPatch preparation failed');
          r.precompileFills();
          if (!(await window.__gpuFence(gl, 60000))) throw Error('Initial warm fence');
          const render = () => {
            r.beginFrame([0, 0, 0, 0]);
            if (instance)
              r.drawBundleInstanced(b, [
                { worldMatrix: [0.8, 0, 0, 0, 0.8, 0, -0.1, 0, 1] },
                { worldMatrix: [0.8, 0, 0, 0, 0.8, 0, 0.1, 0, 1] },
              ]);
            else
              r.drawBundle(b, {
                colorMatrix: [0.8, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
              });
            r.endFrame();
          };
          phase = 'scene-warm';
          const started = performance.now();
          const warm = await r.warmScene([{ draw: render }], {
            maxPasses: 16,
            fenceTimeoutMs: 60000,
          });
          await window.__gpuIdle(performance.now() - started);
          const beforeVisible = compiles;
          const snap = async () => {
            render();
            if (!(await window.__gpuFence(gl, 60000))) throw Error('Visible fence');
            const p = new Uint8Array(64 * 64 * 4);
            gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, p);
            return p;
          };
          phase = 'first-visible';
          const first = await snap();
          await window.__gpuIdle(2);
          phase = 'later-visible';
          const later = await snap();
          let maxByte = 0;
          for (let i = 0; i < first.length; i++)
            maxByte = Math.max(maxByte, Math.abs(first[i] - later[i]));
          const eligible = (e) =>
            instance
              ? e.op === 'drawArraysInstanced' && e.defs.includes('MANTLE_NO_GRADIENT')
              : e.defs.includes('MANTLE_CPATCH_QUADRATIC_AREA_ONLY');
          const warmed = new Set(
            events.filter((e) => e.phase === 'scene-warm' && eligible(e)).map((e) => e.program),
          );
          const warmProgramReused = events.some(
            (e) => e.phase === 'first-visible' && eligible(e) && warmed.has(e.program),
          );
          if (!first.some((v, i) => i % 4 === 3 && v) || gl.getError())
            throw Error('Scene draw failed');
          out.push({
            mode,
            device,
            warm,
            visibleCompiles: compiles - beforeVisible,
            maxByte,
            warmProgramReused,
            events,
          });
          b.dispose();
          r.dispose();
          gl.getExtension('WEBGL_lose_context')?.loseContext();
          continue;
        }
        if (mode !== 'budget-idle') for (let i = 0; i < 9; i++) api.createBundle(gl, solid);
        const firstCompiles = compiles;
        const draws = mode !== 'duplicates-no-draw';
        phase = 'first-warm';
        const start = performance.now(),
          first = r.precompileFills({ draw: draws });
        await window.__gpuFence(gl, 15000);
        const firstWallMs = performance.now() - start;
        await window.__gpuIdle(firstWallMs);
        phase = 'second-warm';
        const second = r.precompileFills({ draw: draws });
        await window.__gpuFence(gl, 15000);
        await window.__gpuIdle(1);
        phase = 'third-warm';
        const third = r.precompileFills({ draw: draws });
        phase = 'idle';
        if (mode === 'budget-idle')
          for (let i = 0; i < 4; i++) {
            r.beginFrame([0, 0, 0, 0]);
            r.endFrame();
            await window.__gpuFence(gl, 15000);
            await window.__gpuIdle(1);
          }
        const beforeVisible = compiles;
        const snap = () => {
          r.render(b);
          const pixels = new Uint8Array(64 * 64 * 4);
          gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          return pixels;
        };
        phase = 'first-visible';
        const image = snap();
        await window.__gpuIdle(1);
        phase = 'later-visible';
        const later = snap();
        if (!image.some((v, i) => i % 4 === 3 && v)) throw Error('Empty image');
        if (gl.getError()) throw Error('GPU error');
        let maxByte = 0;
        for (let i = 0; i < image.length; i++)
          maxByte = Math.max(maxByte, Math.abs(image[i] - later[i]));
        const digest = async (p) =>
          Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', p)))
            .map((x) => x.toString(16).padStart(2, '0'))
            .join('');
        out.push({
          mode,
          device,
          first,
          second,
          third,
          firstWallMs,
          preparationCompiles: beforeVisible - firstCompiles,
          visibleCompiles: compiles - beforeVisible,
          events,
          imageHash: await digest(image),
          laterImageHash: await digest(later),
          maxByte,
        });
        r.dispose();
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
      return out;
    }, prefix);
    report.rows.push({ source: prefix ? 'baseline' : 'candidate', rows });
  }
  assert.deepEqual(sourceHashes(root), report.sourceHashes);
  if (baseline) assert.deepEqual(sourceHashes(baseline), report.baselineHashes);
  assert.equal(hash(readFileSync(fileURLToPath(import.meta.url))), report.harnessHash);
  if (originalFillPass) {
    assert.equal(hash(readFileSync(originalFillPass)), report.sourceOverride.sha256);
    assert(originalServes > 0);
    report.sourceOverride.served = originalServes;
  }
  report.sourceStable = true;
  report.harnessStable = true;
  report.finished = new Date().toISOString();
  if (process.env.MANTLE_WARM_REPORT)
    writeFileSync(process.env.MANTLE_WARM_REPORT, JSON.stringify(report, null, 2) + '\n');
  for (const source of report.rows)
    for (const row of source.rows) {
      const fixed = source.source === 'candidate';
      assert.equal(row.visibleCompiles, 0);
      assert.equal(row.maxByte, 0, 'first/later image ' + row.mode);
      if (row.mode.startsWith('warm-failure')) {
        const repaired = fixed && !originalFillPass;
        assert.equal(row.rejections, 1, 'one internal pipeline draw fails');
        assert.equal(row.warm.states[0].error, 'pipeline draw rejected');
        assert.equal(row.warm.complete, false, 'the failed state remains reported');
        assert.equal(
          row.warm.states[1].stable,
          repaired,
          'the following state can drain its pipeline',
        );
        assert.equal(
          row.scissors.length > 0 &&
            row.scissors.every((sc) => JSON.stringify(sc) === JSON.stringify(row.callerRect)),
          repaired,
          'caller scissor restored after failure',
        );
        assert.equal(
          row.maxReferenceError === 0,
          repaired,
          'every recovery image matches its clean actual-GPU reference',
        );
        assert(row.referenceInk > 0);
        if (repaired) assert(row.recoveryInk.every((n) => n > 0));
      } else if (row.mode.startsWith('scene-')) {
        assert(row.warm.complete, 'scene warming completes');
        assert.equal(
          row.warmProgramReused,
          fixed,
          'demanded program draws before completion and on first visible frame',
        );
      } else if (row.mode === 'budget-idle') {
        assert.equal(row.first, 0);
        assert.equal(row.second, 0);
        assert.equal(row.third, 0);
        assert.equal(
          row.events.some((e) => e.phase === 'idle' && e.scissor?.join() === '0,0,1,1'),
          fixed,
          'budget tail idle warm',
        );
      } else {
        assert.equal(row.first, 9);
        assert.equal(row.second, fixed ? 1 : 0);
        assert.equal(row.third, 0);
        const second = row.events.filter((e) => e.phase === 'second-warm');
        assert.equal(second.length, row.mode === 'duplicates-draw' && fixed ? 1 : 0);
        if (second.length) {
          assert.deepEqual(second[0].scissor, [0, 0, 1, 1]);
          const visible = row.events.filter((e) => e.phase === 'first-visible');
          assert(
            visible.some((e) => e.program === second[0].program),
            'actual warm program reused on first visible draw',
          );
        }
      }
      console.log(
        JSON.stringify({
          source: source.source,
          mode: row.mode,
          first: row.first,
          second: row.second,
          third: row.third,
          visibleCompiles: row.visibleCompiles,
          maxByte: row.maxByte,
          device: row.device,
        }),
      );
    }
  console.log('psoWarmQueueGpuSmoke PASS');
} finally {
  cap.clear();
  await stop();
}

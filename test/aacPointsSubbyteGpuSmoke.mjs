// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// RGBA8 source-over must retain a faint paint that rounds to a visible byte.
// Actual point shaders, three repeated paints, every curve representation.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  baseline = process.env.MANTLE_POINT_ALPHA_BASELINE_ROOT;
const hash = (x) => createHash('sha256').update(x).digest('hex');
const sources = (base) => {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  return Object.fromEntries(
    walk(base + '/src').map((f) => [path.relative(base, f), hash(readFileSync(f))]),
  );
};
const report = {
  sourceHashes: sources(root),
  harnessHash: hash(readFileSync(fileURLToPath(import.meta.url))),
  cache: 'Retained caches. Untimed physical-GPU accuracy check, no throughput/cold claims.',
  rows: [],
};
if (baseline) report.baselineHashes = sources(baseline);
const save = () => {
  if (process.env.MANTLE_POINT_ALPHA_REPORT)
    writeFileSync(process.env.MANTLE_POINT_ALPHA_REPORT, JSON.stringify(report, null, 2) + '\n');
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
    res.end(readFileSync(f));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
};
const cap = capWallTime('aacPointsSubbyteGpuSmoke', stop);
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
      const out = [];
      const paths = [
        ['line', 'M2 2 H4 V4 H2Z', 6, 6],
        ['quad', 'M6 2 Q7 1 8 2 Q9 3 8 4 Q7 5 6 4 Q5 3 6 2Z', 14, 6],
        ['cubic', 'M2 8 C2 7 4 7 4 8 L4 10 C4 11 2 11 2 10Z', 6, 18],
        ['nativeArc', 'M8 9 A1 1 0 1 1 6 9 A1 1 0 1 1 8 9Z', 14, 18],
      ];
      for (const pairBands of [true, false])
        for (const [opacity, drawAlpha] of [
          [0.003, 1],
          [0.004, 0.65],
          [0.49 / 255, 1],
        ]) {
          const cv = document.createElement('canvas');
          cv.width = cv.height = 32;
          const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
          if (!gl) throw Error('WebGL2 required');
          const dbg = gl.getExtension('WEBGL_debug_renderer_info'),
            device = dbg
              ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
              : gl.getParameter(gl.RENDERER);
          if (/swiftshader|llvmpipe|software/i.test(device))
            throw Error('Physical GPU required ' + device);
          const executed = [];
          for (const key of [
            'drawArrays',
            'drawArraysInstanced',
            'drawElements',
            'drawElementsInstanced',
          ]) {
            const f = gl[key].bind(gl);
            gl[key] = (...args) => {
              const p = gl.getParameter(gl.CURRENT_PROGRAM);
              executed.push({
                key,
                args,
                sources: gl.getAttachedShaders(p).map((s) => gl.getShaderSource(s)),
              });
              return f(...args);
            };
          }
          const body =
            paths
              .flatMap(([, d]) =>
                Array.from(
                  { length: 3 },
                  () => `<path fill="#fff" fill-opacity="${opacity}" d="${d}"/>`,
                ),
              )
              .join('') + '<path fill="#2469ae" d="M12 12H14V14H12Z"/>';
          const sec = await api.importSvg(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${body}</svg>`,
            { preserveViewport: true, pairBands },
          );
          const bundle = api.createBundle(gl, sec),
            r = api.createRenderer(gl, shaders, { aacFill: true });
          r.setFillEngine({ route: 'none', kernel: 'aac' });
          r.setViewport(32, 32);
          r.prewarmBundle(bundle);
          r.precompileFills();
          executed.length = 0; /* the loading call's warm draws are not visible draws: count only the two snapshots' */
          const snap = async () => {
            r.beginFrame([0, 0, 0, 0]);
            r.drawBundle(bundle, { alpha: drawAlpha });
            r.endFrame();
            if (!(await window.__gpuFence(gl, 30000))) throw Error('GPU fence');
            const px = new Uint8Array(32 * 32 * 4);
            gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const error = gl.getError();
            if (error) throw Error('GL error ' + error);
            return Array.from(px);
          };
          const first = await snap();
          await window.__gpuIdle(3);
          const later = await snap();
          const centers = paths.map(([kind, , x, y]) => ({
            kind,
            x,
            y,
            rgba: first.slice(((31 - y) * 32 + x) * 4, ((31 - y) * 32 + x) * 4 + 4),
          }));
          out.push({
            pairBands,
            opacity,
            drawAlpha,
            device,
            centers,
            first,
            later,
            executed,
            ledger: structuredClone(r.debugStats.engines),
          });
          bundle.dispose();
          r.dispose();
          gl.getExtension('WEBGL_lose_context').loseContext();
        }
      return out;
    }, prefix);
    report.rows.push({ source: prefix ? 'baseline' : 'candidate', rows });
    save();
  }
  assert.deepEqual(sources(root), report.sourceHashes);
  if (baseline) assert.deepEqual(sources(baseline), report.baselineHashes);
  assert.equal(hash(readFileSync(fileURLToPath(import.meta.url))), report.harnessHash);
  report.sourceStable = report.harnessStable = true;
  for (const version of report.rows)
    for (const row of version.rows) {
      assert.deepEqual(row.first, row.later, 'Repeat images exact');
      assert(
        row.first.some((v) => v),
        'Opaque marker guarantees nonempty draw',
      );
      const points = row.executed.filter((e) => e.key === 'drawArraysInstanced' && e.args[0] === 0);
      assert.equal(points.length, 2, 'Both visible draws execute actual point programs');
      assert(
        points.every((e) => e.sources.some((s) => s.includes('renderFillAAC'))),
        'Executed AAC vertex coverage',
      );
      assert(row.ledger.draws.aac > 0, 'Actual AAC ledger');
      // A draw alpha is group opacity: the paints accumulate in the group's RGBA8 target at their own opacity, then the group fades by the draw alpha once.
      let expected = 0;
      for (let i = 0; i < 3; i++)
        expected = Math.round(255 * row.opacity + expected * (1 - row.opacity));
      if (row.drawAlpha < 1) expected = Math.round(expected * row.drawAlpha);
      for (const p of row.centers) {
        if (version.source === 'candidate')
          assert.deepEqual(
            p.rgba,
            [expected, expected, expected, expected],
            JSON.stringify({
              pair: row.pairBands,
              opacity: row.opacity,
              drawAlpha: row.drawAlpha,
              kind: p.kind,
            }),
          );
        else assert.deepEqual(p.rgba, [0, 0, 0, 0], 'Original full-byte cutoff negative control');
      }
      console.log(
        JSON.stringify({
          source: version.source,
          pairBands: row.pairBands,
          opacity: row.opacity,
          drawAlpha: row.drawAlpha,
          expected,
          actual: row.centers.map((p) => p.rgba[3]),
        }),
      );
    }
  report.finished = new Date().toISOString();
  report.passed = true;
  save();
  console.log('aacPointsSubbyteGpuSmoke PASS');
} catch (e) {
  report.error = e.stack;
  save();
  throw e;
} finally {
  cap.clear();
  await stop();
}

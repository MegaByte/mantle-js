// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Replace a pending worker conversion with a bake, then release the superseded real reply.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname;
    if (name === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<canvas id="c" width="128" height="128"></canvas>');
      return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(name));
    if (!file.startsWith(root + path.sep)) throw Error('Path');
    res.setHeader('Content-Type', file.endsWith('.glsl') ? 'text/plain' : 'text/javascript');
    res.end(
      readFileSync(
        name === '/src/renderer/cpatchBuild.js' && process.env.MANTLE_CPATCH_BEFORE_FILE
          ? process.env.MANTLE_CPATCH_BEFORE_FILE
          : name === '/src/renderer/renderer.js' && process.env.MANTLE_CPATCH_RENDERER_BEFORE_FILE
            ? process.env.MANTLE_CPATCH_RENDERER_BEFORE_FILE
            : file,
      ),
    );
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = capWallTime(
  'cpatchConversionSupersedeGpuSmoke',
  async () => {
    if (browser) await browser.close();
  },
  180000,
);
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await installGpuThrottle(page);
  const result = await page.evaluate(async () => {
    const held = [];
    let capture = false;
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, opts) {
        super(url, opts);
        if (String(url).endsWith('/cpatch.worker.js'))
          this.addEventListener('message', (event) => {
            if (capture) {
              event.stopImmediatePropagation();
              held.push({ worker: this, data: event.data });
            }
          });
      }
    };
    globalThis.__MANTLE_DEBUG__ = true;
    globalThis.__CP_NO_AREA = 1;
    const api = await import('/src/index.js');
    const { buildCPatchBundle, bakeCPatchBundle } = await import('/src/renderer/cpatchBuild.js');
    const gl = document.getElementById('c').getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      depth: true,
    });
    const ext = gl.getExtension('WEBGL_debug_renderer_info'),
      device = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    if (/software|swiftshader|llvmpipe/i.test(device)) throw Error('Software GPU');
    const r = api.createRenderer(
      gl,
      await api.loadShaders(new URL('/src/shaders/', location.href)),
      { cpatchFill: true, aacFill: true, psoWarmIdle: () => true },
    );
    r.setViewport(128, 128);
    r.setFillEngine({ route: 'cpatch', kernel: 'aac', commit: false });
    await r.warmCPatchPool();
    capture = true;
    const sec = await api.importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#468" fill-opacity="0.5" d="M10 10 Q50 -10 90 10 Q65 50 90 90 Q50 110 10 90 Q35 50 10 10Z"/></svg>',
    );
    const b = api.createBundle(gl, sec, { deferPreparation: true }),
      h = r.createBundleHandle(b);
    buildCPatchBundle(gl, b, { collectSlice: 0, stallReportMs: 0 });
    const deadline = performance.now() + 20000;
    while (!held.length) {
      if (performance.now() > deadline) throw Error('No actual worker reply');
      await window.__gpuIdle(1);
    }
    if (b._cpatchConv !== 'pending') throw Error('Conversion was not held');
    // The worker premise uses decomposition; the replacement uses the current certified route.
    delete globalThis.__CP_NO_AREA;
    h.setCPatchBake(bakeCPatchBundle(b, { pool: false }));
    if (!buildCPatchBundle(gl, b, { traces: b._cpatchTraces, pool: false }))
      throw Error('Replacement bake did not build');
    r.prepareBundle(b);
    if (r.awaitEngine && !(await r.awaitEngine(b, 'cpatch', 30000)))
      throw Error('Replacement CPatch not ready');
    const replacement = b._cpatchConv;
    const draw = async () => {
      const start = performance.now();
      r.beginFrame([0, 0, 0, 0]);
      r.drawBundle(b);
      r.endFrame();
      if (!(await window.__gpuFence(gl, 20000))) throw Error('Fence');
      await window.__gpuIdle(performance.now() - start);
    };
    for (let i = 0; i < 8; i++) {
      r.precompileFills();
      await draw();
    }
    const read = () => {
      const p = new Uint8Array(128 * 128 * 4);
      gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, p);
      return p;
    };
    const before = read();
    capture = false;
    for (const reply of held) reply.worker.onmessage({ data: reply.data });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (b._cpatchConv !== replacement) throw Error('Old reply overwrote replacement bake');
    await draw();
    const after = read();
    let maxByte = 0,
      ink = 0;
    for (let i = 0; i < before.length; i++) {
      maxByte = Math.max(maxByte, Math.abs(before[i] - after[i]));
      if (i % 4 === 3 && after[i] > 0) ink++;
    }
    const cpCount = r.debugStats.engines.draws.cpatch || 0;
    b._geomGen++;
    await draw();
    const staleCpDelta = (r.debugStats.engines.draws.cpatch || 0) - cpCount;
    const out = {
      device,
      maxByte,
      ink,
      replies: held.length,
      cpatch: cpCount,
      staleCpDelta,
      error: gl.getError(),
    };
    h.dispose();
    b.dispose();
    r.dispose();
    return out;
  });
  console.log(JSON.stringify(result));
  assert.equal(result.error, 0);
  assert.equal(result.maxByte, 0);
  assert(result.ink > 1000);
  assert(result.cpatch > 0);
  assert(result.replies > 0);
  assert.equal(result.staleCpDelta, 0);
  console.log('CPatch conversion supersession GPU PASS');
} finally {
  stop.clear();
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

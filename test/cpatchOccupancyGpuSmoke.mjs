// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Occupancy replies must preserve CPatch's appended live coefficient texels.
// Force the real worker reply before/after CPatch packing; draw and read back
// the physical GPU rather than inferring correctness from a CPU shadow.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/cpatch-occupancy.json', import.meta.url)),
);
const output = process.env.MANTLE_OCCUPANCY_REPORT;
const sourceRoot = process.env.MANTLE_OCCUPANCY_SOURCE_ROOT || root;
let browser;
const server = http.createServer((req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<canvas id="c"></canvas>');
      return;
    }
    const file = path.resolve(sourceRoot, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(sourceRoot + path.sep) || file.includes('/generated/')) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', /\.glsl$/.test(file) ? 'text/plain' : 'text/javascript');
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
function sourceHashes(dir = path.join(sourceRoot, 'src')) {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => {
        const f = path.join(dir, e.name);
        return e.isDirectory()
          ? Object.entries(sourceHashes(f))
          : /\.(?:js|glsl)$/.test(e.name)
            ? [
                [
                  path.relative(sourceRoot, f),
                  createHash('sha256').update(readFileSync(f)).digest('hex'),
                ],
              ]
            : [];
      }),
  );
}
const initialSources = sourceHashes();
const report = {
  sourceHashes: initialSources,
  testHash: createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex'),
  cachePolicy:
    'Retained; correctness and upload arrival ordering only, no compile/performance claim',
  sourceRoot,
  fixtureHash: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
  cases: [],
};
const stop = async () => {
  if (browser) await browser.close();
  server.close();
};
const cap = capWallTime('cpatch occupancy GPU', stop, 240000);
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal', '--enable-gpu'],
  });
  for (const c of fixture.cases) {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await installGpuThrottle(page);
    const result = await page.evaluate(async (c) => {
      const held = [];
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url, opts) {
          super(url, opts);
          if (String(url).endsWith('/occupancy.worker.js'))
            this.addEventListener('message', (event) => {
              event.stopImmediatePropagation();
              held.push({ worker: this, data: event.data });
            });
        }
      };
      globalThis.__MANTLE_DEBUG__ = true;
      globalThis.__CP_KEEP_PLANE = true;
      globalThis.__MANTLE_NO_SDF_PRIMS = true;
      const api = await import('/src/index.js');
      const { noteExternalGlWrite } = await import('/src/core/glEpoch.js');
      (await import('/src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false);
      const canvas = document.getElementById('c');
      canvas.width = canvas.height = c.size;
      const gl = canvas.getContext('webgl2', {
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: true,
        depth: true,
        stencil: true,
      });
      const ext = gl.getExtension('WEBGL_debug_renderer_info'),
        device = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      if (/software|swiftshader|llvmpipe/i.test(device)) throw Error('Software GPU');
      if (!gl.getExtension('EXT_color_buffer_float')) throw Error('No float readback');
      const shaders = await api.loadShaders(new URL('/src/shaders/', location.href));
      const r = api.createRenderer(gl, shaders, {
        cpatchFill: true,
        aacFill: true,
        psoWarmIdle: () => true,
      });
      r.setViewport(c.size, c.size);
      r.setFillEngine({ route: 'cpatch', kernel: 'aac', commit: false });
      await r.warmCPatchPool();
      const sec = await api.importSvg(c.svg, { preserveViewport: true });
      if (!sec.pendingOccupancy?.length) throw Error('Fixture has no pending occupancy');
      const b = api.createBundle(gl, sec, { deferPreparation: true });
      const wait = async (predicate) => {
        const deadline = performance.now() + 20000;
        while (!predicate()) {
          if (performance.now() > deadline) throw Error('Timed out held occupancy');
          await window.__gpuIdle(1);
        }
      };
      await wait(() => held.length > 0);
      const release = () => {
        const jobs = held.splice(0);
        let grids = 0,
          nonzero = 0;
        for (const j of jobs) {
          for (const g of j.data.occ || []) {
            grids++;
            nonzero += (g.bits || []).filter((v) => v !== 0).length;
          }
          j.worker.onmessage({ data: j.data });
        }
        return { jobs: jobs.length, grids, nonzero };
      };
      let released;
      if (c.arrival === 'before') {
        released = release();
        await wait(() => !b._occupancyBuildPending);
      }
      const expectCPatch = true; // a pinned CPatch draws native arcs (rational quads) through the legacy pack: a requested engine must actually draw
      r.prepareBundle(b);
      const ready = await r.awaitEngine(b, 'cpatch', 20000);
      if (ready !== expectCPatch) throw Error('Unexpected native/rational readiness');
      const draw = async () => {
        const start = performance.now();
        r.beginFrame([0, 0, 0, 0]);
        r.drawBundle(b);
        r.endFrame();
        if (!(await window.__gpuFence(gl, 20000))) throw Error('Fence');
        await window.__gpuIdle(performance.now() - start);
      };
      for (let k = 0; k < 8; k++) {
        r.precompileFills();
        await draw();
      }
      if (expectCPatch && !r.debugStats.engines.draws.cpatch) throw Error('No actual CPatch draw');
      if (
        !expectCPatch &&
        (!r.debugStats.engines.draws.aac ||
          r.debugStats.engines.draws.cpatch ||
          r.debugStats.engines.draws.lb ||
          r.debugStats.engines.draws.slug)
      )
        throw Error('Rational refusal did not draw raw AAC only');
      const pixels = () => {
        const p = new Uint8Array(c.size * c.size * 4);
        gl.readPixels(0, 0, c.size, c.size, gl.RGBA, gl.UNSIGNED_BYTE, p);
        return p;
      };
      const tailStart = Math.ceil(Math.ceil(b.curveFloats.length / 4) / 7) * 28;
      const plane = () => {
        const out = new Float32Array(
            b._cpatchPlane?.length || Math.max(1, Math.ceil(b.curveFloats.length / 16384)) * 16384,
          ),
          old = gl.getParameter(gl.FRAMEBUFFER_BINDING),
          fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b.curveTex, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
          throw Error('FBO');
        gl.readPixels(0, 0, 4096, out.length / 16384, gl.RGBA, gl.FLOAT, out);
        gl.bindFramebuffer(gl.FRAMEBUFFER, old);
        gl.deleteFramebuffer(fbo);
        noteExternalGlWrite();
        r.invalidateRenderState();
        return out;
      };
      const before = pixels(),
        coeffBefore = plane();
      if (c.arrival === 'after') {
        released = release();
        await wait(() => !b._occupancyBuildPending);
      }
      await draw();
      const after = pixels(),
        coeffAfter = plane();
      let maxByte = 0,
        changedChannels = 0,
        changedCoefficients = 0;
      for (let i = 0; i < before.length; i++) {
        const e = Math.abs(before[i] - after[i]);
        maxByte = Math.max(maxByte, e);
        changedChannels += e !== 0;
      }
      for (let i = tailStart; i < coeffBefore.length; i++)
        changedCoefficients += coeffBefore[i] !== coeffAfter[i];
      const cpuBits = new Uint32Array(
        b.curveFloats.buffer,
        b.curveFloats.byteOffset,
        b.curveFloats.length,
      );
      const gpuBits = new Uint32Array(coeffAfter.buffer);
      let changedPrefix = 0;
      for (let i = 0; i < cpuBits.length; i++) changedPrefix += cpuBits[i] !== gpuBits[i];
      if (c.multiRow && b.curveFloats.length <= 16384)
        throw Error('Multirow fixture became single row');
      if (
        !before.some((v) => v > 0) ||
        (expectCPatch && !coeffBefore.subarray(tailStart).some((v) => v !== 0))
      )
        throw Error('Empty image or native coefficient tail');
      if (!expectCPatch && b._cpatchPlane)
        throw Error('Unsupported rational paint acquired a CPatch plane');
      const result = {
        expectCPatch,
        ready,
        name: c.name,
        arrival: c.arrival,
        size: c.size,
        device,
        pending: sec.pendingOccupancy.length,
        released,
        hasOccupancy: !!b.hasOccupancy,
        cpatchBuilt: b._cpatchBuilt,
        draws: r.debugStats.engines.draws,
        maxByte,
        changedChannels,
        changedCoefficients,
        changedPrefix,
        tailStart,
        originalFloats: b.curveFloats.length,
        multiRow: !!c.multiRow,
        before: Array.from(before),
        after: Array.from(after),
        coefficientTailBefore: Array.from(coeffBefore.subarray(tailStart)),
        coefficientTailAfter: Array.from(coeffAfter.subarray(tailStart)),
        glError: gl.getError(),
      };
      r.dispose();
      b.dispose();
      (await import('/src/renderer/occupancyWorkerPool.js')).disposeOccupancyWorker();
      (await import('/src/renderer/cpatchWorkerPool.js')).disposeCpatchPool();
      return result;
    }, c);
    report.cases.push(result);
    if (output) writeFileSync(output, JSON.stringify(report) + '\n');
    await page.close();
    console.log(
      c.name,
      c.arrival,
      'coefficients',
      result.changedCoefficients,
      'RGBA',
      result.maxByte,
      'GPU',
      result.device,
    );
  }
  assert.deepEqual(sourceHashes(), initialSources);
  report.sourceStable = true;
  report.finished = new Date().toISOString();
  if (output) writeFileSync(output, JSON.stringify(report) + '\n');
  if (process.env.MANTLE_OCCUPANCY_DIAGNOSIS !== '1')
    for (const r of report.cases) {
      assert(r.released.jobs > 0 && r.released.nonzero > 0);
      assert(r.hasOccupancy);
      assert(
        r.expectCPatch
          ? r.cpatchBuilt > 0 && r.draws.cpatch > 0
          : !r.ready && r.draws.aac > 0 && !r.draws.cpatch && !r.draws.lb && !r.draws.slug,
      );
      assert.equal(r.glError, 0);
      assert.equal(r.changedCoefficients, 0);
      assert.equal(
        r.changedPrefix,
        0,
        'CPatch preserves the current curve prefix, including worker occupancy bits',
      );
      assert.equal(r.maxByte, 0);
      assert.equal(r.changedChannels, 0);
    }
  console.log(
    process.env.MANTLE_OCCUPANCY_DIAGNOSIS === '1'
      ? 'cpatchOccupancyGpuSmoke diagnosis captured; numerical failures intentionally retained'
      : 'cpatchOccupancyGpuSmoke PASS: actual worker arrival orders, live GPU coefficient tails and translucent complete RGBA',
  );
} finally {
  cap.clear();
  await stop();
}

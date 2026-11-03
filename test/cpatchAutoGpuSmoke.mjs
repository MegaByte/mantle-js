// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Static CPatch auto routing, translucent paint order, policy changes and morph exclusion on Metal.
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
        name === '/src/renderer/fillMeshOwner.js' && process.env.MANTLE_CPATCH_AUTO_BEFORE_FILE
          ? process.env.MANTLE_CPATCH_AUTO_BEFORE_FILE
          : name === '/src/renderer/morphDraw.js' &&
              process.env.MANTLE_CPATCH_AUTO_BEFORE_MORPH_FILE
            ? process.env.MANTLE_CPATCH_AUTO_BEFORE_MORPH_FILE
            : name === '/src/renderer/renderer.js' &&
                process.env.MANTLE_CPATCH_AUTO_BEFORE_RENDERER_FILE
              ? process.env.MANTLE_CPATCH_AUTO_BEFORE_RENDERER_FILE
              : name === '/src/renderer/bundle.js' &&
                  process.env.MANTLE_CPATCH_AUTO_BEFORE_BUNDLE_FILE
                ? process.env.MANTLE_CPATCH_AUTO_BEFORE_BUNDLE_FILE
                : file,
      ),
    );
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = capWallTime(
  'cpatchAutoGpuSmoke',
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
    // Exercise the deadline delivered when a busy page has no spare idle time.
    const nativeIdle = window.requestIdleCallback;
    window.requestIdleCallback = (cb) =>
      setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 0);
    const heldLb = [];
    let captureLb = false,
      lbJob = null;
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, opts) {
        super(url, opts);
        this.isLb = String(url).endsWith('/lbBuild.worker.js');
        if (this.isLb)
          this.addEventListener('message', (event) => {
            if (captureLb && event.data.id === lbJob) {
              event.stopImmediatePropagation();
              heldLb.push({ worker: this, data: event.data });
            }
          });
      }
      postMessage(...args) {
        if (this.isLb && captureLb && args[0].curves) lbJob = args[0].id;
        return super.postMessage(...args);
      }
    };
    const api = await import('/src/index.js');
    const gl = document.getElementById('c').getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      depth: true,
    });
    const ext = gl.getExtension('WEBGL_debug_renderer_info'),
      device = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    if (!/Apple|Metal/.test(device) || /software|swiftshader|llvmpipe/i.test(device))
      throw Error('Physical Metal GPU required');
    const shaders = await api.loadShaders(new URL('/src/shaders/', location.href));
    const r = api.createRenderer(gl, shaders, {
      cpatchAuto: true,
      aacPoints: false,
      psoWarmIdle: () => true,
    });
    r.setViewport(128, 128);
    r.setFillEngine({ route: 'cpatch-auto' });
    const svg = (t) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#f00" fill-opacity=".4" d="M10 20 Q45 ${5 + t * 5} 80 20 L80 80 Q45 95 10 80 Z"/><path fill="#00f" fill-opacity=".5" d="M20 25 Q55 10 90 25 L90 ${85 - t * 5} Q55 100 20 85 Z"/></svg>`;
    const a = await api.importSvg(svg(0)),
      b = await api.importSvg(svg(1));
    const bundle = api.createBundle(gl, a);
    const start = performance.now();
    r.prepareBundle(bundle);
    const prepareMs = performance.now() - start;
    const draw = async (renderer, target) => {
      const t = performance.now();
      renderer.beginFrame([0, 0, 0, 0]);
      renderer.drawBundle(target);
      renderer.endFrame();
      if (!(await window.__gpuFence(gl, 20000))) throw Error('Fence');
      await window.__gpuIdle(performance.now() - t);
    };
    const warm = async (renderer, target) => {
      renderer.prepareBundle(target.bundle || target);
      if (target.bundle && target.setT) await renderer.awaitLbReady(target, 20000);
      const report = await renderer.warmScene(
        [
          {
            name: 'draw',
            draw: () => {
              renderer.beginFrame([0, 0, 0, 0]);
              renderer.drawBundle(target);
              renderer.endFrame();
            },
          },
        ],
        { maxPasses: 12, fenceTimeoutMs: 20000 },
      );
      if (!report.complete) throw Error('Incomplete warm ' + JSON.stringify(report));
      for (let i = 0; i < 3; i++) await draw(renderer, target);
    };
    const read = () => {
      const p = new Uint8Array(128 * 128 * 4);
      gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, p);
      return p;
    };
    const delta = (x, y) => {
      let max = 0,
        changed = 0;
      for (let i = 0; i < x.length; i++) {
        const d = Math.abs(x[i] - y[i]);
        max = Math.max(max, d);
        changed += d > 0;
      }
      return { max, changed };
    };
    const states = [];
    const state = (label) =>
      states.push({
        label,
        owner: bundle._fillMeshOwner,
        gen: bundle._geomGen,
        lbGen: bundle._lbGen,
        built: bundle._cpatchBuilt,
        autoBuilt: bundle._cpatchAutoBuilt,
        tried: bundle._cpatchAutoTriedGen,
        meshes:
          bundle._lbMeshes &&
          bundle._lbMeshes.map((m) => m && { cp: m.cpatch, slug: m.slug, n: m.vertexCount }),
        pending: bundle._lbWorkerPendingGen,
      });
    await warm(r, bundle);
    state('initial');
    const cpPixels = read(),
      cpCount = r.debugStats.engines.draws.cpatch || 0;
    if (!cpCount) throw Error('Static auto did not draw CPatch');
    const reference = api.createRenderer(gl, shaders, {
      aacFill: true,
      aacPoints: false,
      psoWarmIdle: () => true,
    });
    reference.setViewport(128, 128);
    reference.setFillEngine({ route: 'none', kernel: 'aac' });
    const refBundle = api.createBundle(gl, a);
    await warm(reference, refBundle);
    const staticDiff = delta(cpPixels, read());
    const center = Array.from(cpPixels.slice((64 * 128 + 64) * 4, (64 * 128 + 64) * 4 + 4));
    r.setFillEngine({ route: 'auto', cpatch: false });
    await warm(r, bundle);
    state('disabled');
    const beforeOff = r.debugStats.engines.draws.cpatch || 0;
    await draw(r, bundle);
    const disabledDelta = (r.debugStats.engines.draws.cpatch || 0) - beforeOff;
    const disabledDiff = delta(cpPixels, read());
    r.setFillEngine({ route: 'cpatch-auto' });
    r.prepareBundle(bundle);
    state('reenabled prepare');
    await warm(r, bundle);
    state('reenabled warm');
    const beforeReenable = r.debugStats.engines.draws.cpatch || 0;
    await draw(r, bundle);
    const reenabledDelta = (r.debugStats.engines.draws.cpatch || 0) - beforeReenable;
    const reenabledDiff = delta(cpPixels, read());
    const pinSections = await api.importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#468" fill-opacity=".6" d="M10 50 C10 5 90 5 90 50 C90 95 10 95 10 50 Z"/></svg>',
    );
    const pinBundle = api.createBundle(gl, pinSections),
      pinSwitches = [];
    for (const route of ['lb', 'cpatch', 'lb', 'cpatch']) {
      r.setFillEngine({ route });
      r.prepareBundle(pinBundle);
      const ready = await r.awaitEngine(pinBundle, route, 20000);
      await warm(r, pinBundle);
      const counts = { ...r.debugStats.engines.draws };
      await draw(r, pinBundle);
      const draws = Object.fromEntries(
        Object.entries(r.debugStats.engines.draws).map(([k, v]) => [k, v - (counts[k] || 0)]),
      );
      const pixels = read(),
        center = Array.from(pixels.slice((64 * 128 + 64) * 4, (64 * 128 + 64) * 4 + 4));
      pinSwitches.push({ route, ready, owner: pinBundle._fillMeshOwner, draws, center });
    }
    const diagnosticMeshes = pinBundle._lbMeshes;
    r.setFillEngine({ route: 'lb' });
    for (let i = 0; i < 3; i++) void r.debugStats;
    const diagnosticsKeptMeshes =
      pinBundle._fillMeshOwner === 'cpatch' && pinBundle._lbMeshes === diagnosticMeshes;
    const diagnosticsQueuedBuild = pinBundle._lbWorkerPendingGen === (pinBundle._geomGen | 0);
    r.setFillEngine({ route: 'cpatch' });
    await draw(r, pinBundle);
    const hooks = await import('/src/renderer/bundle.js');
    const idlePeer = api.createRenderer(gl, shaders, { aacPoints: false });
    idlePeer.setFillEngine({ route: 'lb' });
    let idleSeen = false;
    const idleMarker = (b) => {
      if (b === pinBundle) idleSeen = true;
      return false;
    };
    hooks.setLbPreparer(gl, idleMarker);
    hooks.enqueueLbPrepare(gl, pinBundle);
    const idleDeadline = performance.now() + 5000;
    while (!idleSeen && performance.now() < idleDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    hooks.removeLbPreparer(gl, idleMarker);
    window.requestIdleCallback = nativeIdle;
    const idleOwner = pinBundle._fillMeshOwner,
      idleBefore = r.debugStats.engines.draws.cpatch || 0;
    await draw(r, pinBundle);
    const idleCpDraws = (r.debugStats.engines.draws.cpatch || 0) - idleBefore;
    captureLb = true;
    idlePeer.setLoopBlinnShapeMemoryBudget(1);
    const pendingBundle = api.createBundle(gl, pinSections);
    idlePeer.setLoopBlinnShapeMemoryBudget(Infinity);
    r.prepareBundle(pendingBundle);
    const replyDeadline = performance.now() + 20000;
    while (!heldLb.some((x) => x.data.kind !== 'lbPartial')) {
      if (performance.now() > replyDeadline) throw Error('No actual LB worker completion');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const lbDeclined = heldLb.some((x) => x.data.kind !== 'lbPartial' && x.data.hasReal === false);
    const cpDeadline = performance.now() + 20000;
    while (pendingBundle._cpatchConv === 'pending') {
      if (performance.now() > cpDeadline) throw Error('CPatch conversion timeout');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    r.prepareBundle(pendingBundle);
    await warm(r, pendingBundle);
    const cpReadyWithLbPending = await r.awaitEngine(pendingBundle, 'cpatch', 200);
    const pendingPixels = read(),
      pendingMeshes = pendingBundle._lbMeshes;
    captureLb = false;
    for (const reply of heldLb) reply.worker.onmessage({ data: reply.data });
    const lbKeptMeshes = pendingBundle._lbMeshes === pendingMeshes,
      cpBeforeReplyDraw = r.debugStats.engines.draws.cpatch || 0;
    await draw(r, pendingBundle);
    const lbReplyCpDraws = (r.debugStats.engines.draws.cpatch || 0) - cpBeforeReplyDraw,
      lbReplyDiff = delta(pendingPixels, read());
    const lbReplies = heldLb.length;
    pendingBundle.dispose();
    idlePeer.dispose();
    pinBundle.dispose();
    const src = api.createBundle(gl, a),
      dst = api.createBundle(gl, b),
      morph = api.createShapeMorph(gl, src, dst);
    const morphDiffs = [];
    let morphCpatchDraws = 0;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      morph.setT(t);
      r.setFillEngine({ route: 'auto', cpatch: false });
      await warm(r, morph);
      const expected = read();
      r.setFillEngine({ route: 'cpatch-auto' });
      const before = r.debugStats.engines.draws.cpatch || 0;
      await warm(r, morph);
      morphCpatchDraws += (r.debugStats.engines.draws.cpatch || 0) - before;
      morphDiffs.push(delta(expected, read()));
    }
    const crossing = await api.importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#468" fill-opacity=".6" d="M15 50 A25 25 0 1 0 65 50 A25 25 0 1 0 15 50 Z M35 50 A25 25 0 1 0 85 50 A25 25 0 1 0 35 50 Z"/></svg>',
    );
    const crossBundle = api.createBundle(gl, crossing);
    r.setFillEngine({ route: 'auto', cpatch: false });
    await warm(r, crossBundle);
    const crossExpected = read();
    r.setFillEngine({ route: 'cpatch-auto' });
    const crossBefore = r.debugStats.engines.draws.cpatch || 0;
    await warm(r, crossBundle);
    const crossCpatchDraws = (r.debugStats.engines.draws.cpatch || 0) - crossBefore;
    const crossDiff = delta(crossExpected, read()),
      crossStatus = crossBundle.fillNormByShape && crossBundle.fillNormByShape[0];
    const localPoints = Array.from({ length: 96 }, (_, i) => {
      const angle = (i * Math.PI) / 48,
        radius = i % 2 ? 22 : 42;
      return [50 + radius * Math.cos(angle), 50 + radius * Math.sin(angle)];
    });
    const localSvg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#d15d22" fill-opacity=".47" d="M' +
      localPoints.map((p) => p.join(' ')).join('L') +
      'Z"/><path fill="#8844aa" fill-opacity=".22" d="M30 35H70V75H30Z"/><path fill="#44aa77" fill-opacity=".31" d="M30 45A16 11 0 1 0 62 45L57 62Z"/></svg>';
    const localSections = await api.importSvg(localSvg, { preserveViewport: true });
    const localBundle = api.createBundle(gl, localSections),
      localReference = api.createBundle(gl, localSections);
    const preparedDefaultRows = [];
    r.setFillEngine({ route: 'cpatch', kernel: 'slug', primitives: 'off' });
    const readLocal = (size) => {
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    let originalMeshes = null,
      originalAdopt;
    for (const size of [256, 128, 256]) {
      gl.canvas.width = gl.canvas.height = size;
      r.setViewport(size, size);
      reference.setViewport(size, size);
      r.prepareBundle(localBundle);
      if (!(await r.awaitEngine(localBundle, 'cpatch', 20000)))
        throw Error('Bounded polynomial preparation not ready');
      await warm(r, localBundle);
      const before = { ...r.debugStats.engines.draws };
      await draw(r, localBundle);
      const after = r.debugStats.engines.draws,
        draws = Object.fromEntries(
          Object.keys(after).map((key) => [key, after[key] - (before[key] || 0)]),
        );
      const pixels = readLocal(size),
        cache = localBundle._unifiedFill;
      const spatial = localBundle._lbMeshes.findIndex(
        (mesh) => mesh?._cpAdmission?.kind === 'spatial-static-polynomial',
      );
      const wire = Array.from(cache.spanS, (shape, i) => ({ shape, engine: cache.spanEngine[i] }));
      if (!originalMeshes) {
        originalMeshes = localBundle._lbMeshes.map((mesh) => ({
          mesh,
          slug: mesh?.slug,
          verts: mesh?.verts,
        }));
        originalAdopt = localBundle._lbAdoptKey;
      }
      const unchanged =
        originalAdopt === localBundle._lbAdoptKey &&
        originalMeshes.every(
          (saved, i) =>
            saved.mesh === localBundle._lbMeshes[i] &&
            saved.slug === localBundle._lbMeshes[i]?.slug &&
            saved.verts === localBundle._lbMeshes[i]?.verts,
        );
      await warm(reference, localReference);
      preparedDefaultRows.push({
        size,
        draws,
        spatial,
        wire,
        unchanged,
        difference: delta(pixels, readLocal(size)),
      });
    }
    localBundle.dispose();
    localReference.dispose();
    const out = {
      preparedDefaultRows,
      device,
      states,
      pinSwitches,
      diagnosticsKeptMeshes,
      diagnosticsQueuedBuild,
      idleSeen,
      idleOwner,
      idleCpDraws,
      cpReadyWithLbPending,
      lbDeclined,
      lbKeptMeshes,
      lbReplyCpDraws,
      lbReplyDiff,
      lbReplies,
      prepareMs,
      cpCount,
      staticDiff,
      center,
      disabledDelta,
      disabledDiff,
      reenabledDelta,
      reenabledDiff,
      morphDiffs,
      morphCpatchDraws,
      crossStatus,
      crossCpatchDraws,
      crossDiff,
      glError: gl.getError(),
    };
    crossBundle.dispose();
    morph.dispose();
    src.dispose();
    dst.dispose();
    refBundle.dispose();
    bundle.dispose();
    reference.dispose();
    r.dispose();
    return out;
  });
  console.log(JSON.stringify(result));
  assert.ok(result.cpCount > 0);
  assert.ok(result.staticDiff.max <= 1, 'static auto / raw AAC parity');
  assert.ok(
    result.center.every((v, i) => Math.abs(v - [51, 0, 128, 179][i]) <= 1),
    'ordered translucent source-over center',
  );
  assert.equal(result.disabledDelta, 0, 'disabling auto CPatch stops CPatch draws');
  assert.ok(result.disabledDiff.max <= 1, 'disabling auto preserves static pixels');
  assert.ok(result.reenabledDelta > 0, 'reenabling auto rebuilds and draws CPatch');
  assert.ok(result.reenabledDiff.max <= 1, 'reenabling auto preserves static pixels');
  assert.ok(
    result.pinSwitches.every((x) => x.ready && x.owner === x.route && x.draws[x.route] > 0),
    'explicit LB/CPatch pins replace the previous static mesh owner',
  );
  assert.ok(
    result.pinSwitches.every((x) =>
      x.center.every((v, i) => Math.abs(v - [41, 61, 82, 153][i]) <= 1),
    ),
    'explicit pin switches preserve translucent paint',
  );
  assert.ok(
    result.diagnosticsKeptMeshes && !result.diagnosticsQueuedBuild,
    'diagnostic reads do not transfer meshes or queue geometry builds',
  );
  assert.ok(
    result.idleSeen && result.idleOwner === 'cpatch' && result.idleCpDraws > 0,
    'idle preparation by an LB peer preserves the live CPatch draw',
  );
  assert.ok(
    result.cpReadyWithLbPending,
    'current CPatch owner is ready while obsolete LB completion is pending',
  );
  assert.ok(
    result.lbReplies > 0 && result.lbDeclined,
    'held a real memory-declined LB worker completion',
  );
  assert.ok(
    result.lbKeptMeshes && result.lbReplyCpDraws > 0 && result.lbReplyDiff.max === 0,
    'late LB decline preserves the newer CPatch mesh and pixels',
  );
  assert.equal(result.morphCpatchDraws, 0, 'auto never draws CPatch morphs');
  assert.ok(
    result.morphDiffs.every((d) => d.max === 0),
    'morph auto-policy toggle is pixel identical',
  );
  assert.equal(result.crossStatus, -1, 'crossing boundary was not certified');
  assert.equal(result.crossCpatchDraws, 0, 'uncertified crossing shape skips CPatch');
  assert.equal(result.crossDiff.max, 0, 'crossing fallback pixels remain identical');
  assert.equal(result.glError, 0);
  assert.equal(result.preparedDefaultRows.length, 3);
  for (const row of result.preparedDefaultRows) {
    assert(row.unchanged);
    assert(row.spatial >= 0);
    assert.equal(
      row.wire.find((span) => span.shape === row.spatial)?.engine,
      row.size === 128 ? 16 : 1,
    );
    assert(row.draws.cpatch > 0 && row.draws.slug > 0);
    assert.equal(row.draws.aac || 0, 0);
    assert(row.difference.max <= 1, 'bounded default/raw AAC parity');
  }
  console.log('CPatch auto Metal PASS');
} finally {
  stop.clear();
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

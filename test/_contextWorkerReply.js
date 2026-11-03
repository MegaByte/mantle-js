// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

export async function run(version, c) {
  const NativeWorker = globalThis.Worker,
    held = [];
  globalThis.Worker = class extends NativeWorker {
    constructor(url, opts) {
      super(url, opts);
      if (String(url).endsWith('/occupancy.worker.js'))
        this.addEventListener('message', (event) => {
          event.stopImmediatePropagation();
          held.push({ worker: this, data: event.data });
        });
    }
  };
  const api = await import('/' + version + '/src/index.js'),
    shaders = await api.loadShaders(new URL('/' + version + '/src/shaders/', location.href)),
    rows = [];
  const wait = async (fn) => {
    const deadline = performance.now() + 20000;
    while (!fn()) {
      if (performance.now() > deadline) throw Error('Real worker reply timeout');
      await window.__gpuIdle(1);
    }
  };
  const digest = async (bytes) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
      v.toString(16).padStart(2, '0'),
    ).join('');
  try {
    for (const kind of ['occupancy', 'tier3'])
      for (const restore of [false, true]) {
        const svg =
          kind === 'occupancy'
            ? c.svg
            : c.cubic.replaceAll('<path', '<path stroke="#111" stroke-width="8"');
        const options =
          kind === 'occupancy'
            ? { preserveViewport: true }
            : { preserveViewport: true, noAaTree: true, occupancyGrid: false };
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 128;
        document.body.append(canvas);
        const gl = canvas.getContext('webgl2', {
          antialias: false,
          preserveDrawingBuffer: true,
          depth: true,
          stencil: true,
        });
        const ext = gl.getExtension('WEBGL_lose_context'),
          dbg = gl.getExtension('WEBGL_debug_renderer_info'),
          device = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
        if (/software|swiftshader|llvmpipe/i.test(device)) throw Error('Physical GPU required');
        const renderer = () => {
          const r = api.createRenderer(gl, shaders, {
            aacFill: true,
            aacPoints: false,
            psoWarmIdle: () => true,
          });
          r.setViewport(128, 128);
          r.setFillEngine({ route: 'none', kernel: 'aac', commit: false });
          return r;
        };
        const r = renderer(),
          sections = await api.importSvg(svg, options);
        const pending = kind === 'occupancy' ? sections.pendingOccupancy : sections.pendingTier3;
        if (!pending?.length) throw Error(kind + ' fixture has no actual pending job');
        const bundle = api.createBundle(gl, sections);
        await wait(() => held.length > 0);
        const draw = async (r, b) => {
          r.precompileFills();
          // The throttle charges the frame drawn and read here: precompileFills returns behind a GPU read-back barrier, and its link time is CPU work.
          const t = performance.now();
          r.beginFrame([0, 0, 0, 0]);
          r.drawBundle(b);
          r.endFrame();
          if (!(await window.__gpuFence(gl, 20000))) throw Error('Fence');
          const p = new Uint8Array(128 * 128 * 4);
          gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, p);
          if (!p.some((v, i) => i % 4 === 3 && v > 1)) throw Error('Blank actual draw');
          const error = gl.getError();
          if (error) throw Error('Draw GL ' + error);
          await window.__gpuIdle(performance.now() - t);
          return digest(p);
        };
        let before;
        for (let i = 0; i < 4; i++) before = await draw(r, bundle);
        let currentR = r,
          currentB = bundle;
        const event = (name) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error(name + ' timeout')), 10000);
            canvas.addEventListener(
              name,
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        if (restore) {
          const lost = event('webglcontextlost');
          ext.loseContext();
          await lost;
          gl.getError();
          await new Promise((r) => setTimeout(r, 100));
          const restored = event('webglcontextrestored');
          ext.restoreContext();
          await restored;
          if (gl.getError()) throw Error('Restoration setup error');
          currentR = renderer();
          currentB = api.createBundle(
            gl,
            await api.importSvg(svg, {
              ...options,
              occupancyGrid: false,
              ...(kind === 'tier3' ? { gwnTree: true } : {}),
            }),
          );
        }
        let freshBefore;
        for (let i = 0; i < 4; i++) freshBefore = await draw(currentR, currentB);
        if (gl.getError()) throw Error('Pre-reply error');
        const jobs = held.splice(0);
        let nonzero = 0;
        for (const j of jobs)
          for (const grid of j.data[kind === 'occupancy' ? 'occ' : 'tier3'] || [])
            nonzero += Array.from(grid[kind === 'occupancy' ? 'bits' : 'cells'] || []).filter(
              (v) => v !== 0,
            ).length;
        if (!jobs.length || !nonzero) throw Error('Actual worker control is empty');
        const payload = JSON.stringify(jobs.map((j) => j.data));
        for (const j of jobs) j.worker.onmessage({ data: j.data });
        const uploadErrors = [];
        for (let i = 0; i < 16; i++) {
          const error = gl.getError();
          if (!error) break;
          uploadErrors.push(error);
        }
        const uploadError = uploadErrors[0] || 0;
        if (JSON.stringify(jobs.map((j) => j.data)) !== payload)
          throw Error('Real worker payload changed');
        let after = null,
          afterError = null;
        try {
          after = await draw(currentR, currentB);
        } catch (error) {
          afterError = String(error.stack || error);
          if (version === 'candidate') throw error;
        }
        const row = {
          version,
          kind,
          restore,
          device,
          pending: pending.length,
          jobs: jobs.length,
          nonzero,
          uploadError,
          uploadErrors,
          replyCompleted: !bundle._occupancyBuildPending,
          afterError,
          before,
          freshBefore,
          after,
          draws: structuredClone(currentR.debugStats.engines.draws),
        };
        rows.push(row);
        if (restore) {
          currentB.dispose();
          currentR.dispose();
        }
        bundle.dispose();
        r.dispose();
        gl.getError();
        ext.loseContext();
        canvas.remove();
        (
          await import('/' + version + '/src/renderer/occupancyWorkerPool.js')
        ).disposeOccupancyWorker();
      }
  } finally {
    globalThis.Worker = NativeWorker;
    (await import('/' + version + '/src/renderer/occupancyWorkerPool.js')).disposeOccupancyWorker();
  }
  return rows;
}

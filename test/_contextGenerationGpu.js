// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

export async function run(version, config) {
  const api = await import('/' + version + '/src/index.js');
  const shaders = await api.loadShaders(new URL('/' + version + '/src/shaders/', location.href));
  const rows = [];
  const svg = (d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${d}</svg>`;
  const arc = {
    svg: svg(
      '<path id="paint" fill="#df306f" fill-opacity=".3" stroke="#2b87df" stroke-width="3" d="M24 64A40 34 12 1 1 104 64A40 34 12 1 1 24 64Z"/>',
    ),
    morphSvgDst: svg(
      '<path id="paint" fill="#207fda" fill-opacity=".8" stroke="#df7830" stroke-width="4" d="M16 58A48 40 23 1 1 108 78A48 40 23 1 1 16 58Z"/>',
    ),
  };
  const scenes = [
    { ...config.simple, name: 'raw-cubic', route: 'none' },
    { ...arc, name: 'raw-arc-stroke', route: 'none' },
    { ...config.lb, name: 'lb-groups', route: 'lb' },
    { ...config.prepared, name: 'cpatch-cubic', route: 'cpatch' },
    { ...config.simple, name: 'shared-group-cache', route: 'none', cached: true },
  ];
  for (const scene of scenes)
    for (const order of ['old-first', 'new-first', 'during-loss']) {
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
        dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const device = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      if (/software|swiftshader|llvmpipe/i.test(device)) throw Error('Physical GPU required');
      const row = {
        version,
        scene: scene.name,
        route: scene.route,
        order,
        device,
        stages: [],
        pixels: {},
        sharedPassCompiles: [],
      };
      let generation = 0;
      canvas.addEventListener('webglcontextlost', () => generation++);
      const shaderSource = gl.shaderSource.bind(gl);
      gl.shaderSource = (shader, source) => {
        const pass = source.includes('o = mix(texelFetch(uA, p, 0), texelFetch(uB, p, 0), uT);')
          ? 'lerp'
          : source.includes('flat in ivec4 vFix;')
            ? 'fixup'
            : source.includes('uniform highp sampler2D uPA, uPB, uPC;')
              ? 'cpatch'
              : null;
        if (pass) row.sharedPassCompiles.push({ generation, pass });
        shaderSource(shader, source);
      };
      let old, fresh;
      const cleanError = (label) => {
        const error = gl.getError();
        row.stages.push({ label, error });
        if (version === 'candidate' && error && error !== gl.CONTEXT_LOST_WEBGL)
          throw Error(label + ' GL ' + error);
        return error;
      };
      const snapshot = async (owner, label) => {
        const drawsBefore = { ...owner.r.debugStats.engines.draws };
        if (owner.m) owner.m.setT(0.7);
        owner.r.precompileFills();
        // The throttle charges the frame drawn and read here: precompileFills returns behind a GPU read-back barrier, and its link time is CPU work.
        const t = performance.now();
        owner.r.beginFrame([0, 0, 0, 0]);
        if (owner.handles) owner.handles[owner.frame++ % 2].draw();
        else owner.r.drawBundle(owner.m);
        owner.r.endFrame();
        if (!(await window.__gpuFence(gl, 20000))) throw Error(label + ' fence');
        const px = new Uint8Array(128 * 128 * 4);
        gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const error = cleanError(label);
        if (error) throw Error(label + ' GL ' + error);
        if (!px.some((v, i) => i % 4 === 3 && v > 1)) throw Error(label + ' blank');
        const drawKey = scene.route === 'none' ? 'aac' : scene.route;
        if (
          !scene.cached &&
          !(owner.r.debugStats.engines.draws[drawKey] > (drawsBefore[drawKey] || 0))
        )
          throw Error(label + ' requested route was not drawn');
        row.pixels[label] = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', px)),
          (v) => v.toString(16).padStart(2, '0'),
        ).join('');
        await window.__gpuIdle(performance.now() - t);
        return px;
      };
      const create = async (label) => {
        const r = api.createRenderer(gl, shaders, {
          aacFill: true,
          aacPoints: false,
          cpatchFill: scene.route === 'cpatch',
          psoWarmIdle: () => true,
        });
        r.setViewport(128, 128);
        r.setFillEngine({ route: scene.route, kernel: 'aac', commit: false });
        const a = api.createBundle(gl, await api.importSvg(scene.svg, { preserveViewport: true }));
        const b = api.createBundle(
          gl,
          await api.importSvg(scene.morphSvgDst, { preserveViewport: true }),
        );
        a.globalBBox = b.globalBBox = [0, 0, 128, 128];
        const m = scene.cached ? null : api.createShapeMorph(gl, a, b);
        if (m) {
          m.bundle.globalBBox = [0, 0, 128, 128];
          m.bundle._morphSrc.gpuSmallPlanes = true;
          m.setT(0.7);
        }
        const owner = { r, a, b, m, frame: 0 };
        if (scene.cached) {
          const opts = {
            staticCache: {
              strategy: api.CacheStrategy.ForceSharedGroup,
              instanceGroupKey: 'context-generation',
            },
          };
          owner.handles = [r.createBundleHandle(a, opts), r.createBundleHandle(a, opts)];
        }
        cleanError(label + '-create');
        if (scene.route !== 'none') {
          if (scene.route === 'cpatch') await r.warmCPatchPool();
          r.prepareBundle(m.bundle);
          if (!(await r.awaitEngine(m.bundle, scene.route, 20000)))
            throw Error(label + ' route not ready');
        }
        for (let i = 0; i < 4; i++) await snapshot(owner, label + '-warm' + i);
        const draws = structuredClone(r.debugStats.engines.draws);
        row[label] = {
          draws,
          gpuCurveLerp: !!m?.usesGpuCurveLerp,
          sharedTarget: owner.handles
            ? !!owner.handles[0].cacheTex && owner.handles[0].cacheTex === owner.handles[1].cacheTex
            : null,
        };
        if (m && !m.usesGpuCurveLerp) throw Error('GPU morph was not selected');
        if (!scene.cached && !(draws[scene.route === 'none' ? 'aac' : scene.route] > 0))
          throw Error('Actual requested route missing');
        if (scene.cached && (!row[label].sharedTarget || !gl.isTexture(owner.handles[0].cacheTex)))
          throw Error('Actual live shared cache target missing');
        return owner;
      };
      const dispose = (owner, label) => {
        if (owner.handles)
          for (const [i, h] of owner.handles.entries()) {
            h.dispose();
            cleanError(label + '-handle' + i);
          }
        for (const [name, fn] of [
          ['morph', () => owner.m?.dispose()],
          ['source', () => owner.a.dispose()],
          ['destination', () => owner.b.dispose()],
          ['renderer', () => owner.r.dispose()],
        ]) {
          fn();
          cleanError(label + '-' + name);
        }
      };
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
      try {
        old = await create('old');
        await snapshot(old, 'before-loss');
        const lost = event('webglcontextlost');
        ext.loseContext();
        await lost;
        if (order === 'during-loss') {
          dispose(old, 'dispose-old');
          old = null;
        }
        await new Promise((r) => setTimeout(r, 100));
        const restored = event('webglcontextrestored');
        ext.restoreContext();
        await restored;
        cleanError('restored');
        if (order === 'old-first') {
          dispose(old, 'dispose-old');
          old = null;
        }
        fresh = await create('fresh');
        await snapshot(fresh, 'fresh-before-old-disposal');
        if (old) {
          dispose(old, 'dispose-old');
          old = null;
        }
        if (fresh.m) fresh.m.setT(0.3);
        await snapshot(fresh, 'fresh-after-old-disposal');
        // A third owner must reuse the current shared morph pass, not resurrect
        // an old generation or invalidate the still-live second owner.
        const third = await create('third');
        await snapshot(third, 'third-current-generation');
        dispose(third, 'dispose-third');
        await snapshot(fresh, 'fresh-after-third-disposal');
        dispose(fresh, 'dispose-fresh');
        fresh = null;
        row.completed = true;
        row.passed = row.stages.every(
          (s) => !s.error || (order === 'during-loss' && s.error === gl.CONTEXT_LOST_WEBGL),
        );
      } catch (e) {
        row.error = String(e.stack || e);
        row.passed = false;
      } finally {
        try {
          if (old) dispose(old, 'cleanup-old');
        } catch {}
        try {
          if (fresh) dispose(fresh, 'cleanup-fresh');
        } catch {}
        ext.loseContext();
        canvas.remove();
      }
      rows.push(row);
    }
  (await import('/' + version + '/src/renderer/occupancyWorkerPool.js')).disposeOccupancyWorker();
  (await import('/' + version + '/src/renderer/cpatchWorkerPool.js')).disposeCpatchPool();
  return rows;
}

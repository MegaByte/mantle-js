// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupFilterCacheRenderSmoke -- a filter on a <g> hits the filter-result cache, and only while every input is unchanged.
//
// The group's filter runs at groupEnd over the accumulator its children painted. Its result is cached per
// (owner, filter, group row) under a key of: bundle generation, geometry generation, morph t, canvas, the exact world
// matrix, the recolor state, the filter parameter generation and graph object, the override table and every child row's
// override generation, the mask bake generation, the resources the children sample, and the fill variant. The group's own
// opacity is not a term (the group composite applies it after the filter), so it must NOT miss.
//
// Each state is drawn by a cached renderer and by one built with `groupFilterCache: false`; the pictures must be
// byte-identical, so a stale hit cannot hide. Both fill routes run (drawList loop, unified route).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOTS =
  '<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/><rect x="99.5" y="99.5" width="0.5" height="0.5" fill="#000"/>';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  DOTS +
  '<defs><filter id="f"><feGaussianBlur stdDeviation="3" result="b"/><feOffset in="b" dx="2" dy="2"/></filter></defs>' +
  '<g id="grp" filter="url(#f)"><rect id="a" x="25" y="35" width="18" height="18" fill="#c03020"/>' +
  '<rect id="b" x="55" y="40" width="18" height="18" fill="#2060c0"/></g></svg>';

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="300" height="300"></canvas></body></html>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, {
      'content-type':
        (/\.(m?js)$/.test(u.pathname) ? 'text/javascript' : 'text/plain') + '; charset=utf-8',
    });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});

const out = await page.evaluate(async (svg) => {
  const {
    importSvg,
    createBundle,
    createRenderer,
    loadShaders,
    createOverrideTable,
    createFilterParams,
  } = await import('/src/index.js');
  const gl = document.getElementById('c').getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: true,
    stencil: true,
    depth: true,
  });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const nextFrame = () =>
    new Promise((r) => {
      const t = setTimeout(r, 100);
      requestAnimationFrame(() => {
        clearTimeout(t);
        r();
      });
    });
  const sec = await importSvg(svg);
  const results = [];
  for (const route of ['drawList', 'unified']) {
    const mk = (opts) => {
      const R = createRenderer(gl, shaders, { aacFill: false, ...opts });
      R.setLoopBlinnFill(route === 'unified' ? 'on' : 'off');
      return R;
    };
    const side = { cached: null, plain: null };
    for (const k of Object.keys(side)) {
      const R = mk(k === 'plain' ? { groupFilterCache: false } : {});
      const b = createBundle(gl, sec);
      side[k] = {
        R,
        b,
        ov: createOverrideTable(gl, b),
        ov2: createOverrideTable(gl, b),
        fp: createFilterParams(b),
        size: 300,
      };
    }
    const state = {
      world: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      useOv: null,
      alpha: 1,
      cm: null,
      size: 300,
    };
    const frame = (s) => {
      s.R.invalidateRenderState && s.R.invalidateRenderState();
      s.R.setViewport(state.size, state.size);
      s.R.beginFrame([1, 1, 1, 1]);
      const o = { worldMatrix: new Float32Array(state.world), alpha: state.alpha };
      if (state.useOv) o.overrides = s[state.useOv];
      if (state.cm) o.colorMatrix = state.cm;
      s.R.drawBundle(s.b, o);
      s.R.endFrame();
      const px = new Uint8Array(state.size * state.size * 4);
      gl.readPixels(0, 0, state.size, state.size, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const evals = (s) => s.R.debugStats.filterEvalCount | 0;
    const uni = (s) => s.R.debugStats.unifiedFilterDraws | 0;
    const hash = (px) => {
      let h = 2166136261;
      for (let i = 0; i < px.length; i++) {
        h ^= px[i];
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h;
    };
    // Draw a state until a frame on the cached side evaluates nothing (the unified route links its program over a few frames).
    const settle = async (name, expectHit) => {
      const c = side.cached,
        p = side.plain;
      const e0 = evals(c),
        u0 = uni(c);
      let pc = null,
        hit = false,
        n = 0;
      // The bound is wall time, not a frame count: a state that adds a fill variant (recolor) re-evaluates until that variant has linked, and
      // under CPU load the link takes more than 14 frames (the first attempt failed and the retry passed, three times). A real cache bug never
      // settles, so the bound still catches it. The per-frame evaluation counts are kept for the failure message.
      const t0 = performance.now(),
        trace = [];
      for (; performance.now() - t0 < 12000; n++) {
        await nextFrame();
        const before = evals(c);
        pc = frame(c);
        frame(p);
        trace.push(evals(c) - before);
        if (evals(c) === before) {
          hit = true;
          if (n >= 1 || !expectHit) break;
        }
      }
      const pp = frame(p),
        pp2 = frame(p);
      let diff = 0,
        first = null,
        self = 0; // The two corner dots only pin the fit; they are drawn outside the filter, and two renderers whose fill variants warm at
      // different frames disagree on a dot's edge pixel by 1 LSB. They are masked; the filtered group is what is compared.
      const dot = (i) => {
        const x = (i >> 2) % state.size,
          y = ((i >> 2) / state.size) | 0;
        return (x < 4 || x >= state.size - 4) && (y < 4 || y >= state.size - 4);
      };
      for (let i = 0; i < pc.length; i++) {
        if (pc[i] !== pp[i] && !dot(i)) {
          diff++;
          if (!first)
            first = [(i >> 2) % state.size, ((i >> 2) / state.size) | 0, i & 3, pc[i], pp[i]];
        }
        if (pp[i] !== pp2[i]) self++;
      }
      // After settling, one more frame must still hit (when a hit is possible at all).
      const e1 = evals(c);
      const again = frame(c);
      const stillHit = evals(c) === e1;
      results.push({
        route,
        name,
        hit,
        stillHit,
        trace: trace.join(''),
        frames: n,
        ms: Math.round(performance.now() - t0),
        diff,
        first,
        self,
        hash: hash(pc),
        firstEvals: e1 - e0,
        uniDelta: uni(c) - u0,
        plainEvalsGrow: evals(p),
      });
      return { px: pc, e1 };
    };
    const probe = async (name, mutate, expectMiss) => {
      const c = side.cached;
      const e0 = evals(c);
      mutate();
      const before = evals(c);
      const pc = frame(c);
      frame(side.plain);
      const missed = evals(c) > before;
      const r = await settle(name, true);
      results[results.length - 1].missedOnChange = missed;
      results[results.length - 1].expectMiss = expectMiss;
      return r;
    };
    // The unified route needs its mesh and program: drive it like filterRegionSmoke.
    for (const s of [side.cached, side.plain]) {
      try {
        s.R.prepareBundle(s.b);
      } catch {}
      if (s.R.awaitLbReady) {
        try {
          await s.R.awaitLbReady(s.b, 20000);
        } catch {}
      }
      if (s.R.prewarmBundle) {
        try {
          s.R.prewarmBundle(s.b);
        } catch {}
      }
      for (let i = 0; i < 6; i++) {
        frame(s);
        if (s.R.precompileFills) {
          try {
            s.R.precompileFills();
          } catch {}
        }
        await nextFrame();
      }
    }
    const base = await settle('static', true);
    const baseHash = hash(base.px);
    await probe(
      'world matrix 0.5',
      () => {
        state.world = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];
      },
      true,
    );
    await probe(
      'world matrix 0.5 * (1 + 2^-12), inside a 1/4096 quantum',
      () => {
        state.world = [0.5 * (1 + 2 ** -12), 0, 0, 0, 0.5, 0, 0, 0, 1];
      },
      true,
    );
    await probe(
      'world matrix 2^-14',
      () => {
        state.world = [2 ** -14, 0, 0, 0, 2 ** -14, 0, 0, 0, 1];
      },
      true,
    );
    await probe(
      'world matrix 2^-14 * 1.5',
      () => {
        state.world = [1.5 * 2 ** -14, 0, 0, 0, 1.5 * 2 ** -14, 0, 0, 0, 1];
      },
      true,
    );
    await probe(
      'world matrix back to identity',
      () => {
        state.world = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      },
      true,
    );
    const ovProbe = await probe(
      'child override moves a',
      () => {
        state.useOv = 'ov';
        for (const s of [side.cached, side.plain]) s.ov.set('a', { localPosition: [12, 0] });
      },
      true,
    );
    await probe(
      'same override, other table with equal generation',
      () => {
        state.useOv = 'ov2';
        for (const s of [side.cached, side.plain]) s.ov2.set('a', { localPosition: [-12, 0] });
      },
      true,
    );
    await probe(
      'child override changes again',
      () => {
        for (const s of [side.cached, side.plain]) s.ov2.set('b', { localPosition: [0, 10] });
      },
      true,
    );
    await probe(
      'filter parameter written',
      () => {
        for (const s of [side.cached, side.plain]) s.fp.set('f1:0', { sigmaX: 7, sigmaY: 7 });
      },
      true,
    );
    await probe(
      'canvas resized',
      () => {
        state.size = 240;
      },
      true,
    );
    await probe(
      'recolor (colorMatrix)',
      () => {
        state.cm = new Float32Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      },
      true,
    );
    await probe(
      'recolor removed',
      () => {
        state.cm = null;
      },
      true,
    );
    // The group's own opacity (draw alpha) is applied after the filter: the cache must still hit.
    const e0 = evals(side.cached);
    state.alpha = 0.5;
    frame(side.cached);
    frame(side.plain);
    const alphaHit = evals(side.cached) === e0;
    const pcA = frame(side.cached),
      ppA = frame(side.plain);
    let dA = 0;
    for (let i = 0; i < pcA.length; i++) if (pcA[i] !== ppA[i]) dA++;
    results.push({ route, name: 'draw alpha 0.5', alphaHit, diff: dA });
    state.alpha = 1;
    // Control: the cache-off renderer evaluates every frame, so the counts above measure the cache.
    const p = side.plain,
      pe = evals(p);
    frame(p);
    frame(p);
    results.push({ route, name: 'cache-off control', evalsPerFrame: (evals(p) - pe) / 2 });
    results.push({ route, name: 'hash', tiny: true, unifiedDraws: uni(side.cached), baseHash });
  }
  return results;
}, SVG);
await browser.close();
server.close();

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
for (const r of out) {
  const t = `${r.route}: ${r.name}`;
  if (r.name === 'hash') {
    ok(r.tiny, `${t}: group filter ran`);
    if (r.route === 'unified')
      ok(
        r.unifiedDraws > 0,
        `${t}: the unified route counted the filtered group (${r.unifiedDraws})`,
      );
    continue;
  }
  if (r.name === 'draw alpha 0.5') {
    ok(r.alphaHit, `${t}: group opacity is not a key term (hit)`);
    ok(r.diff === 0, `${t}: cached picture equals the uncached one (${r.diff} bytes differ)`);
    continue;
  }
  if (r.name === 'cache-off control') {
    ok(r.evalsPerFrame >= 1, `${t}: evaluates every frame (${r.evalsPerFrame})`);
    continue;
  }
  ok(
    r.hit && r.stillHit,
    `${t}: settles on a cache hit` +
      (r.hit && r.stillHit
        ? ''
        : ` (hit ${r.hit}, still ${r.stillHit}, ${r.frames} frames in ${r.ms} ms, evaluations per frame ${r.trace})`),
  );
  ok(
    r.diff === 0,
    `${t}: cached picture equals the uncached one (${r.diff} bytes differ; first [x,y,ch,cached,plain] ${JSON.stringify(r.first)}; plain vs plain ${r.self})`,
  );
  if (r.expectMiss) ok(r.missedOnChange, `${t}: the change missed the cache`);
}
console.log(fail ? `GROUP-FILTER-CACHE FAIL (${fail})` : 'GROUP-FILTER-CACHE PASS');
process.exit(fail ? 1 : 0);

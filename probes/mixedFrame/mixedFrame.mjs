// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// mixedFrame.mjs -- the multi-bundle frame page. N bundles per frame, drawn with the per-draw engine pins a mixed scene needs, under two
// arms in a FRESH browser each: `lean` (every bundle binds its own lean program) and `union` (renderer.setSceneUnion over the scene's bundles:
// bundles of one kernel class bind one program). Measured per run: programs created and linked, link + first-pipeline wall behind a loading
// screen, then steady frames -- CPU submit per frame, fence wall per frame (GPU-dominated), useProgram calls and draws per frame -- and a hash of the
// final frame, so the two arms are checked byte-identical (a union program is a superset of each lean one).
//   node probes/mixedFrame/mixedFrame.mjs --scene mixed4 --size 512 [--runs 3] [--arms lean,union]
// Scenes: mixed4 (translucent CPatch ellipse, LB quadratic shape, raw-AAC cubic group, Slug line/quad), gradient, filter, override, target,
// large (tiger at 2048), morph (a large GPU morph beside two static bundles). Cache policy as probes/warmScene/warmScenePhases.mjs: the Metal cache is
// retained unless --clear-metal-cache; retained-cache link times are warm-sequence timings, not cold compiles, and the output says so.
import { readFileSync, existsSync } from 'fs';
import http from 'http';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const SCENE = flag('scene', 'mixed4'),
  SIZE = +flag('size', 512),
  RUNS = +flag('runs', 3),
  ARMS = flag('arms', 'lean,union').split(','),
  FRAMES = +flag('frames', 24);
const ASSETS = flag('assets', process.env.MANTLE_BENCH_ASSETS || '');
if (!ASSETS || !existsSync(ASSETS)) {
  console.log('SKIP: pass --assets or set MANTLE_BENCH_ASSETS to the benchmark asset directory');
  process.exit(0);
}
const svg = (body, vb = '0 0 100 100') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`;
const SC = {
  mixed4: [
    {
      name: 'cpatch-ellipse',
      pin: { route: 'cpatch', kernel: 'slug' },
      engine: 'cpatch',
      svg: svg(
        '<ellipse cx="50" cy="50" rx="40" ry="24" fill="#c33" fill-opacity="0.6" transform="rotate(20 50 50)"/>',
      ),
    },
    {
      name: 'lb-quad',
      pin: { route: 'lb', kernel: 'slug' },
      engine: 'lb',
      svg: svg('<path fill="#36c" d="M10 80 Q50 -10 90 80 Z"/>'),
    },
    {
      name: 'aac-cubic-group',
      pin: { route: 'none', kernel: 'aac' },
      engine: 'slug',
      opts: { alpha: 0.7 },
      svg: svg(
        '<g opacity="0.8"><path fill="#393" d="M10 90 C20 10 80 10 90 90 Z"/><path fill="#c90" d="M30 70 L50 30 L70 70 Z"/></g>',
      ),
    },
    {
      name: 'slug-line-quad',
      pin: { route: 'none', kernel: 'slug' },
      engine: 'slug',
      svg: svg('<path fill="#808" d="M15 15 L85 15 Q95 50 85 85 L15 85 Z"/>'),
    },
  ],
  gradient: [
    {
      name: 'lb-radial',
      pin: { route: 'lb', kernel: 'slug' },
      engine: 'lb',
      svg: svg(
        '<defs><radialGradient id="r"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#36c"/></radialGradient></defs><circle cx="50" cy="50" r="42" fill="url(#r)"/>',
      ),
    },
    {
      name: 'cpatch-linear',
      pin: { route: 'cpatch', kernel: 'slug' },
      engine: 'cpatch',
      svg: svg(
        '<defs><linearGradient id="l"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><path fill="url(#l)" d="M10 80 Q50 -10 90 80 Z"/>',
      ),
    },
    {
      name: 'slug-solid',
      pin: { route: 'none', kernel: 'slug' },
      engine: 'slug',
      svg: svg('<path fill="#0a6" d="M15 15 L85 15 L85 85 L15 85 Z"/>'),
    },
    {
      name: 'aac-linear',
      pin: { route: 'none', kernel: 'aac' },
      engine: 'slug',
      svg: svg(
        '<defs><linearGradient id="l2"><stop offset="0" stop-color="#fc0"/><stop offset="1" stop-color="#c0f"/></linearGradient></defs><path fill="url(#l2)" d="M10 90 C20 10 80 10 90 90 Z"/>',
      ),
    },
  ],
  filter: [
    {
      name: 'lb-blur',
      pin: { route: 'lb', kernel: 'slug' },
      engine: 'lb',
      svg: svg(
        '<defs><filter id="b"><feGaussianBlur stdDeviation="3"/></filter></defs><circle cx="50" cy="50" r="30" fill="#c33" filter="url(#b)"/>',
      ),
    },
    {
      name: 'cpatch-plain',
      pin: { route: 'cpatch', kernel: 'slug' },
      engine: 'cpatch',
      svg: svg('<path fill="#36c" d="M10 80 Q50 -10 90 80 Z"/>'),
    },
    {
      name: 'slug-plain',
      pin: { route: 'none', kernel: 'slug' },
      engine: 'slug',
      svg: svg('<path fill="#0a6" d="M15 15 L85 15 L85 85 L15 85 Z"/>'),
    },
    {
      name: 'aac-plain',
      pin: { route: 'none', kernel: 'aac' },
      engine: 'slug',
      svg: svg('<path fill="#c90" d="M10 90 C20 10 80 10 90 90 Z"/>'),
    },
  ],
  override: 'mixed4+override',
  target: 'mixed4+target',
  // MIXED_LARGE=file,file adds more large assets (paths under the assets directory); none by default.
  large: [
    { name: 'tiger', pin: { route: 'auto', kernel: 'auto' }, engine: 'lb', file: 'real/tiger.svg' },
    ...(process.env.MIXED_LARGE || '')
      .split(',')
      .filter(Boolean)
      .map((f) => ({
        name: path.basename(f, '.svg'),
        pin: { route: 'auto', kernel: 'auto' },
        engine: 'lb',
        file: f,
      })),
  ],
  morph: [
    {
      name: 'tiger-morph',
      pin: { route: 'auto', kernel: 'auto' },
      engine: 'lb',
      file: 'real/tiger.svg',
      morphTo: 'real/tiger.svg',
      t: 0.37,
    },
    {
      name: 'static-a',
      pin: { route: 'lb', kernel: 'slug' },
      engine: 'lb',
      svg: svg('<path fill="#36c" d="M10 80 Q50 -10 90 80 Z"/>'),
    },
    {
      name: 'static-b',
      pin: { route: 'cpatch', kernel: 'slug' },
      engine: 'cpatch',
      svg: svg('<ellipse cx="50" cy="50" rx="40" ry="24" fill="#c33" fill-opacity="0.6"/>'),
    },
  ],
};
let spec = SC[SCENE],
  mode = 'plain';
if (SCENE === 'large' && !process.env.MIXED_LARGE)
  console.log('SKIP the extra large assets: set MIXED_LARGE to add files beside the tiger');
if (typeof spec === 'string') {
  const [base, m] = spec.split('+');
  spec = SC[base];
  mode = m;
}
if (!spec) {
  console.error('unknown scene ' + SCENE);
  process.exit(2);
}
spec = spec.map((s) => ({
  ...s,
  svg: s.svg || readFileSync(path.join(ASSETS, s.file), 'utf8'),
  morphSvg: s.morphTo ? readFileSync(path.join(ASSETS, s.morphTo), 'utf8') : null,
}));
const mime = (p) =>
  p.endsWith('.html')
    ? 'text/html'
    : p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : 'text/plain';
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      '<!doctype html><html><body><canvas id="c" width="' +
        SIZE +
        '" height="' +
        SIZE +
        '"></canvas></body></html>',
    );
    return;
  }
  const f = path.join(ROOT, u);
  if (!f.startsWith(ROOT) || !existsSync(f)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': mime(f) });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
async function oneRun(arm) {
  const browser = await launchBrowser({
    protocolTimeout: 900000,
    headless: 'new',
    args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox', '--enable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    return await page.evaluate(
      async (arm, spec, mode, size, FRAMES) => {
        const now = () => performance.now(),
          M = await import('/src/index.js'),
          out = { arm, mode };
        const canvas = document.getElementById('c'),
          gl = canvas.getContext('webgl2', {
            antialias: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: true,
          });
        const cnt = { link: 0, create: 0, use: 0, draws: 0 };
        for (const [n, k] of [
          ['linkProgram', 'link'],
          ['createProgram', 'create'],
          ['useProgram', 'use'],
          ['drawArrays', 'draws'],
          ['drawElements', 'draws'],
          ['drawArraysInstanced', 'draws'],
        ]) {
          const f = gl[n].bind(gl);
          gl[n] = (...a) => {
            cnt[k]++;
            return f(...a);
          };
        }
        const fence = () =>
          new Promise((res) => {
            const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();
            const t0 = now();
            const tick = () => {
              const w = gl.clientWaitSync(s, 0, 0);
              if (
                w === gl.ALREADY_SIGNALED ||
                w === gl.CONDITION_SATISFIED ||
                now() - t0 > 120000
              ) {
                gl.deleteSync(s);
                res(now() - t0);
              } else setTimeout(tick, 1);
            };
            tick();
          });
        const shaders = await M.loadShaders(new URL('/src/shaders/', location.href).href);
        const R = M.createRenderer(gl, shaders, { loopBlinnFill: 'auto', cpatchFill: true });
        const bundles = [],
          draws = [];
        let t = now();
        for (const s of spec) {
          R.setFillEngine(s.pin);
          const scene = await M.importSvg(s.svg, { preserveViewport: true });
          let b = M.createBundle(gl, scene),
            h = b;
          if (s.morphSvg) {
            const b2 = M.createBundle(
              gl,
              await M.importSvg(s.morphSvg, { preserveViewport: true }),
            );
            h = M.createShapeMorph(gl, b, b2);
            h.setT(s.t || 0.37);
            b = h.bundle;
          }
          bundles.push(b);
          draws.push({ s, handle: h });
        }
        out.build = now() - t;
        let table = null;
        if (mode === 'override') {
          table = M.createOverrideTable(gl, bundles[0]);
          try {
            table.setTint
              ? table.setTint(0, [1, 0.5, 0.5, 1])
              : table.setVisible && table.setVisible(0, 1);
          } catch {}
        }
        let rt = null;
        if (mode === 'target') {
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          const fb = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          rt = fb;
        }
        R.setViewport && R.setViewport(0, 0, size, size);
        const frame = () => {
          if (rt) gl.bindFramebuffer(gl.FRAMEBUFFER, rt);
          R.beginFrame([1, 1, 1, 1]);
          for (let i = 0; i < draws.length; i++) {
            const d = draws[i];
            R.setFillEngine(d.s.pin);
            const o = { ...(d.s.opts || {}) };
            if (table && i === 0) o.overrides = table;
            R.drawBundle(d.handle, o);
          }
          R.endFrame();
          if (rt) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        };
        if (arm === 'union') R.setSceneUnion(bundles);
        // behind the loading screen: await each engine, then draw until a frame creates no program
        t = now();
        const p0 = cnt.create;
        for (const d of draws) {
          try {
            await R.awaitEngine(d.s.morphSvg ? d.handle.bundle : d.handle, d.s.engine, 60000);
          } catch {}
        }
        let passes = 0,
          last = -1;
        for (; passes < 10; passes++) {
          const c0 = cnt.create;
          frame();
          await fence();
          R.precompileFills && R.precompileFills({ draw: false });
          await fence();
          if (cnt.create === c0 && cnt.create === last) {
            passes++;
            break;
          }
          last = cnt.create;
        }
        out.warmWall = now() - t;
        out.programs = cnt.create - p0 + 0;
        out.links = cnt.link;
        out.warmPasses = passes;
        // steady frames
        const cpu = [],
          wall = [],
          use0 = cnt.use,
          dr0 = cnt.draws;
        for (let i = 0; i < FRAMES; i++) {
          const a = now();
          frame();
          const b = now();
          const f = await fence();
          cpu.push(b - a);
          wall.push(now() - a);
        }
        cpu.sort((a, b) => a - b);
        wall.sort((a, b) => a - b);
        out.cpuMedian = cpu[cpu.length >> 1];
        out.wallMedian = wall[wall.length >> 1];
        out.wallMin = wall[0];
        out.usePerFrame = (cnt.use - use0) / FRAMES;
        out.drawsPerFrame = (cnt.draws - dr0) / FRAMES;
        // final pixels
        if (rt) gl.bindFramebuffer(gl.FRAMEBUFFER, rt);
        const px = new Uint8Array(size * size * 4);
        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, px);
        if (rt) gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        let h = 2166136261 >>> 0;
        for (let i = 0; i < px.length; i += 7) h = Math.imul(h ^ px[i], 16777619) >>> 0;
        out.hash = h.toString(16);
        out.keys = (R.debugStats && R.debugStats.drawnFillVariantKey) || null;
        return out;
      },
      arm,
      spec,
      mode,
      SIZE,
      FRAMES,
    );
  } finally {
    await browser.close();
  }
}
const res = {};
for (let r = 0; r < RUNS; r++) {
  const order = ARMS.slice();
  if (r % 2) order.reverse();
  for (const a of order) {
    const o = await oneRun(a);
    (res[a] ||= []).push(o);
    console.log(
      `${SCENE} ${SIZE} ${a.padEnd(5)} programs ${o.programs} links ${o.links} warm ${o.warmWall.toFixed(0)} ms (${o.warmPasses} passes) | cpu ${o.cpuMedian.toFixed(3)} wall ${o.wallMedian.toFixed(2)} (min ${o.wallMin.toFixed(2)}) ms/frame, useProgram ${o.usePerFrame.toFixed(1)} draws ${o.drawsPerFrame.toFixed(1)}/frame | hash ${o.hash} | METAL CACHE RETAINED: warm-sequence link times`,
    );
  }
}
const med = (a, k) => {
  const v = a.map((x) => x[k]).sort((x, y) => x - y);
  return v[v.length >> 1];
};
if (res.lean && res.union)
  console.log(
    `SUMMARY ${SCENE}: wall union/lean ${(med(res.union, 'wallMedian') / med(res.lean, 'wallMedian')).toFixed(3)}x (best-of ${(Math.min(...res.union.map((x) => x.wallMin)) / Math.min(...res.lean.map((x) => x.wallMin))).toFixed(3)}x), programs ${med(res.lean, 'programs')} -> ${med(res.union, 'programs')}, warm wall ${med(res.lean, 'warmWall').toFixed(0)} -> ${med(res.union, 'warmWall').toFixed(0)} ms, hashes ${new Set([...res.lean, ...res.union].map((x) => x.hash)).size === 1 ? 'IDENTICAL' : 'DIFFER'}`,
  );
server.close();

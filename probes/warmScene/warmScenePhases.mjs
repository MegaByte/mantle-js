// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmScenePhases.mjs -- the loading-screen warm contract, phase by phase, in a FRESH browser per run.
//   node probes/warmScene/warmScenePhases.mjs --asset a.svg [--size 512] [--runs 3] [--engine auto|slug|lb|cpatch]
//                                   [--modes unprepared,warm] [--clear-metal-cache]
//
// Two protocols, each its own browser launch (so each run's first compile is its own), in alternating order per round:
//   unprepared: import, create the bundle, (await the engine), then the FIRST draw -- compile and pipeline build land in it;
//   warm:       the same, but behind a "loading screen" renderer.warmScene() draws the future state until a pass builds nothing,
//               and only then is the first visible draw timed.
// Per run the page reports import / bundle / ready / warmScene (with its report: passes, stable, programs created) / the first draw's
// fence wall / later draws' median fence wall. A fence wall is submit + driver + GPU + observation; it is not pure GPU time.
//
// CACHE POLICY. Without --clear-metal-cache the Metal shader cache is whatever the machine holds: those runs show the warm sequence,
// NOT cold compilation, and the output says so. --clear-metal-cache moves Chrome for Testing's com.apple.metal* files aside (a backup
// directory, never a delete) before every launch; it touches nothing of the user's ordinary browsers. Other apps and shared compiler
// services are retained, so it is an app-cache-cleared run, not a fresh boot.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'child_process';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const MORPH = flag('morph-to', null);
const ASSET = flag('asset'),
  SIZE = +flag('size', 512),
  RUNS = +flag('runs', 3),
  ENGINE = flag('engine', 'auto');
const MODES = flag('modes', 'unprepared,warm').split(',');
const CLEAR = argv.includes('--clear-metal-cache');
const OUTPUT = flag('json', null);
if (!['auto', 'slug', 'aac', 'points', 'lb', 'cpatch'].includes(ENGINE))
  throw new Error('unknown engine: ' + ENGINE);
const sourceHashes = (dir = path.join(ROOT, 'src')) =>
  Object.fromEntries(
    readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((e) => {
        const f = path.join(dir, e.name);
        return e.isDirectory()
          ? Object.entries(sourceHashes(f))
          : /\.(js|glsl)$/.test(e.name)
            ? [[path.relative(ROOT, f), createHash('sha256').update(readFileSync(f)).digest('hex')]]
            : [];
      }),
  );
const beforeHashes = sourceHashes();
const harnessHash = createHash('sha256')
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest('hex');
if (!ASSET) {
  console.error('--asset required');
  process.exit(2);
}
const svgText = readFileSync(ASSET, 'utf8'),
  svgB = MORPH ? readFileSync(MORPH, 'utf8') : null;
const mime = (p) =>
  p.endsWith('.html')
    ? 'text/html'
    : p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.svg')
        ? 'image/svg+xml'
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
// --clear-metal-cache: move only Chrome for Testing's own com.apple.metal* directories aside, to a backup directory on the same volume (a
// rename: nothing is copied or deleted), print the exact paths first, and put them back in a handler that also runs on failure or a signal.
const moved = []; // { from, to, original }: original = the machine's own directory (the first move of that path)
const CACHE_ROOT =
  process.env.MANTLE_WARM_SCENE_CACHE_ROOT ||
  (spawnSync('getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).stdout || '').trim(); // /var/folders/../C/
const BAK = path.join(CACHE_ROOT || os.tmpdir(), 'mantle-warm-scene-metal-backup-' + process.pid);
function clearMetal() {
  if (!CLEAR) return [];
  if (!CACHE_ROOT)
    throw new Error(
      "--clear-metal-cache: DARWIN_USER_CACHE_DIR is unknown, so Chrome for Testing's Metal cache cannot be located",
    );
  // only Chrome for Testing's own: com.google.chrome.for.testing and its .helper, and only their com.apple.metal* children
  const found = [];
  for (const app of ['com.google.chrome.for.testing', 'com.google.chrome.for.testing.helper']) {
    const base = path.join(CACHE_ROOT, app);
    if (!existsSync(base)) continue;
    for (const e of readdirSync(base, { withFileTypes: true }))
      if (e.isDirectory() && /^com\.apple\.metal/.test(e.name)) found.push(path.join(base, e.name));
  }
  console.log('Metal cache directories to move aside (Chrome for Testing only):');
  for (const f of found) console.log('  ' + f);
  if (!found.length && !moved.length) console.log('  (none: this run is NOT cold)');
  mkdirSync(BAK, { recursive: true });
  for (const f of found) {
    const to = path.join(
      BAK,
      'm' + moved.length + '-' + path.basename(path.dirname(f)) + '-' + path.basename(f),
    );
    const original = !moved.some((m) => m.from === f);
    renameSync(f, to);
    moved.push({ from: f, to, original });
  }
  if (found.length)
    console.log(
      `moved ${found.length} to ${BAK}; the machine's own are restored on exit (caches a run recreated stay in the backup directory, never deleted)`,
    );
  for (const f of found) if (existsSync(f)) throw new Error('cache move failed: ' + f);
  return found;
}
function restoreMetal() {
  // later moves are caches a run recreated: they stay in the backup directory. The first move of each path is the machine's own: put it back.
  const keep = moved.splice(0).filter((m) => m.original);
  for (const m of keep) {
    try {
      if (existsSync(m.from))
        renameSync(m.from, path.join(BAK, 'recreated-' + path.basename(m.to))); // use a unique name for each app and directory
      renameSync(m.to, m.from);
      console.log('restored ' + m.from);
    } catch (e) {
      console.error(
        'RESTORE FAILED for ' + m.from + ': ' + e.message + ' -- the files are in ' + m.to,
      );
    }
  }
}
process.on('exit', restoreMetal);
process.on('SIGINT', () => {
  restoreMetal();
  process.exit(130);
});
process.on('SIGTERM', () => {
  restoreMetal();
  process.exit(143);
});
// --morph-to B.svg: the scene is the morph ASSET -> B, and the future states are poses t = 0, .25, .5, .75, 1: new intervals can need more pipelines, so
// the warm contract covers all of them and the later poses report the programs they created (warm: 0 expected).
async function oneRun(mode) {
  const cleared = clearMetal();
  const browser = await launchBrowser({
    protocolTimeout: 600000,
    headless: 'new',
    args: [
      '--use-angle=metal',
      '--use-gl=angle',
      '--no-sandbox',
      '--enable-gpu',
      '--disable-gpu-shader-disk-cache',
      '--disable-metal-shader-cache',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const r = await page.evaluate(
      async (mode, svgText, svgB, size, engine) => {
        const now = () => performance.now(),
          out = { mode, phases: {} };
        const T = () => {
          const t = now();
          return () => now() - t;
        };
        const M = await import('/src/index.js');
        const canvas = document.getElementById('c'),
          gl = canvas.getContext('webgl2', {
            antialias: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: true,
          });
        if (!gl) throw new Error('WebGL2 unavailable');
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        out.device = dbg
          ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER);
        if (!/Apple|Metal/.test(out.device) || /SwiftShader|llvmpipe|software/i.test(out.device))
          throw new Error('physical Metal GPU required: ' + out.device);
        let phase = 'renderer';
        const cnt = { create: 0, compile: 0, link: 0 },
          calls = [];
        for (const [fn, counter] of [
          ['createProgram', 'create'],
          ['compileShader', 'compile'],
          ['linkProgram', 'link'],
          ['getShaderParameter', null],
          ['getProgramParameter', null],
        ]) {
          const original = gl[fn].bind(gl);
          gl[fn] = (...args) => {
            const t = now(),
              result = original(...args),
              ms = now() - t;
            if (counter) cnt[counter]++;
            calls.push({ call: fn, phase, ms });
            return result;
          };
        }
        const shaderText = new Map(),
          attached = new Map(),
          programs = new Map();
        let currentProgram = null;
        const record = (p) => {
          if (!programs.has(p))
            programs.set(p, { id: programs.size, firstUse: null, firstDraw: null });
          return programs.get(p);
        };
        for (const fn of [
          'shaderSource',
          'attachShader',
          'useProgram',
          'drawArrays',
          'drawElements',
          'drawArraysInstanced',
          'drawElementsInstanced',
        ]) {
          const original = gl[fn].bind(gl);
          gl[fn] = (...args) => {
            if (fn === 'shaderSource') shaderText.set(args[0], args[1]);
            if (fn === 'attachShader') {
              if (!attached.has(args[0])) attached.set(args[0], []);
              attached.get(args[0]).push(args[1]);
            }
            if (fn === 'useProgram') {
              currentProgram = args[0];
              if (currentProgram && !record(currentProgram).firstUse)
                record(currentProgram).firstUse = { phase, atMs: now() };
            }
            const first =
              fn.startsWith('draw') && currentProgram && !record(currentProgram).firstDraw;
            const t = now(),
              result = original(...args);
            if (first) record(currentProgram).firstDraw = { phase, cpuMs: now() - t, atMs: t };
            return result;
          };
        }
        const fence = () =>
          new Promise((res, reject) => {
            const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();
            const t0 = now();
            const tick = () => {
              const w = gl.clientWaitSync(s, 0, 0);
              if (w === gl.ALREADY_SIGNALED || w === gl.CONDITION_SATISFIED) {
                gl.deleteSync(s);
                res(now() - t0);
              } else if (w === gl.WAIT_FAILED || now() - t0 > 60000) {
                gl.deleteSync(s);
                reject(new Error('completion fence failed or timed out'));
              } else setTimeout(tick, 1);
            };
            tick();
          });
        let end = T();
        const shaders = await M.loadShaders(new URL('/src/shaders/', location.href).href);
        const R = M.createRenderer(gl, shaders, {
          aacPoints: engine === 'auto' || engine === 'points',
          psoWarmIdle: () => true,
        });
        out.phases.renderer = end();
        if (engine !== 'auto')
          R.setFillEngine({
            route: engine === 'lb' || engine === 'cpatch' ? engine : 'none',
            kernel: engine === 'aac' || engine === 'points' ? 'aac' : 'slug',
          });
        R.setViewport(size, size);
        phase = 'import';
        end = T();
        const scene = await M.importSvg(svgText, { preserveViewport: true });
        out.phases.import = end();
        phase = 'bundle';
        end = T();
        let bundle = M.createBundle(gl, scene),
          handle = null;
        if (svgB) {
          handle = M.createShapeMorph(
            gl,
            bundle,
            M.createBundle(gl, await M.importSvg(svgB, { preserveViewport: true })),
          );
          bundle = handle.bundle;
        }
        out.phases.bundle = end();
        phase = 'ready';
        end = T();
        R.prepareBundle(bundle);
        let ready = true;
        if (engine !== 'auto' && R.awaitEngine)
          ready = await R.awaitEngine(bundle, engine === 'points' ? 'aac' : engine, 60000);
        out.phases.ready = end();
        out.ready = !!ready;
        if (!ready) throw new Error('requested engine not ready: ' + engine);
        const drawAt = (t) => () => {
          if (handle) handle.setT(t);
          R.beginFrame([1, 1, 1, 1]);
          R.drawBundle(handle || bundle, {});
          R.endFrame();
        };
        const draw = drawAt(0),
          poses = handle ? [0, 0.25, 0.5, 0.75, 1] : [0];
        if (mode === 'warm') {
          phase = 'warmScene';
          end = T();
          out.report = await R.warmScene(
            poses.map((t) => ({ name: 't=' + t, draw: drawAt(t) })),
            { maxPasses: 8, fenceTimeoutMs: 60000 },
          );
          out.phases.warmScene = end();
          if (!out.report.complete)
            throw new Error('warming incomplete: ' + JSON.stringify(out.report));
          // the loading screen's pixels are not the first frame's: clear, as the app would
          R.beginFrame([1, 1, 1, 1]);
          R.endFrame();
          await fence();
        }
        const route = () => ({ ...(R.debugStats.engines?.viaRoute || {}) });
        const pixels = () => {
          const u = new Uint8Array(size * size * 4);
          gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, u);
          return u;
        };
        const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        const sample = async () => {
          const q = timer ? gl.createQuery() : null;
          if (q) gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
          const c0 = cnt.create,
            t = now();
          draw();
          const cpuSubmit = now() - t;
          if (q) gl.endQuery(timer.TIME_ELAPSED_EXT);
          const fenceWall = await fence(),
            wall = now() - t;
          let gpuMs = null;
          if (q) {
            const deadline = now() + 10000;
            while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
              if (now() > deadline) throw new Error('GPU timer timed out');
              await new Promise((r) => setTimeout(r, 1));
            }
            if (gl.getParameter(timer.GPU_DISJOINT_EXT)) throw new Error('disjoint GPU timer');
            gpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
            gl.deleteQuery(q);
          }
          return { cpuSubmit, fenceWall, wall, gpuMs, programsCreated: cnt.create - c0 };
        };
        phase = 'firstDraw';
        const routes0 = route();
        out.firstDraw = await sample();
        out.firstDraw.routes = Object.fromEntries(
          Object.entries(route())
            .map(([k, v]) => [k, v - (routes0[k] || 0)])
            .filter(([, v]) => v > 0),
        );
        const drawn = Object.keys(out.firstDraw.routes);
        if (
          engine !== 'auto' &&
          !drawn.some((k) =>
            engine === 'points'
              ? k === 'aac@points'
              : k.startsWith(engine + '@') && !k.endsWith('@points'),
          )
        )
          throw new Error(
            'requested route did not draw: ' + engine + ' ' + JSON.stringify(out.firstDraw.routes),
          );
        const firstPixels = pixels();
        out.inkPixels = 0;
        for (let i = 0; i < firstPixels.length; i += 4)
          if (firstPixels[i] < 250 || firstPixels[i + 1] < 250 || firstPixels[i + 2] < 250)
            out.inkPixels++;
        if (!out.inkPixels) throw new Error('blank rendered image');
        phase = 'laterPoses';
        out.laterPoseCreates = [];
        for (const t of poses.slice(1)) {
          const c0 = cnt.create;
          drawAt(t)();
          await fence();
          out.laterPoseCreates.push(cnt.create - c0);
        }
        phase = 'laterDraw';
        const later = [];
        for (let i = 0; i < 8; i++) later.push(await sample());
        out.later = later;
        out.laterMedian = later.map((x) => x.wall).sort((a, b) => a - b)[later.length >> 1];
        const lastPixels = pixels();
        out.samePoseMaxByte = 0;
        for (let i = 0; i < firstPixels.length; i++)
          out.samePoseMaxByte = Math.max(
            out.samePoseMaxByte,
            Math.abs(firstPixels[i] - lastPixels[i]),
          );
        if (out.samePoseMaxByte > 1)
          throw new Error('first/later image changed by ' + out.samePoseMaxByte + ' bytes');
        if (
          mode === 'warm' &&
          (out.firstDraw.programsCreated ||
            out.laterPoseCreates.some(Boolean) ||
            later.some((x) => x.programsCreated))
        )
          throw new Error('program created after completed warm');
        if (
          mode === 'warm' &&
          calls.some(
            (x) =>
              ['compileShader', 'linkProgram'].includes(x.call) &&
              ['firstDraw', 'laterPoses', 'laterDraw'].includes(x.phase),
          )
        )
          throw new Error('shader compiled or linked after completed warm');
        out.glError = gl.getError();
        if (out.glError || gl.isContextLost()) throw new Error('GL error or context loss');
        out.calls = calls;
        out.programs = [...programs.entries()].map(([p, r]) => {
          const sources = (attached.get(p) || []).map((s) => shaderText.get(s) || '');
          return {
            ...r,
            sourceBytes: sources.map((s) => s.length),
            defines: [
              ...new Set(
                sources.flatMap((s) =>
                  (s.match(/^#define [A-Z0-9_]+/gm) || []).map((d) => d.slice(8)),
                ),
              ),
            ],
          };
        });
        return out;
      },
      mode,
      svgText,
      svgB,
      SIZE,
      ENGINE,
    );
    r.cacheCleared = cleared.length;
    r.clearedDirectories = cleared;
    r.browser = await browser.version();
    r.launchArguments = browser.process()?.spawnargs;
    return r;
  } finally {
    await browser.close();
  }
}
process.on('uncaughtException', (e) => {
  console.error('PROBE ERROR: ' + ((e && e.stack) || e));
  restoreMetal();
  process.exit(1);
});
if (argv.includes('--clear-only')) {
  clearMetal();
  console.log('clear-only: restoring');
  server.close();
  process.exit(0);
} // a dry test of the move and the restore
const all = [];
for (let round = 0; round < RUNS; round++) {
  const order = MODES.slice();
  if (round % 2) order.reverse();
  for (const m of order) {
    const r = await oneRun(m);
    all.push(r);
    console.log(
      `${path.basename(ASSET)} ${SIZE} ${ENGINE} ${m.padEnd(10)} import ${r.phases.import.toFixed(0)} bundle ${r.phases.bundle.toFixed(0)} ready ${r.phases.ready.toFixed(0)}${r.phases.warmScene != null ? ` warmScene ${r.phases.warmScene.toFixed(0)} (${r.report.states.map((x) => x.name + ':' + x.passes + 'p' + (x.stable ? '' : '!')).join(' ')}, programs ${r.report.states.reduce((a, x) => a + x.programsCreated, 0)}, complete ${r.report.complete})` : ''} | later poses created programs [${r.laterPoseCreates.join(',')}] | first draw fence ${r.firstDraw.fenceWall.toFixed(0)} ms, later median ${r.laterMedian.toFixed(1)} ms${r.cacheCleared ? ` | metal cache moved aside: ${r.cacheCleared}` : ' | METAL CACHE RETAINED: warm-sequence timings, not cold compilation'}`,
    );
  }
}
server.close();
if (JSON.stringify(beforeHashes) !== JSON.stringify(sourceHashes()))
  throw new Error('production sources changed during measurement');
if (
  harnessHash !==
  createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex')
)
  throw new Error('measurement harness changed during measurement');
if (OUTPUT)
  writeFileSync(
    OUTPUT,
    JSON.stringify(
      {
        sourceHashes: beforeHashes,
        sourceStable: true,
        harnessHash,
        harnessStable: true,
        engine: ENGINE,
        asset: ASSET,
        size: SIZE,
        cachePolicy: CLEAR
          ? 'app cache directories moved aside before each fresh launch'
          : 'retained',
        runs: all,
      },
      null,
      2,
    ) + '\n',
  );

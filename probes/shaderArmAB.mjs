// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shaderArmAB — time shader-text variants against the shipped shaders, in ONE page.
//
//   node probes/shaderArmAB.mjs arms.json [--svg a.svg,b.svg] [--size 1024] [--draws 10] [--reps 16]
//                              [--route none|lb|cpatch] [--kernel slug] [--opts '{"aacFill":false}'] [--move]
//
// --move alternates a sub-pixel translation of the world matrix draw by draw, so every filter result
// MISSES its cache and the filter passes run in every timed frame (a static scene would serve them
// from the cache after the first frame and time only the composite). The pixel diff is read at the
// unmoved position.
//
// arms.json: [{ "name": "hoist", "replace": [["exact text in a shader source", "replacement"], ...],
//               "sources": ["fillFrag"] }, ...]   (sources optional: default every source string)
//   or        [{ "name": "x", "file": { "fillFrag": "src/shaders/generated/mantle.frag.glsl" } }]
// Every arm is a whole renderer compiled from edited shader text; the base arm is the shipped text.
// Source keys are loadShaders()'s (src/shaders/index.js): mantle.frag is `fillFrag`. A file arm replaces the
// assembled string, so give it a generated/ file; time this tree's own generated file as an arm to validate.
// Each arm is checked to have CHANGED something (a replacement that matched nothing is an error,
// not a silent A/A).
//   An arm may instead (or also) carry `"import": { ... }`, options merged into importSvg for that
// arm's bundle only -- e.g. [{ "name": "fan", "import": { "coverFan": true } }] times the cover fan
// against the box on the shipped shader. Such an arm changes the DATA, so its pixel diff is part of
// the answer, not a warning.
//
// The traps this carries:
//   * a DISCARD renderer PER SHADER SOURCE is compiled, drawn and disposed before the timed one: on
//     ANGLE/Metal the first renderer compiled from a given source text is slow for life (and can draw
//     different pixels) -- with a discard for the base source only, every other arm is a first compile
//     and reads 1.4-2.7x slow (and an A/A of base with no discard reads 0.61x);
//   * samples are sized to ~150 ms (--target, capped by --maxdraws) and the fence is polled through a
//     MessageChannel (setTimeout(0) clamps to ~5 ms and quantized small-asset samples); --route cpatch
//     waits for the CPatch conversion (awaitLbReady never resolves for it);
//   * an A/A arm (a second base renderer) prices the floor; nothing below it is a result;
//   * fence-synced timing of DRAWS back-to-back draws, ABBA-rotated over REPS rounds, medians;
//   * the engine draw tally per arm, and a pixel diff of every arm against base, so an arm that
//     quietly drew another engine or changed the picture cannot pass as a speed-up;
//   * THE GPU THROTTLE (test/_gpuThrottle.mjs): every timed sample is followed by an idle of at least
//     its own length (MANTLE_GPU_DUTY, default 0.5) plus a rest, outside the timed region, and the run
//     is capped at MANTLE_GPU_WALL_MS (default 300 s). Run it in the FOREGROUND, one GPU job at a time.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from '../test/_gpuThrottle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const ARMS = JSON.parse(readFileSync(argv[0], 'utf8'));
for (const a of ARMS)
  if (a.file)
    for (const k of Object.keys(a.file)) a.file[k] = readFileSync(path.resolve(a.file[k]), 'utf8');
const SVGS = (
  flag('svg', '') ? flag('svg').split(',') : [path.join(ROOT, 'examples/tiger.svg')]
).map((f) => ({ name: path.basename(f), text: readFileSync(f, 'utf8') }));
const N = +flag('size', 1024),
  DRAWS = +flag('draws', 10),
  REPS = +flag('reps', 16);
const ROUTE = flag('route', 'none'),
  KERNEL = flag('kernel', 'slug'),
  OPTS = JSON.parse(flag('opts', '{}'));
const MOVE = argv.includes('--move');

const HTML = `<!DOCTYPE html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const base = await loadShaders(new URL('/src/shaders/', location.href).href);
const ARMS = ${JSON.stringify(ARMS)};
function variant(arm) {
  const out = Object.assign({}, base); let changed = arm.import ? 1 : 0;
  if (arm.file) for (const k of Object.keys(arm.file)) {
    if (typeof base[k] !== 'string') throw new Error('arm ' + arm.name + ': no shader source is keyed ' + k);
    out[k] = arm.file[k]; changed++;
  }
  for (const [from, to] of (arm.replace || [])) {
    let hit = 0;
    for (const k of Object.keys(out)) {
      if (typeof out[k] !== 'string' || (arm.sources && !arm.sources.includes(k))) continue;
      if (out[k].includes(from)) { out[k] = out[k].split(from).join(to); hit++; }
    }
    if (!hit) throw new Error('arm ' + arm.name + ': replacement matched no shader source: ' + from.slice(0, 80));
    changed += hit;
  }
  if (!changed) throw new Error('arm ' + arm.name + ' changes nothing');
  return out;
}
const _mc = new MessageChannel(); let _res = null; _mc.port1.onmessage = () => { const r = _res; _res = null; if (r) r(); };
const yieldNow = () => new Promise((r) => { _res = r; _mc.port2.postMessage(0); });
window.__run = async (svgText) => {
  window.__D = ${DRAWS};
  async function side(sh, importOpts) {
    const c = document.createElement('canvas'); c.width = c.height = ${N}; document.body.appendChild(c);
    const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
    const R = createRenderer(gl, sh, ${JSON.stringify(OPTS)}); if (R.ready) await R.ready; R.setViewport(${N}, ${N});
    if (R.setFillEngine) R.setFillEngine({ route: '${ROUTE}', kernel: '${KERNEL}' });
    const b = createBundle(gl, await importSvg(svgText, importOpts || {}));
    if (R.prepareBundle) R.prepareBundle(b); try { if ('${ROUTE}' === 'cpatch' && R.awaitEngine) await R.awaitEngine(b, 'cpatch', 30000); else if ('${ROUTE}' === 'lb' && R.awaitLbReady) await R.awaitLbReady(b, 30000); } catch {}
    let alt = 0;
    const draw = (still) => { R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b, ${MOVE} && !still && (alt++ & 1) ? { worldMatrix: [1, 0, 0, 0, 1, 0, 0.25 / ${N}, 0, 1] } : {}); R.endFrame(); };
    const tally = () => Object.assign({}, (R.debugStats.engines || {}).draws || {});
    const time = async () => { const t0 = performance.now(); for (let i = 0; i < window.__D; i++) draw();
      const f = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
      while (gl.clientWaitSync(f, 0, 0) === gl.TIMEOUT_EXPIRED) await yieldNow();
      gl.deleteSync(f); const ms = performance.now() - t0;
      // THE THROTTLE (test/_gpuThrottle.mjs): idle after every sample, outside the timed region. A sample is ~--target ms
      // (default 150), under MANTLE_GPU_BURST_MS, so it needs no splitting.
      await window.__gpuIdle(ms); return ms; };
    const read = () => { const p = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
    for (let i = 0; i < 8; i++) { draw(); if (R.precompileFills) { try { R.precompileFills(); } catch {} } }
    await time();
    const dispose = () => { try { b.dispose && b.dispose(); } catch {} try { R.dispose && R.dispose(); } catch {}
      try { const x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); } catch {} c.remove(); };
    return { draw, time, read, tally, dispose };
  }
  // A DISCARD RENDERER PER SHADER SOURCE: the first renderer compiled from a given source text is slow for
  // life on ANGLE/Metal (and can draw different pixels); the shipped harness discarded only base's.
  (await side(base)).dispose();
  const arms = [{ name: 'base', s: await side(base) }, { name: 'A/A', s: await side(base) }];
  for (const a of ARMS) { const sh = variant(a); (await side(sh, a.import)).dispose(); arms.push({ name: a.name, s: await side(sh, a.import) }); }
  const t0 = {}; for (const a of arms) { const b0 = a.s.tally(); a.s.draw(true); const b1 = a.s.tally(); const d = {}; for (const k in b1) { const n = (b1[k] | 0) - (b0[k] | 0); if (n) d[k] = n; } t0[a.name] = d; }
  const ref = arms[0].s.read(); const px = {};
  for (const a of arms) { const p = a.s.read(); let n = 0, mx = 0; for (let i = 0; i < p.length; i++) { const d = Math.abs(p[i] - ref[i]); if (d) n++; if (d > mx) mx = d; } px[a.name] = { n, mx }; }
  { let t = 0; for (let k = 0; k < 3; k++) t = await arms[0].s.time(); window.__D = Math.max(${DRAWS}, Math.min(${+flag('maxdraws', 400)}, Math.round(${DRAWS} * ${+flag('target', 150)} / Math.max(t, 0.1)))); }
  const times = {}; for (const a of arms) times[a.name] = [];
  for (let r = 0; r < ${REPS}; r++) { const order = (r & 1) ? arms.slice().reverse() : arms; for (const a of order) times[a.name].push(await a.s.time()); }
  const med = (v) => { const s = v.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  for (const a of arms) a.s.dispose();
  return arms.map((a) => ({ name: a.name, ms: med(times[a.name]) / window.__D, D: window.__D, spread: (() => { const v = times[a.name].slice().sort((p, q) => p - q); return (v[v.length - 1 - (v.length >> 2)] - v[v.length >> 2]) / med(v); })(), tally: t0[a.name], px: px[a.name] }));
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  protocolTimeout: 1200000,
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox', '--enable-gpu'],
});
const cap = capWallTime('shaderArmAB', async () => {
  await browser.close();
  server.close();
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
await installGpuThrottle(page);
console.log(gpuThrottleBanner());
for (const s of SVGS) {
  const rows = await page.evaluate((t) => window.__run(t), s.text);
  const b = rows[0].ms;
  console.log(
    `\n${s.name} @${N} px, route ${ROUTE}, ${rows[0].D} draws x ${REPS} reps (median ms PER DRAW; iqr = interquartile spread / median):`,
  );
  for (const r of rows)
    console.log(
      `  ${r.name.padEnd(16)} ${r.ms.toFixed(4).padStart(8)} ms  ${(r.ms / b).toFixed(3)}x  iqr ${(r.spread * 100).toFixed(1)}%  px vs base: ${r.px.n} ch (max ${r.px.mx})  drew ${JSON.stringify(r.tally)}`,
    );
  const aa = rows[1].ms / b;
  console.log(`  A/A floor ${(Math.abs(aa - 1) * 100).toFixed(1)}% -- an arm inside it is a tie`);
}
{
  const d = await page.evaluate(() => window.__gpuDuty());
  console.log(
    `\ngpu duty over the timed samples: ${(d.busy / Math.max(1, d.busy + d.idle)).toFixed(2)} (busy ${(d.busy / 1000).toFixed(1)} s, idle ${(d.idle / 1000).toFixed(1)} s)`,
  );
}
cap.clear();
await browser.close();
server.close();

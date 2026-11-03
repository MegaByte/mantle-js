// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupOverBlitAB — time a normal group's src-over blit against the copy-and-composite
// path, in ONE page.
//
//   node probes/filtperf/groupOverBlitAB.mjs [--svg probes/filtperf/opacityGroups.svg] [--size 1024]
//        [--draws 10] [--reps 16] [--route none|lb]
//
// The blit is a JS/state choice, not shader text, so probes/shaderArmAB.mjs cannot express it. The two
// paths differ only in what groupBegin/groupEnd do, and __MANTLE_GROUP_COPY_COMPOSITE (debug) puts
// every group on the copy-and-composite path, read per group at groupBegin -- so each arm is a renderer of its
// own whose draws run with the flag set (copy) or clear (blit). The traps are shaderArmAB's: a
// DISCARD renderer first (a page's first renderer stays slow for life), an A/A arm pricing the floor,
// fence-synced timing of DRAWS back-to-back frames, ABBA over REPS rounds, medians, the engine tally
// per arm, and a pixel diff of every arm against base (the copy path may differ by 1 LSB, no more).
// The group count per frame is printed so an arm that drew no groups cannot pass as a tie.
//
// THROTTLED (test/_gpuThrottle.mjs): every sample is followed by an idle of at least its own length
// (MANTLE_GPU_DUTY, default 0.5) plus a rest, outside the timed region, and the run is capped at
// MANTLE_GPU_WALL_MS. The fence is polled with a MessageChannel yield (window.__gpuFence), not setTimeout(0), which
// clamps to 4 ms once nested behind the idle's timer. Run it in the FOREGROUND, one GPU job at a time.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from '../../test/_gpuThrottle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const SVGS = (
  flag('svg', '') ? flag('svg').split(',') : [path.join(ROOT, 'probes/filtperf/opacityGroups.svg')]
).map((f) => ({ name: path.basename(f), text: readFileSync(f, 'utf8') }));
const N = +flag('size', 1024),
  DRAWS = +flag('draws', 10),
  REPS = +flag('reps', 16);
const ROUTE = flag('route', 'none');

const HTML = `<!DOCTYPE html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const withCopy = (on, fn) => {
  if (on) { globalThis.__MANTLE_DEBUG__ = true; globalThis.__MANTLE_GROUP_COPY_COMPOSITE = true; }
  try { return fn(); } finally { delete globalThis.__MANTLE_DEBUG__; delete globalThis.__MANTLE_GROUP_COPY_COMPOSITE; }
};
window.__run = async (svgText) => {
  async function side(copy) {
    const c = document.createElement('canvas'); c.width = c.height = ${N}; document.body.appendChild(c);
    const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
    const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready; R.setViewport(${N}, ${N});
    if (R.setFillEngine) R.setFillEngine({ route: '${ROUTE}', kernel: 'slug' });
    const b = createBundle(gl, await importSvg(svgText));
    if (R.prepareBundle) R.prepareBundle(b); if (R.awaitLbReady) { try { await R.awaitLbReady(b, 30000); } catch {} }
    const groups = b.drawList.filter((o) => o.kind === 'groupBegin').length;
    const draw = () => withCopy(copy, () => { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); });
    const tally = () => Object.assign({}, (R.debugStats.engines || {}).draws || {});
    const time = async () => { const t0 = performance.now(); for (let i = 0; i < ${DRAWS}; i++) draw();
      await window.__gpuFence(gl);                // a MessageChannel poll: after the idle's timer setTimeout(0) clamps to 4 ms
      const ms = performance.now() - t0;
      await window.__gpuIdle(ms);                 // THE THROTTLE: after the clock stopped (test/_gpuThrottle.mjs)
      return ms; };
    const read = () => { const p = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
    for (let i = 0; i < 8; i++) { draw(); if (R.precompileFills) { try { R.precompileFills(); } catch {} } }
    await time();
    return { draw, time, read, tally, groups, stats: () => R.debugStats };
  }
  await side(false);                                          // discard: the first renderer stays slow
  const arms = [{ name: 'blit', s: await side(false) }, { name: 'A/A', s: await side(false) },
                { name: 'copy+composite', s: await side(true) }];
  const t0 = {}; for (const a of arms) { const b0 = a.s.tally(); a.s.draw(); const b1 = a.s.tally(); const d = {}; for (const k in b1) { const n = (b1[k] | 0) - (b0[k] | 0); if (n) d[k] = n; } t0[a.name] = d; }
  const ref = arms[0].s.read(); const px = {};
  for (const a of arms) { const p = a.s.read(); let n = 0, mx = 0; for (let i = 0; i < p.length; i++) { const d = Math.abs(p[i] - ref[i]); if (d) n++; if (d > mx) mx = d; } px[a.name] = { n, mx }; }
  const times = {}; for (const a of arms) times[a.name] = [];
  for (let r = 0; r < ${REPS}; r++) { const order = (r & 1) ? arms.slice().reverse() : arms; for (const a of order) times[a.name].push(await a.s.time()); }
  const med = (v) => { const s = v.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
  return arms.map((a) => ({ name: a.name, ms: med(times[a.name]), tally: t0[a.name], px: px[a.name], groups: a.s.groups,
                            gate: a.s.stats().unifiedFillGate }));
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
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox', '--enable-gpu'],
});
const cap = capWallTime('groupOverBlitAB', async () => {
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
    `\n${s.name} @${N} px, route ${ROUTE}, ${rows[0].groups} groups, ${DRAWS} draws x ${REPS} reps (median ms per ${DRAWS} draws):`,
  );
  for (const r of rows)
    console.log(
      `  ${r.name.padEnd(16)} ${r.ms.toFixed(2).padStart(8)} ms  ${(r.ms / b).toFixed(3)}x  px vs base: ${r.px.n} ch (max ${r.px.mx})  gate ${r.gate}  drew ${JSON.stringify(r.tally)}`,
    );
  const aa = rows[1].ms / b;
  console.log(`  A/A floor ${(Math.abs(aa - 1) * 100).toFixed(1)}% -- an arm inside it is a tie`);
}
cap.clear();
await browser.close();
server.close();

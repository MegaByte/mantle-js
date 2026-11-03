// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// passAB — time a filter/paint shader rewrite as ONE fullscreen pass, before against after, in one page.
//
//   node probes/filtperf/passAB.mjs [--items convolveKernel] [--match 'order 5'] [--size 1024] [--draws 20] [--reps 16]
//
// For a rewrite that changes the uniforms (work moved to the CPU, a texture replaced by a uniform array),
// probes/shaderArmAB.mjs cannot run a case's 'old' text: the renderer only feeds the 'new' interface. This runs
// each test/_filtperfCases.mjs case's two texts directly (test/_passRunner.mjs), each with its own
// inputs, into a --size x --size RGBA8 target (the case's textures stretched over it -- the per-pixel
// work is the case's). The traps are shaderArmAB's: a DISCARD pass first, an A/A arm (a second 'new'),
// fence-synced timing of DRAWS back-to-back passes, ABBA over REPS rounds, medians. It prices the pass
// alone: what the renderer does around it (binds, uniforms, the other passes of a graph) is not in it,
// so a ratio here is an upper bound on what a frame gains.
//
// THROTTLED (test/_gpuThrottle.mjs): every sample (~150 ms of passes) is followed by an idle of at least its own
// length (MANTLE_GPU_DUTY, default 0.5) plus a rest, outside the timed region, and the run is capped at
// MANTLE_GPU_WALL_MS. Run it in the FOREGROUND, one GPU job at a time.
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
const ITEMS = flag('items', '') ? flag('items').split(',') : null;
const MATCH = flag('match', '');
const N = +flag('size', 1024),
  DRAWS = +flag('draws', 20),
  REPS = +flag('reps', 16);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="4" height="4"></canvas><script type="module">
import { filtperfCases } from '/test/_filtperfCases.mjs';
import { makePassRunner } from '/test/_passRunner.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false });
const runner = makePassRunner(gl, async (p) => { const r = await fetch('/' + p); if (!r.ok) throw new Error('fetch ' + p); return r.text(); });
// A MessageChannel yield, not setTimeout(0): the timer's clamp quantized short samples to nothing. Each sample
// sizes its pass count to ~150 ms of GPU work, and the result is per pass.
const _mc = new MessageChannel(); let _res = null; _mc.port1.onmessage = () => { const r = _res; _res = null; if (r) r(); };
const yieldNow = () => new Promise((r) => { _res = r; _mc.port2.postMessage(0); });
window.__D = ${DRAWS};
const time = async (s) => {
  s.bind();
  const t0 = performance.now();
  for (let i = 0; i < window.__D; i++) s.draw();
  const f = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
  while (gl.clientWaitSync(f, 0, 0) === gl.TIMEOUT_EXPIRED) await yieldNow();
  gl.deleteSync(f);
  const ms = performance.now() - t0;
  await window.__gpuIdle(ms);                     // THE THROTTLE: after the clock stopped (test/_gpuThrottle.mjs)
  return ms;
};
window.__run = async (items, match) => {
  const rows = [];
  for (const c of filtperfCases(items).filter((c) => !match || c.name.includes(match))) {
    const size = [${N}, ${N}];
    const discard = await runner.prepare(c, 'new', { size });
    for (let i = 0; i < 4; i++) await time(discard);
    discard.dispose();
    // ...AND A DISCARD OF 'old': the first compile of a source text is slow for life on ANGLE/Metal, and
    // without this the harness would compile 'old' exactly once, in its timed arm.
    { const d2 = await runner.prepare(c, 'old', { size }); for (let i = 0; i < 4; i++) await time(d2); d2.dispose(); }
    window.__D = ${DRAWS};
    const arms = [{ name: 'new', s: await runner.prepare(c, 'new', { size }) }, { name: 'A/A', s: await runner.prepare(c, 'new', { size }) },
                  { name: 'old', s: await runner.prepare(c, 'old', { size }) }];
    for (const a of arms) { await time(a.s); await time(a.s); }
    { const t = await time(arms[0].s); window.__D = Math.max(${DRAWS}, Math.min(2000, Math.round(${DRAWS} * 150 / Math.max(t, 0.1)))); }
    const times = {}; for (const a of arms) times[a.name] = [];
    for (let r = 0; r < ${REPS}; r++) { const order = (r & 1) ? arms.slice().reverse() : arms; for (const a of order) times[a.name].push(await time(a.s)); }
    const med = (v) => { const s = v.slice().sort((p, q) => p - q); return s[s.length >> 1]; };
    rows.push({ item: c.item, name: c.name, D: window.__D, ms: Object.fromEntries(arms.map((a) => [a.name, med(times[a.name]) / window.__D])) });
    for (const a of arms) a.s.dispose();
  }
  return rows;
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
const cap = capWallTime('passAB', async () => {
  await browser.close();
  server.close();
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
await installGpuThrottle(page);
console.log(gpuThrottleBanner());
const rows = await page.evaluate((i, m) => window.__run(i, m), ITEMS, MATCH);
console.log(
  `\none pass at ${N}x${N}, ~150 ms of passes per sample x ${REPS} reps (median ms PER PASS; D = passes per sample):`,
);
for (const r of rows) {
  const n = r.ms.new;
  console.log(
    `  ${(r.item + ' ' + r.name).padEnd(56)} D ${r.D} new ${n.toFixed(4).padStart(7)}  old ${r.ms.old.toFixed(4).padStart(7)} ` +
      `(${(r.ms.old / n).toFixed(3)}x)  A/A ${(Math.abs(r.ms['A/A'] / n - 1) * 100).toFixed(1)}%`,
  );
}
console.log('  An old/new ratio inside its A/A percentage is a tie.');
const duty = await page.evaluate(() => window.__gpuDuty());
console.log(
  `gpu duty over the timed samples: ${(duty.busy / (duty.busy + duty.idle)).toFixed(2)} (busy ${(duty.busy / 1000).toFixed(1)} s, idle ${(duty.idle / 1000).toFixed(1)} s)`,
);
cap.clear();
await browser.close();
server.close();

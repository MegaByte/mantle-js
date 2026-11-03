// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// variantFirstWarmCost -- the HOT-cache cost of variantFirst: within one run, fresh renderers alternate ABBA between the default (lean program from
// frame 1) and the opt-out (`variantFirst: false`, base program first), each loading the same ten-asset scene and drawing it for a few seconds.
// A/A control: the same alternation between two opt-out arms. Per rep: the first frame's wall time (draw + 1-pixel readback, the glwait of a
// first load), the summed frame time over the first 120 frames, and the time until the renderer has nothing left to warm.
// A TIMING run: run it alone on the machine (no other GPU or heavy CPU work): node probes/variantFirstWarmCost.mjs [rounds]
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = process.env.MANTLE_SMOKE_SRC_ROOT
  ? path.resolve(process.env.MANTLE_SMOKE_SRC_ROOT)
  : ROOT;
const ROUNDS = +(process.argv[2] || 6);
const ASSETS = [
  'tiger',
  '_blur',
  '_dash_circle',
  '_pattern',
  '_stroke_caps_joins',
  '_clipper_anim',
  '_dropshadow',
  '_pattern_gradient',
  '_concave_cubic',
  '_arcs_circle',
].map((n) => readFileSync(path.join(ROOT, 'examples', n + '.svg'), 'utf8'));
const N = 512;
const HTML = `<!DOCTYPE html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sleep = (ms) => new Promise((f) => setTimeout(f, ms));
const secs = [];
for (const s of ${JSON.stringify(ASSETS)}) secs.push(await importSvg(s, { preserveViewport: false }));
window.__rep = async (vf, frames) => {
  const cv = document.createElement('canvas'); cv.width = ${N}; cv.height = ${N};
  const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const t0 = performance.now();
  const r = createRenderer(gl, shaders, vf === 'off' ? { variantFirst: false } : {});
  r.setViewport(${N}, ${N});
  const bs = secs.map((s) => createBundle(gl, s));
  for (const b of bs) r.prepareBundle(b);
  const per = [];
  let first = 0, sum = 0, settledAt = -1;
  for (let f = 0; f < frames; f++) {
    const s = performance.now();
    r.beginFrame([1, 1, 1, 1]);
    bs.forEach((b, i) => { const k = 0.28, x = ((i % 4) - 1.5) * 0.45, y = (Math.floor(i / 4) - 1) * 0.5; r.drawBundle(b, { worldMatrix: new Float32Array([k, 0, 0, 0, k, 0, x, y, 1]) }); });
    r.endFrame(); sync();
    const d = performance.now() - s;
    if (f === 0) first = d; if (f < 120) sum += d; per.push(d);
    if (settledAt < 0 && f > 4 && (r.debugStats.psoWarmPending | 0) === 0 && (r.debugStats.variantCompiles | 0) > 0 && f > 20) settledAt = performance.now() - t0;
    await sleep(8);
  }
  const total = performance.now() - t0;
  const long = per.filter((d) => d > 50).reduce((a, d) => a + d, 0);
  r.dispose && r.dispose(); const l = gl.getExtension('WEBGL_lose_context'); if (l) l.loseContext();
  return { first, sum120: sum, longMs: long, settledAt, total, compiles: r.debugStats ? 0 : 0 };
};
window.__ready = true;
</script></body></html>`;
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(p.startsWith('/src/') ? SRC_ROOT : ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  protocolTimeout: 900000,
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const pg = await br.newPage();
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 300000, polling: 100 });
const rep = (vf) => pg.evaluate((v) => window.__rep(v, 150), vf);
// warm the driver cache for both arms' programs (the hot-cache condition), discarding these reps
await rep('on');
await rep('off');
const res = { on: [], off: [], off2: [] };
const stat = (a, k) => {
  const v = a.map((x) => x[k]).sort((p, q) => p - q);
  return { med: v[Math.floor(v.length / 2)], min: v[0], max: v[v.length - 1] };
};
for (let i = 0; i < ROUNDS; i++) {
  // ABBA for the effect; the same shape (A2 B2 B2 A2) of two opt-out arms is the A/A control
  const eff = i % 2 === 0 ? ['on', 'off', 'off', 'on'] : ['off', 'on', 'on', 'off'];
  for (const a of eff) res[a].push(await rep(a));
  const ctl = ['off', 'off', 'off', 'off'];
  for (const a of ctl) res.off2.push(await rep(a));
}
await br.close();
server.close();
for (const k of ['first', 'sum120', 'longMs', 'settledAt']) {
  const o = stat(res.on, k),
    f = stat(res.off, k),
    f2 = stat(res.off2, k);
  console.log(
    `${k.padEnd(10)} default med ${o.med.toFixed(1)} [${o.min.toFixed(1)}..${o.max.toFixed(1)}]  opt-out med ${f.med.toFixed(1)} [${f.min.toFixed(1)}..${f.max.toFixed(1)}]  A/A opt-out#2 med ${f2.med.toFixed(1)}  default-opt-out ${(o.med - f.med).toFixed(1)} ms  A/A noise ${(f2.med - f.med).toFixed(1)} ms`,
  );
}

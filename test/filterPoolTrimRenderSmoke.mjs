// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterPoolTrimRenderSmoke -- the renderer's idle trim of its filter scratch (opts.filterPoolIdleMs), on real GL.
//
// Three properties: (1) two filtered scenes drawn ALTERNATELY, frame after frame past the idle window, never lose a target (live GL bytes
// never fall); (2) a renderer that then draws nothing filtered for the window releases its scratch GRADUALLY (live bytes drop, and
// never more than one target per frame); (3) the next filtered frames redraw exactly the pixels they drew before the trim.
// (4) A cached result that kept a zoom's texture moves to a texture of its own size once it has stored nothing for the window, on both
// entry kinds (a graph's and a single-kind blur's): live bytes fall, no filter runs, and the frame is the same pixels through the copy.
// The window is 400 ms here (the default is 10 s) so the smoke is quick; the targets are region-sized, smaller than the 256 px
// viewport, because a viewport-sized target is deliberately never trimmed.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// (the backing rect makes the content bbox the whole canvas: drawBundle fits the content, so without it the small circle would be scaled up to fill the canvas)
// noise + displacement + blur + composite: a chain the single-kind fast paths cannot express, so it takes the filter-graph route (the RT pool), on a region far smaller than the canvas
const svg = (r, sd, fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><defs><filter id="f" x="-60%" y="-60%" width="220%" height="220%"><feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="${sd}" result="d"/><feGaussianBlur in="d" stdDeviation="2" result="b"/><feComposite in="b" in2="SourceGraphic" operator="over"/></filter></defs><rect width="256" height="256" fill="#eee"/><circle cx="128" cy="128" r="${r}" fill="${fill}" filter="url(#f)"/></svg>`;
const A = svg(14, 3, '#c33'),
  B = svg(26, 6, '#36c'),
  PLAIN =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><rect x="8" y="8" width="40" height="40" fill="#383"/></svg>';
const BLUR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><defs><filter id="f" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3"/></filter></defs><rect width="256" height="256" fill="#fff"/><path d="M100 104 L156 108 L128 160 Z" fill="#c33" filter="url(#f)"/></svg>';
const IDLE = 400;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas><script type="module">
const P = WebGL2RenderingContext.prototype; const live = new Map(); let bound = null, delFrame = 0, rbBound = null;
const wrap = (n, f) => { const o = P[n]; P[n] = function (...a) { const r = o.apply(this, a); f(a, r); return r; }; };
wrap('bindTexture', (a) => { bound = a[1]; });
wrap('bindRenderbuffer', (a) => { rbBound = a[1]; });
wrap('texImage2D', (a) => { if (bound && typeof a[3] === 'number' && a[2] === 0x8058) live.set(bound, a[3] * a[4] * 4); });
wrap('renderbufferStorage', (a) => { if (rbBound) live.set(rbBound, a[2] * a[3] * 4); });
for (const n of ['deleteTexture', 'deleteRenderbuffer']) wrap(n, (a) => { if (live.delete(a[0])) delFrame++; });
const bytes = () => { let s = 0; for (const v of live.values()) s += v; return s; };
const { importSvg, createBundle, createRenderer, loadShaders } = await import('/src/index.js');
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const r = createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href), { filterPoolIdleMs: ${IDLE} });
r.setViewport(256, 256);
const mk = async (s) => createBundle(gl, await importSvg(s));
const a = await mk(${JSON.stringify(A)}), b = await mk(${JSON.stringify(B)}), plain = await mk(${JSON.stringify(PLAIN)});
const wait = (ms) => new Promise((x) => setTimeout(x, ms)); const px = new Uint8Array(256 * 256 * 4);
const hash = () => { gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, px); let h = 0x811c9dc5 >>> 0; for (let i = 0; i < px.length; i++) { h ^= px[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
const frame = async (bundle) => { r.beginFrame([1, 1, 1, 1]); r.drawBundle(bundle, {}); r.endFrame(); await wait(16); };
const out = {};
for (let i = 0; i < 12; i++) { await frame(a); await frame(b); }
await frame(a); out.hashA = hash(); await frame(b); out.hashB = hash();
out.bytesWarm = bytes(); out.diagWarm = r.debugStats.scratchTrim;
// (1) alternate for 3x the window
let minBytes = Infinity; const t0 = performance.now();
while (performance.now() - t0 < ${IDLE} * 3) { await frame(a); minBytes = Math.min(minBytes, bytes()); await frame(b); minBytes = Math.min(minBytes, bytes()); }
out.minDuringAlternation = minBytes;
// (2) idle: only a plain bundle, 4x the window
let maxDelPerFrame = 0, maxFreedPerFrame = 0, ticks0 = r.debugStats.scratchTrim.calls; const t1 = performance.now();
while (performance.now() - t1 < ${IDLE} * 5) { delFrame = 0; const f0 = r.debugStats.scratchTrim.freedTargets; await frame(plain); maxDelPerFrame = Math.max(maxDelPerFrame, delFrame); maxFreedPerFrame = Math.max(maxFreedPerFrame, r.debugStats.scratchTrim.freedTargets - f0); }
out.idleTicks = r.debugStats.scratchTrim.calls - ticks0; out.maxFreedPerFrame = maxFreedPerFrame;
out.bytesIdle = bytes(); out.maxDelPerFrame = maxDelPerFrame; out.diagIdle = r.debugStats.scratchTrim;
// (3) the filtered scenes come back identical
await frame(a); out.hashA2 = hash(); await frame(b); out.hashB2 = hash();
// (4) back from a zoom, static, past the window
out.shrink = [];
const blur = await mk(${JSON.stringify(BLUR)});
for (const [name, bundle] of [['graph', a], ['single-kind blur', blur]]) {
  const at = async (k) => { r.beginFrame([1, 1, 1, 1]); r.drawBundle(bundle, { worldMatrix: new Float32Array([k, 0, 0, 0, k, 0, 0, 0, 1]) }); r.endFrame(); await wait(16); };
  await at(1); await at(1);
  await at(3); await at(3);
  await at(1); await at(1);
  const before = bytes(), pixels = hash(), evals = r.debugStats.filterEvalCount | 0, shrunk0 = r.debugStats.scratchTrim.shrunkResults;
  const t2 = performance.now();
  while (performance.now() - t2 < ${IDLE} * 8 && r.debugStats.scratchTrim.shrunkResults === shrunk0) await at(1);
  await at(1);
  out.shrink.push({ name, before, after: bytes(), same: hash() === pixels, evals: (r.debugStats.filterEvalCount | 0) - evals, shrunk: r.debugStats.scratchTrim.shrunkResults - shrunk0 });
}
window.__out = out; window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
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
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 60000,
});
await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
const o = await page.evaluate(() => window.__out);
await browser.close();
server.close();
console.log(JSON.stringify(o));
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
ok(o.bytesWarm > 0, `the scenes allocated filter scratch (${o.bytesWarm} bytes live)`);
ok(
  o.diagWarm.pool.targets > 0 && o.diagWarm.pool.free > o.diagWarm.pool.viewportClass,
  `the scenes left pool targets that are NOT the viewport's size class (pool ${JSON.stringify(o.diagWarm.pool)})`,
);
ok(
  o.minDuringAlternation >= o.bytesWarm,
  `alternating scenes never lose a target (min live ${o.minDuringAlternation} >= ${o.bytesWarm})`,
);
ok(o.diagWarm.freedTargets === 0, 'and the trim freed nothing while they alternated');
ok(
  o.idleTicks > 0,
  `the trim ticks on idle frames, not only on filtered draws (${o.idleTicks} ticks)`,
);
ok(
  o.diagIdle.freedTargets >= 1 && o.bytesIdle < o.bytesWarm,
  `an idle renderer releases scratch (${o.bytesWarm} -> ${o.bytesIdle} live bytes; ${o.diagIdle.freedTargets} targets, ${o.diagIdle.freedBytes} bytes freed)`,
);
ok(
  o.maxFreedPerFrame === 1 && o.maxDelPerFrame >= 1,
  `release is gradual: some frame freed a target and none freed more than one (max freed per frame ${o.maxFreedPerFrame}, GL deletions per frame ${o.maxDelPerFrame})`,
);
ok(
  o.hashA === o.hashA2 && o.hashB === o.hashB2,
  'the filtered scenes redraw the same pixels after the trim',
);
for (const c of o.shrink) {
  ok(
    c.shrunk >= 1 && c.after < c.before,
    `${c.name}: a result that kept a zoom's texture gives it back after the window (${c.shrunk} moved, ${c.before} -> ${c.after} live bytes)`,
  );
  ok(c.evals === 0, `${c.name}: no filter ran for it (${c.evals})`);
  ok(c.same, `${c.name}: and the frame is the same pixels through the copy`);
}
if (fail) console.log('DIAG', JSON.stringify({ warm: o.diagWarm, idle: o.diagIdle }));
process.exit(fail ? 1 : 0);

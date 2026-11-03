// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pointsGenAB -- what do the generated points (aacPointsGen, MANTLE_POINTS_GEN) cost against the uploaded point lists?
//
//   node probes/pointsGenAB.mjs --assets a.svg,b.svg,...|@list.txt [--sizes 48,96,192] [--reps 12] [--target 120] [--opts '{"aacFill":"auto"}']
//
// One tree, three sides in ONE page, ABBA-rotated: gen (aacPointsGen true), list (false), and list again on a second context (the A/A floor:
// nothing inside it is a result). Every side owns its canvas and context. Each mode's programs are compiled FRESH by a discarded side first,
// because the first renderer compiled from a shader source is slow for life on ANGLE/Metal. A sample is D draws of the asset then a fence:
//   cpu   JS time of the D draws          wall   until the fence          gpu   EXT_disjoint_timer_query_webgl2 TIME_ELAPSED, when exposed
// Per cell it prints the share of the side's draws that went through the points route (a cell no side draws by points is not about this
// change) and the pixel difference from the list side.
//
// THE GPU THROTTLE (test/_gpuThrottle.mjs) applies: run it alone, one GPU job at a time.
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
const SIZES = flag('sizes', '48,96,192').split(',').map(Number),
  REPS = +flag('reps', 12),
  TARGET = +flag('target', 120);
const OPTS = JSON.parse(flag('opts', '{"aacFill":"auto"}'));
const assetArg = flag('assets', 'examples/tiger.svg'); // (a list, or @file: one path per line -- a long argv can fail at exec)
const ASSETS = (
  assetArg.startsWith('@')
    ? readFileSync(assetArg.slice(1), 'utf8')
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
    : assetArg.split(',')
).map((f) => ({
  name: path.basename(f, '.svg'),
  text: readFileSync(path.resolve(ROOT, f), 'utf8'),
}));

const HTML = `<!DOCTYPE html><html><body style="margin:0"><script type="module">
const M = await import('/src/index.js');
const shaders = await M.loadShaders(new URL('/src/shaders/', location.href).href);
const OPTS = ${JSON.stringify(OPTS)};
async function side(gen, svg, N) {
  const c = document.createElement('canvas'); c.width = N; c.height = N; document.body.appendChild(c);
  const gl = c.getContext('webgl2', { premultipliedAlpha: true, antialias: false, stencil: true, depth: true, preserveDrawingBuffer: true });
  const R = M.createRenderer(gl, shaders, { ...OPTS, aacPointsGen: gen });
  if (R.ready) await R.ready;
  const b = M.createBundle(gl, await M.importSvg(svg, { preserveViewport: true }));
  R.setViewport(N, N); R.prewarmBundle(b); if (R.precompileFills) R.precompileFills();
  const draw = () => { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); };
  for (let i = 0; i < 12; i++) draw();
  await window.__gpuFence(gl);
  const routes = () => { const v = R.debugStats.engines.viaRoute || {}; let pts = 0, all = 0; for (const [k, n] of Object.entries(v)) { all += n; if (/@points$/.test(k)) pts += n; } return { pts, all }; };
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let D = 4;
  const time = async () => {
    const q = timer ? gl.createQuery() : null;
    if (q) gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
    const t0 = performance.now();
    for (let i = 0; i < D; i++) draw();
    const t1 = performance.now();
    if (q) gl.endQuery(timer.TIME_ELAPSED_EXT);
    await window.__gpuFence(gl);
    const t2 = performance.now();
    let g = NaN;
    if (q) { for (let s = 0; s < 50; s++) { if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { g = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; break; } await window.__gpuYield(); }
      gl.deleteQuery(q); if (gl.getParameter(timer.GPU_DISJOINT_EXT)) g = NaN; }
    await window.__gpuIdle(t2 - t0);
    return { cpu: t1 - t0, wall: t2 - t0, gpu: g };
  };
  const read = () => { draw(); const p = new Uint8Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
  const dispose = () => { try { b.dispose(); R.dispose(); } catch {} try { gl.getExtension('WEBGL_lose_context').loseContext(); } catch {} c.remove(); };
  return { time, read, routes, setD: (d) => { D = d; }, dispose };
}
window.__run = async (svg, N, reps, target) => {
  for (const gen of [true, false]) { const d = await side(gen, svg, N); for (let k = 0; k < 3; k++) await d.time(); d.dispose(); }   // fresh compile per mode
  const arms = [{ name: 'gen', s: await side(true, svg, N) }, { name: 'list', s: await side(false, svg, N) }, { name: 'listAA', s: await side(false, svg, N) }];
  let worst = 0;
  for (const a of arms) { a.s.setD(2); await a.s.time(); const t = await a.s.time(); worst = Math.max(worst, t.wall / 2); }
  const D = Math.max(1, Math.min(400, Math.round(target / Math.max(worst, 0.01))));
  for (const a of arms) a.s.setD(D);
  const t = arms.map(() => []);
  for (let r = 0; r < reps; r++) {
    const order = (r & 1) ? [2, 1, 0] : [0, 1, 2];
    for (const i of order) t[i].push(await arms[i].s.time());
  }
  const ref = arms[1].s.read();
  const med = (v) => { const s = v.filter((x) => x === x).sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };
  const out = arms.map((a, i) => {
    const p = a.s.read(); let n = 0, mx = 0; for (let k = 0; k < p.length; k++) { const d = Math.abs(p[k] - ref[k]); if (d) n++; if (d > mx) mx = d; }
    const w = t[i].map((x) => x.wall).sort((p, q) => p - q);
    return { name: a.name, cpu: med(t[i].map((x) => x.cpu)) / D, wall: med(w) / D, gpu: med(t[i].map((x) => x.gpu)) / D, wallMin: w[0] / D,
      iqr: (w[Math.floor(w.length * 3 / 4)] - w[Math.floor(w.length / 4)]) / med(w), px: { n, mx }, routes: a.s.routes() };
  });
  for (const a of arms) a.s.dispose();
  return { D, out };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const f = path.resolve(ROOT, '.' + u);
    if (!f.startsWith(ROOT + path.sep)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'content-type': f.endsWith('.glsl')
        ? 'text/plain'
        : f.endsWith('.json')
          ? 'application/json'
          : 'text/javascript',
    });
    res.end(readFileSync(f));
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
const cap = capWallTime('pointsGenAB', async () => {
  await browser.close();
  server.close();
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 300));
});
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
await installGpuThrottle(page);
console.log(gpuThrottleBanner());
console.log(
  `opts ${JSON.stringify(OPTS)}; ${REPS} reps ABBA, target ${TARGET} ms/sample; ratio = gen / list, floor = |listAA / list - 1|`,
);
const f2 = (x) => (x === x ? x.toFixed(3) : '  -  ');
for (const a of ASSETS)
  for (const N of SIZES) {
    const r = await page.evaluate(
      (svg, N, reps, target) => window.__run(svg, N, reps, target),
      a.text,
      N,
      REPS,
      TARGET,
    );
    const [g, l, aa] = r.out,
      share = (x) => (x.routes.all ? ((100 * x.routes.pts) / x.routes.all).toFixed(0) + '%' : '-');
    const ratio = (k) => g[k] / l[k],
      floor = (k) => Math.abs(aa[k] / l[k] - 1);
    console.log(
      `${a.name.padEnd(22)} ${String(N).padStart(4)}px D=${String(r.D).padStart(3)} points ${share(g)}/${share(l)}  ` +
        `wall ${f2(g.wall)}/${f2(l.wall)} ms ${ratio('wall').toFixed(3)}x (floor ${floor('wall').toFixed(3)})  ` +
        `cpu ${ratio('cpu').toFixed(3)}x (floor ${floor('cpu').toFixed(3)})  gpu ${g.gpu === g.gpu ? ratio('gpu').toFixed(3) + 'x' : '-'}  ` +
        `iqr ${g.iqr.toFixed(2)}/${l.iqr.toFixed(2)}/${aa.iqr.toFixed(2)}  px gen ${g.px.n}/${g.px.mx} AA ${aa.px.n}/${aa.px.mx}`,
    );
  }
cap.clear();
await browser.close();
server.close();

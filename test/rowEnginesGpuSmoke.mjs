// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// rowEnginesGpuSmoke -- the engine of every ROW is reported (debugStats.rowEngines) and is a function of (bundle, size, options), not of time or page history.
//
//   (a) a default draw of dens-like content reports route 'points' with every row on points, and a hash;
//   (b) a Loop-Blinn draw (large cubic blobs, size term met) reports lb rows, ready:true, and the same hash and pixels on a second renderer
//       and after a draw at a small scale a moment earlier (a time-based pick throttle would serve the small-scale answer, so the same
//       rows could be meshes on one page and cover quads on another, with identical route-ledger counts);
//   (c) a pin changes the report (rows on cover), so the assertion can tell the engines apart;
//   (d) the FIRST frame, drawn before the meshes are built, is reported ready:false with pending rows (those rows draw their cover quad, the
//       documented fallback); after awaitLbReady the frame is ready:true. The first-frame vs steady pixel difference is printed.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 128,
  M = 1024;
function dens() {
  let out = '';
  for (let j = 0; j < 72; j++)
    for (let i = 0; i < 70; i++) {
      const x = i + 0.05,
        y = j + 0.05;
      out += `<path fill="#${((i * 37 + j * 91) % 4096).toString(16).padStart(3, '0')}" d="M${x} ${y + 0.45}c0 -0.35 0.2 -0.45 0.45 -0.45s0.45 0.1 0.45 0.45s-0.2 0.45 -0.45 0.45s-0.45 -0.1 -0.45 -0.45z"/>`;
    }
  return out;
}
function blobs() {
  // 12 large cubic blobs, each ~200 px at 512: the bundle's bbox area is over the size term, every row can take a mesh
  let out = '';
  for (let k = 0; k < 12; k++) {
    const x = (k % 4) * 128 + 6,
      y = Math.floor(k / 4) * 128 + 6,
      c = ['#c33', '#36c', '#3a5', '#a3a'][k % 4];
    out += `<path fill="${c}" d="M${x + 10} ${y + 60}C${x + 10} ${y + 5} ${x + 110} ${y + 5} ${x + 110} ${y + 60}C${x + 110} ${y + 115} ${x + 10} ${y + 115} ${x + 10} ${y + 60}Z"/>`;
  }
  return out;
}
const SVG_D = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 70 72">${dens()}</svg>`;
const SVG_B = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 384">${blobs()}</svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${M}" height="${M}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const secD = await importSvg(${JSON.stringify(SVG_D)}, { preserveViewport: true });
const secB = await importSvg(${JSON.stringify(SVG_B)}, { preserveViewport: true });
const read = (px) => { const a = new Uint8Array(px * px * 4); gl.readPixels(0, 0, px, px, gl.RGBA, gl.UNSIGNED_BYTE, a); return a; };
const slim = (re) => re && { route: re.route, rows: re.rows, counts: re.counts, hash: re.hash, ready: re.build && re.build.ready, pending: re.build && re.build.pending, built: re.build && re.build.built };
const sum = (a) => { let h = 0; for (let i = 0; i < a.length; i++) h = (Math.imul(h, 31) + a[i]) >>> 0; return h; };
// which: 'D' dens, 'B' blobs. steps: list of { px, wait } draws on ONE renderer/bundle; returns the last step's report and pixels.
window.__run = async (which, opts, pin, steps) => {
  const r = createRenderer(gl, shaders, which === 'B' ? { staticUnified: true, ...opts } : opts);   // the blob case is about the unified stream's row report: opt the static bundle into it (fillRouteClass.js)
  if (pin) r.setFillEngine(pin);
  const b = createBundle(gl, which === 'D' ? secD : secB); r.prewarmBundle(b); r.precompileFills();   // the loading call: the point program is finished there, not at the first draw
  const out = [];
  for (const st of steps) {
    if (st.wait) await r.awaitLbReady(b, 20000);
    r.setViewport(st.px, st.px); gl.viewport(0, 0, st.px, st.px);
    r.beginFrame([0, 0, 0, 0]); r.drawBundle(b); r.endFrame();
    const px = read(st.px);
    out.push({ px: st.px, report: slim(r.debugStats.rowEngines), pixHash: sum(px), ink: px.reduce((n, v, i) => n + ((i & 3) === 3 && v > 8 ? 1 : 0), 0), pix: st.keep ? Array.from(px) : null });
  }
  b.dispose && b.dispose(); r.dispose && r.dispose();
  return out;
};
window.__ready = true;
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
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.error('  [console]', m.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const run = (w, o, p, s) => page.evaluate((a, b, c, d) => window.__run(a, b, c, d), w, o, p, s);
const last = (o) => o[o.length - 1];

// (a) dens-like content: points, every row
{
  const o = last(await run('D', {}, null, [{ px: 128 }]));
  const re = o.report;
  if (re && re.route === 'points' && re.counts.points === re.rows)
    ok(
      `dens-like content: route points, ${re.counts.points} of ${re.rows} rows on points (hash ${re.hash})`,
    );
  else fail(`dens-like report: ${JSON.stringify(re)}`);
}
// (b) Loop-Blinn rows: deterministic across renderers and across scale history
const LB = { lbMinExtentPx: 0 };
const steadyA = last(await run('B', LB, null, [{ px: M, wait: true, keep: true }]));
const steadyB = last(await run('B', LB, null, [{ px: M, wait: true, keep: true }]));
const history = last(
  await run('B', LB, null, [
    { px: 32, wait: true },
    { px: M, keep: true },
  ]),
);
const lb = steadyA.report;
if (lb && lb.counts.lb === 12 && lb.ready === true)
  ok(`default draw of 12 large blobs: 12 rows on lb meshes, ready (hash ${lb.hash})`);
else fail(`blob report: ${JSON.stringify(lb)}`);
if (steadyB.report && steadyB.report.hash === lb.hash && steadyB.pixHash === steadyA.pixHash)
  ok('a second renderer gives the same hash and the same pixels');
else fail(`second renderer differs: ${JSON.stringify(steadyB.report)} vs ${JSON.stringify(lb)}`);
if (history.report && history.report.hash === lb.hash && history.pixHash === steadyA.pixHash)
  ok(
    'a draw at 32 px a moment earlier changes nothing: same hash, same pixels (a time-based pick throttle would serve the 32 px answer)',
  );
else
  fail(
    `after a small-scale draw: ${JSON.stringify(history.report)} (pixels ${history.pixHash} vs ${steadyA.pixHash}) vs ${JSON.stringify(lb)}`,
  );
// (c) a pin changes the report
{
  const pin = last(await run('B', LB, { route: 'none', kernel: 'slug' }, [{ px: M, wait: false }]));
  if (
    pin.report &&
    pin.report.route === 'cover' &&
    pin.report.counts.lb === 0 &&
    pin.report.counts.cover === 12
  )
    ok(
      `a pin to cover reports the 12 rows on cover (${JSON.stringify(pin.report && pin.report.counts)})`,
    );
  else fail(`a pin still reports lb rows: ${JSON.stringify(pin.report)}`);
}
// (d) first frame before the meshes exist vs steady state
{
  const first = await run('B', LB, null, [
    { px: M, keep: true },
    { px: M, wait: true, keep: true },
  ]);
  const f0 = first[0],
    f1 = first[1];
  if (f1.report && f1.report.ready === true && f1.report.hash === lb.hash)
    ok('after awaitLbReady the frame is ready and equals the steady state');
  else fail(`steady frame: ${JSON.stringify(f1.report)}`);
  let n = 0;
  if (f0.pix && f1.pix)
    for (let i = 0; i < f0.pix.length; i++) if (Math.abs(f0.pix[i] - f1.pix[i]) > 0) n++;
  console.log(
    `  first frame: report ${JSON.stringify(f0.report)}; first-vs-steady pixel channels differing: ${n} (ready:false rows draw their cover quad until the mesh lands)`,
  );
  if (!f0.report || f0.report.ready !== false || !(f0.report.pending > 0))
    fail('the first frame is not reported not-ready with pending rows');
}

await browser.close();
server.close();
if (failures) {
  console.error(`rowEnginesGpuSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  'rowEnginesGpuSmoke: per-row engines are reported and are a function of (bundle, size, options)',
);

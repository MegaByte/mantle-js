// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _workerVsMain — does the off-thread LB build produce the same meshes as the main-thread one?
//
//   GPU=1 node probes/lbContain/_workerVsMain.mjs [asset.svg ...]
//
// Found by _lb17Render: with no hook flags at all, tiger's worker build packed 105,024 vertices and
// the main-thread build 105,048, and a hook flag the worker demonstrably RECEIVED (captured on
// postMessage) did not change its meshes while the main thread honored it. Output that depends on
// which thread built it is a defect whatever the cause. This names the shapes that differ.
//
// Two page loads: `?noworker` hides Worker before any module loads, so lbWorkerPool takes its
// synchronous main-thread path with the identical input.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { launchBrowser } = await import(ROOT + '/test/_launch.mjs');
const FILES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      path.resolve(ROOT, '..', 'MantleSamples', 'Assets', 'Mantle', 'tiger.svg'),
      path.join(ROOT, 'examples', 'smoke', 'lbMemBudget__SVG.svg'),
    ];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="256" height="256"></canvas>
<script>if (location.search.includes('noworker')) window.Worker = undefined;</script>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__build = async (svg) => {
  R.setFillEngine({ route: 'lb', kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b); } catch {} }
  const snap = () => (b._lbMeshes || []).map((m) => !m ? 'null' : m.slug ? 'slug' : m.prim ? 'prim' : String(m.vertexCount | 0));
  const atReady = snap(), pendingAtReady = b._lbWorkerPendingGen !== undefined;
  // Does awaitLbReady resolve before the off-thread result lands? Wait, draw, and look again.
  for (let i = 0; i < 50 && b._lbWorkerPendingGen !== undefined; i++) await new Promise((r) => setTimeout(r, 100));
  R.setViewport(256, 256); R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
  const settled = snap();
  b.dispose && b.dispose();
  return { atReady, settled, pendingAtReady };
};
window.__ready = true;
</script></body></html>`;

const srv = http.createServer((q, res) => {
  try {
    const u = q.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'],
});
const port = srv.address().port;
async function buildAll(query) {
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 220)));
  await pg.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: 'load', timeout: 60000 });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
  const out = [];
  for (const f of FILES)
    out.push(await pg.evaluate((s) => window.__build(s), readFileSync(f, 'utf8')));
  await pg.close();
  return out;
}
const W = await buildAll(''),
  M = await buildAll('?noworker');
let bad = 0;
FILES.forEach((f, i) => {
  const moved = (a, b) => a.reduce((n, v, s) => n + (v !== b[s] ? 1 : 0), 0);
  console.log(
    `${path.basename(f)}: worker build pending when awaitLbReady resolved: ${W[i].pendingAtReady}; shapes that changed after it settled: ${moved(W[i].atReady, W[i].settled)}`,
  );
  const w = W[i].settled,
    m = M[i].settled,
    diff = [];
  for (let s = 0; s < Math.max(w.length, m.length); s++)
    if (w[s] !== m[s]) diff.push(`#${s} worker ${w[s]} main ${m[s]}`);
  const sum = (a) => a.reduce((t, v) => t + (+v || 0), 0);
  console.log(
    `${path.basename(f)}: ${w.length} shapes, verts worker ${sum(w)} main ${sum(m)}, ${diff.length} shape(s) differ`,
  );
  for (const d of diff.slice(0, 20)) console.log('   ' + d);
  if (diff.length) bad++;
});
await br.close();
srv.close();
process.exit(bad ? 1 : 0);

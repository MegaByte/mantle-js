// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Memory-projected Slug gate: a bundle whose projected LB mesh footprint
// exceeds the budget routes Slug (reference-exact) instead of building;
// accounting tracks real bytes and releases on dispose.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Deterministic synthetic complex art (no third-party assets): a few hundred
// closed cubic blobs — enough curve volume that the projected LB mesh
// footprint exceeds a tiny budget and a real build accounts several MB.
const SVG = (() => {
  let seed = 0x2f6e2b1 | 0;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) & 0x7fffffff) / 2147483647;
  let body = '';
  for (let i = 0; i < 400; i++) {
    const cx = 40 + rnd() * 820,
      cy = 40 + rnd() * 820,
      r = 8 + rnd() * 30;
    const k = 6,
      pts = [];
    for (let j = 0; j < k; j++) {
      const a = (j / k) * Math.PI * 2,
        rr = r * (0.6 + rnd() * 0.8);
      pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    let d = 'M' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (let j = 0; j < k; j++) {
      const p0 = pts[j],
        p1 = pts[(j + 1) % k];
      const mx = (p0[0] + p1[0]) / 2 + (rnd() - 0.5) * r,
        my = (p0[1] + p1[1]) / 2 + (rnd() - 0.5) * r;
      d +=
        'C' +
        (p0[0] + (mx - p0[0]) * 0.5).toFixed(1) +
        ' ' +
        (p0[1] + (my - p0[1]) * 0.5).toFixed(1) +
        ' ' +
        (mx + (p1[0] - mx) * 0.5).toFixed(1) +
        ' ' +
        (my + (p1[1] - my) * 0.5).toFixed(1) +
        ' ' +
        p1[0].toFixed(1) +
        ' ' +
        p1[1].toFixed(1);
    }
    const col = '#' + ((1 << 24) | Math.floor(rnd() * 0xffffff)).toString(16).slice(1);
    body += '<path d="' + d + 'Z" fill="' + col + '"/>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 900">' + body + '</svg>';
})();
let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  console.error('FAIL', m);
  failures++;
};
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, depth:true, stencil:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(256, 256);
const until = async (pred, ms) => { const t0 = performance.now(); while (!pred() && performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return pred(); };
// Asks for LB EXPLICITLY. This smoke is about the LB machinery, not about
// whether 'auto' would choose it, and keeping the two apart means a future
// routing change cannot silently make it vacuous.
renderer.setLoopBlinnFill('on');
const doc = await importSvg(SRC_SVG);
const out = {};
// 1) tiny budget → denied → Slug, still renders
renderer.setLoopBlinnMemoryBudget(1024);
const b1 = createBundle(gl, doc);
// The LB build decision is made off-thread: _lbMeshes leaves undefined (to null when the memory gate denies it, or to the
// meshes) once it has landed. Wait for that, not for a fixed delay.
await until(() => b1._lbMeshes !== undefined && b1._lbWorkerPendingGen === undefined, ${pageTimeoutFor(120000)});
out.denied = !!b1._lbMemDenied;
out.meshesNull = b1._lbMeshes === null;
renderer.beginFrame([1,1,1,1]); renderer.drawBundle(b1); renderer.endFrame();
const px = new Uint8Array(256*256*4); gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,px);
let ink = 0; for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i+1] < 250 || px[i+2] < 250) ink++;
out.ink = ink;
// 2) normal budget → builds + accounts; dispose releases
renderer.setLoopBlinnMemoryBudget(512 * 1024 * 1024);
const b2 = createBundle(gl, doc);
// Accounting is a question about the WHOLE mesh set, so wait for full quality. A non-null _lbMeshes no
// longer answers it: shapes adopt their meshes as they finish, so the first publish carries only the
// batch that landed, and measuring there reads a build still filling in (0.89 MB of it, here).
await renderer.awaitLbReady(b2, 20000);
out.built = !!(b2._lbMeshes && b2._lbMeshes.length);
out.used = renderer.getLoopBlinnMemoryUse();
b2.dispose();
out.usedAfterDispose = renderer.getLoopBlinnMemoryUse();
window.__r = out; window.__done = true;
</script></body></html>`;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML.replace('SRC_SVG', JSON.stringify(SVG)));
    return;
  }
  const mm = u.pathname.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try {
    const body = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, { 'content-type': mm });
    res.end(body);
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
// HEADLESS EVEN ON THE GPU. Headless reaches the real GPU -- ANGLE (Apple, ANGLE Metal Renderer)
// reports and TIMES the same either way. A window is not free to the person running this: macOS
// CLAMPS --window-position, so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error('  [page-err]', e.message));
await pg.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load', timeout: 20000 });
await pg
  .waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 })
  .catch(() => {});
const r = await pg.evaluate(() => window.__r);
await br.close();
srv.close();
if (!r) {
  fail('did not complete');
} else {
  if (r.denied && r.meshesNull) ok('over-budget bundle denied → Slug route latched');
  else fail('gate did not deny (denied=' + r.denied + ' null=' + r.meshesNull + ')');
  if (r.ink > 5000) ok('denied bundle still renders via Slug (' + r.ink + 'px ink)');
  else fail('denied bundle rendered nothing (' + r.ink + 'px)');
  if (r.built && r.used > 1024 * 1024)
    ok('normal budget builds + accounts (' + (r.used / 1048576).toFixed(1) + 'MB)');
  else fail('build/accounting broken (built=' + r.built + ' used=' + r.used + ')');
  if (r.usedAfterDispose < r.used / 10)
    ok(
      'dispose releases the accounting (' + (r.usedAfterDispose / 1048576).toFixed(1) + 'MB after)',
    );
  else fail('dispose leaked (' + r.usedAfterDispose + ')');
}
console.log(
  failures
    ? '\\n' + failures + ' failure(s)'
    : '\\nlbMemBudgetSmoke: projected-memory Slug gate works',
);
process.exit(failures ? 1 : 0);

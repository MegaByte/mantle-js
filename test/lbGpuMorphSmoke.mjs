// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// PARTITION-PAIR morph parity: the morph route runs the STATIC LB code (builder,
// packer, fragment shader) with a dual-stream VS that mixes the two endpoint
// packs by uMorphT — so a morph frame at t=0/1 must match the STATIC LB render
// of that endpoint (the one-code-path promise), and mid-t must track the Slug
// morph (the exact reference) within AA tolerance.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const SRC = readFileSync(new URL('../examples/smoke/lbGpuMorph__SRC.svg', import.meta.url), 'utf8');
const DST = readFileSync(new URL('../examples/smoke/lbGpuMorph__DST.svg', import.meta.url), 'utf8');

const W = 320,
  H = 320;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, depth:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(${W}, ${H});
const read = () => { const b = new Uint8Array(${W}*${H}*4); gl.readPixels(0,0,${W},${H},gl.RGBA,gl.UNSIGNED_BYTE,b); return b; };
const clear = () => { gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT); };
window.__run = async (srcSvg, dstSvg) => {
  const bS = createBundle(gl, await importSvg(srcSvg)), bD = createBundle(gl, await importSvg(dstSvg));
  const mSlug = createShapeMorph(gl, createBundle(gl, await importSvg(srcSvg)), createBundle(gl, await importSvg(dstSvg)));
  const mLb   = createShapeMorph(gl, createBundle(gl, await importSvg(srcSvg)), createBundle(gl, await importSvg(dstSvg)));
  const drawMorph = (mode, morph, t) => {
    morph.setT(t); renderer.setLoopBlinnFill(mode);
    clear(); const m0 = renderer.debugStats.loopBlinnMorphRouteCount;
    renderer.drawBundle(morph);
    return { buf: read(), routed: renderer.debugStats.loopBlinnMorphRouteCount - m0 };
  };
  const drawStatic = (bundle) => {
    renderer.setLoopBlinnFill('auto'); clear(); renderer.drawBundle(bundle); return read();
  };
  const diff = (A, B) => { let n3 = 0, mx = 0;
    for (let i = 0; i < A.length; i += 4) { const d = Math.abs(A[i] - B[i]); if (d > mx) mx = d; if (d > 76) n3++; }
    return { mx, n3 }; };
  const out = { cases: [] };
  drawMorph('auto', mLb, 0);   // warm the pair pipeline + kick off the OFF-THREAD morph build
  // The morph-pair mesh builds in the LB worker; wait for it (as a game would
  // via awaitLbReady) before asserting the LB route, else the first frames are Slug.
  if (renderer.awaitLbReady) await renderer.awaitLbReady(mLb);
  for (const t of [0, 0.33, 0.66, 1]) {
    const slug = drawMorph('off', mSlug, t), lb = drawMorph('auto', mLb, t);
    out.cases.push({ t, routed: lb.routed, vsSlug: diff(slug.buf, lb.buf) });
  }
  out.t0VsStatic = diff(drawStatic(bS), drawMorph('auto', mLb, 0).buf);
  out.t1VsStatic = diff(drawStatic(bD), drawMorph('auto', mLb, 1).buf);
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  const mm = p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript' : 'text/plain';
  try {
    const body = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': mm + '; charset=utf-8' });
    res.end(body);
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// HEADLESS EVEN ON THE GPU. Headless reaches the real GPU -- ANGLE (Apple, ANGLE Metal Renderer)
// reports and TIMES the same either way. A window is not free to the person running this: macOS
// CLAMPS --window-position, so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text().slice(0, 300));
});
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 20000,
});
await page.waitForFunction(() => window.__ready === true, { timeout: 20000, polling: 100 });
const r = await page.evaluate((s, d) => window.__run(s, d), SRC, DST);
await browser.close();
server.close();

for (const c of r.cases) {
  if (!c.routed) fail(`t=${c.t}: morph did not take the LB pair route`);
  else if (c.vsSlug.n3 > 60)
    fail(
      `t=${c.t}: LB pair vs Slug morph diverges (${c.vsSlug.n3} px>0.3, max ${(c.vsSlug.mx / 255).toFixed(2)})`,
    );
  else ok(`t=${c.t}: pair ≈ Slug (${c.vsSlug.n3} px>0.3, max ${(c.vsSlug.mx / 255).toFixed(2)})`);
}
if (r.t0VsStatic.n3 > 0 || r.t0VsStatic.mx > 26)
  fail(`t=0 ≠ STATIC LB of the src endpoint (${r.t0VsStatic.n3} px>0.3, max ${r.t0VsStatic.mx})`);
else ok(`t=0 matches the STATIC LB render (one code path; max Δ${r.t0VsStatic.mx})`);
if (r.t1VsStatic.n3 > 0 || r.t1VsStatic.mx > 26)
  fail(`t=1 ≠ STATIC LB of the dst endpoint (${r.t1VsStatic.n3} px>0.3, max ${r.t1VsStatic.mx})`);
else ok(`t=1 matches the STATIC LB render (one code path; max Δ${r.t1VsStatic.mx})`);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nlbGpuMorphSmoke: the partition-pair morph matches Slug across t and the STATIC LB at the endpoints',
);

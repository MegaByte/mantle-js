// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _unifiedThrash — what the unified route costs in a MULTI-BUNDLE scene, where the plain fill pass pays nothing extra.
//
// The unified route keeps ONE vertex buffer per layout (unifiedFillDraw.js): drawing a different bundle changes its owner,
// and a static bundle that dropped its CPU copy rebuilds its stream. A single-asset bench never alternates bundles, so it
// cannot see this. Scenes, per frame: AA (one bundle twice), AB, ABAB (alternating), AABB (blocked). Arms, one page each,
// forward then reverse: unified (LB route), unified + unifiedFillKeepVerts, and the plain fill pass (unifiedFill:false).
// Every arm reports the synced frame (best and median) and the JS submit time, and proves its route from the draw ledger.
//   SVGA / SVGB (SVGA defaults to tiger; SVGB is required), N (512), FRAMES (40), REPS (3)
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512),
  FRAMES = +(process.env.FRAMES || 40);
const strip = (s) =>
  s
    .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
    .replace(/stroke-width\s*=\s*"[^"]*"/g, '')
    .replace(/(^|[;{\s"'])stroke\s*:\s*[^;}"']+/g, '$1stroke:none');
const load = (p, d) => strip(readFileSync(p ? path.resolve(p) : path.join(ROOT, d), 'utf8'));
const SVGA = load(process.env.SVGA, '../MantleSamples/Assets/Mantle/tiger.svg');
if (!process.env.SVGB) {
  console.error('SVGB=<second .svg> is required: the thrash alternates two different assets');
  process.exit(2);
}
const SVGB = load(process.env.SVGB, '');
const HTML = `<!doctype html><body><canvas id=c width=${N} height=${N}></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
try { const m = await import('/src/geom/shapeRecognize.js'); if (m.setSdfPrimitivesEnabled) m.setSdfPrimitivesEnabled(false); } catch {}
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const secA = await importSvg(${JSON.stringify(SVGA)}, { preserveViewport: true });
const secB = await importSvg(${JSON.stringify(SVGB)}, { preserveViewport: true });
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
const one = new Uint8Array(4);
window.__arm = async (arm) => {
  const opts = arm === 'plain' ? { unifiedFill: false } : arm === 'keep' ? { unifiedFillKeepVerts: true } : {};
  const r = createRenderer(gl, shaders, opts); r.setViewport(${N}, ${N});
  r.setFillEngine({ route: arm === 'plain' ? 'none' : 'lb', kernel: 'slug' });
  const A = createBundle(gl, secA), B = createBundle(gl, secB);
  for (const b of [A, B]) { r.prepareBundle(b); if (arm !== 'plain' && r.awaitLbReady) await r.awaitLbReady(b, 30000); }
  if (r.precompileFills) r.precompileFills();
  const scenes = { AA: [A, A], AB: [A, B], ABAB: [A, B, A, B], AABB: [A, A, B, B] };
  for (let w = 0; w < 30; w++) { r.beginFrame([1,1,1,1]); r.drawBundle(A); r.drawBundle(B); r.endFrame(); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,one); await sleep(0); }
  const out = {};
  for (const [name, list] of Object.entries(scenes)) {
    const e0 = JSON.stringify((r.debugStats.engines && r.debugStats.engines.viaRoute) || {});
    const ts = [], cs = [];
    for (let k = 0; k < ${FRAMES}; k++) {
      const t0 = performance.now();
      r.beginFrame([1,1,1,1]); for (const b of list) r.drawBundle(b); r.endFrame();
      const tc = performance.now() - t0;
      gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,one);
      const tf = performance.now() - t0;
      if (k >= 4) { ts.push(tf); cs.push(tc); }
    }
    ts.sort((x, y) => x - y); cs.sort((x, y) => x - y);
    out[name] = { best: ts[0], med: ts[ts.length >> 1], cpu: cs[cs.length >> 1],
                  via: JSON.stringify((r.debugStats.engines && r.debugStats.engines.viaRoute) || {}), via0: e0 };
  }
  for (const b of [A, B]) b.dispose && b.dispose();
  r.dispose && r.dispose();
  return out;
};
window.__ready = true;
</script></body>`;
const srv = http.createServer((q, res) => {
  try {
    const p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((z) => srv.listen(0, '127.0.0.1', z));
const br = await launchBrowser({
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--use-gl=angle', '--use-angle=metal', '--no-sandbox'],
});
const ARMS = ['unified', 'keep', 'plain'];
const REPS = +(process.env.REPS || 3);
const res = {};
const order = [];
for (let i = 0; i < REPS; i++) order.push(...(i % 2 ? [...ARMS].reverse() : ARMS));
for (const arm of order) {
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(`[${arm}]`, e.message));
  await pg.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load' });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 600000 });
  const o = await pg.evaluate((a) => window.__arm(a), arm);
  await pg.close();
  for (const [sc, v] of Object.entries(o)) {
    const k = arm + ':' + sc;
    if (!res[k] || v.best < res[k].best) res[k] = v;
  }
}
await br.close();
srv.close();
console.log(
  `scene per frame | best / median synced frame ms | median JS submit ms   (best of ${REPS} pages per arm, N=${N})`,
);
for (const sc of ['AA', 'AB', 'ABAB', 'AABB']) {
  const cells = ARMS.map((a) => {
    const v = res[a + ':' + sc];
    return v ? `${a} ${v.best.toFixed(2)}/${v.med.toFixed(2)} cpu ${v.cpu.toFixed(2)}` : `${a} -`;
  });
  console.log(`${sc.padEnd(5)} | ${cells.join(' | ')}`);
}
console.log('\nroutes (route ledger after the scene, cumulative):');
for (const a of ARMS) console.log(`  ${a}: ${(res[a + ':AABB'] || {}).via}`);

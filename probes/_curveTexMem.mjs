// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Curve-texture MEMORY check: stream bytes + coefficient texture bytes vs baseline.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, ''); // the package root
const ASSETS = (process.env.ASSETS || 'examples/tiger.svg').split(',');
const SVGS = {};
for (const a of ASSETS) SVGS[a] = readFileSync(path.join(ROOT, a), 'utf8');
const HTML = `<!DOCTYPE html><html><body><canvas id=c width=768 height=768></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,depth:true});
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const SVGS = ${JSON.stringify(SVGS)};
async function run(curveTex, svgSrc) {
  const r = createRenderer(gl, shaders, { aacFill:false, unifiedFillCurveTex: curveTex });
  await r.ready; r.setViewport(768,768); r.setLoopBlinnFill('on');
  const b = createBundle(gl, await importSvg(svgSrc));
  try { r.prepareBundle(b); } catch(e){}
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch(e){} }
  if (r.precompileFills) r.precompileFills();
  const f = () => { r.beginFrame([0,0,0,1]); r.drawBundle(b,{}); r.endFrame(); };
  for (let i=0;i<60;i++){ f(); if((r.debugStats.unifiedFillDraws|0)>0) break;
    await new Promise(res=>requestAnimationFrame(res)); }
  const uf = b._unifiedFill || {};
  // Coefficient bytes computed from the BLOCK COUNT, not from a renderer counter:
  // _uniCoefBytes lives on the internal RendererContext and reads 0 through the
  // public facade, which made the first run report a 51.7% saving that had simply
  // omitted the texture. 4 RGBA32F texels per block = 64B, plus row padding to the
  // 256-texel width.
  const blocks = (uf.coef && uf.coef.blocks) | 0;
  const texels = blocks * 4;
  const rows = blocks ? Math.ceil(texels / 256) : 0;
  return { gate: r.debugStats.unifiedFillGate, verts: uf.vertexCount|0,
           streamBytes: uf.vertBytes|0, coefBytes: rows * 256 * 4 * 4,
           blocks, uni: r.debugStats.unifiedFillDraws|0,
           // hasCoverQuads decides whether aNormal/aEmCoord are dead weight.
           cover: !!uf.cover };
}
const o={}; for(const [n,sv] of Object.entries(SVGS)) o[n]=await run(true, sv);
window.out=o;
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const s = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/') {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    r.writeHead(200, { 'content-type': mime(u.pathname) + '; charset=utf-8' });
    r.end(b);
  } catch {
    r.writeHead(404);
    r.end();
  }
});
await new Promise((r) => s.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const pg = await br.newPage();
const logs = [];
pg.on('pageerror', (e) => logs.push(String(e.message)));
await pg.goto(`http://127.0.0.1:${s.address().port}/`, { waitUntil: 'load' });
try {
  await pg.waitForFunction('window.out', { timeout: 280000 });
} catch {
  console.log('failed: ' + logs.join('; '));
  await br.close();
  s.close();
  process.exit(1);
}
const o = await pg.evaluate(() => window.out);
await br.close();
s.close();
const tot = (x) => x.streamBytes + x.coefBytes;
console.log('  asset                        gate  cover  verts  streamB');
for (const [k, x] of Object.entries(o))
  console.log(
    '  ' + k.padEnd(28),
    String(x.gate).padStart(5),
    String(x.cover).padStart(6),
    String(x.verts).padStart(6),
    String(x.streamBytes).padStart(8),
  );
console.log('\n  cover=false -> aNormal + aEmCoord are unused for every vertex in that');
console.log('  bundle, so a cover-free layout would drop 16 of 56 bytes (-29%).');

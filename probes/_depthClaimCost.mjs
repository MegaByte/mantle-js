// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Does the depth claim actually stop firing on OPAQUE content? Count the
// DEPTH_BUFFER_BIT clears the unified draw issues — that is the claim's cost.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const svg = (a) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="${D}" ${a}/></svg>`;
const OPAQUE = svg('fill="#265b9b"'),
  TRANS = svg('fill="#265b9b" fill-opacity="0.5"');
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="160" height="160"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', {antialias:false, depth:true, preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const OPAQUE = ${JSON.stringify(OPAQUE)}, TRANS = ${JSON.stringify(TRANS)};
let depthClears = 0, counting = false;
const origClear = gl.clear.bind(gl);
gl.clear = (m) => { if (counting && (m & gl.DEPTH_BUFFER_BIT)) depthClears++; return origClear(m); };
async function run(svgSrc) {
  const r = createRenderer(gl, shaders, { aacFill: false });
  const b = createBundle(gl, await importSvg(svgSrc));
  r.setLoopBlinnFill('on');
  try { r.prepareBundle(b); } catch {}
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  const frame = () => { r.setViewport(160,160); r.beginFrame([0,0,0,1]); r.drawBundle(b, {}); r.endFrame(); };
  frame(); if (r.precompileFills) r.precompileFills();
  frame(); if (r.precompileFills) r.precompileFills();
  for (let i=0;i<8;i++){ frame(); if ((r.debugStats.unifiedFillDraws|0)>0) break;
    await new Promise(res=>requestAnimationFrame(res)); }
  counting = true; depthClears = 0;
  const u0 = r.debugStats.unifiedFillDraws|0; frame();
  counting = false;
  const out = { depthClears, uni: (r.debugStats.unifiedFillDraws|0) - u0 };
  try { b.dispose(); } catch {}
  return out;
}
window.out = { opaque: await run(OPAQUE), translucent: await run(TRANS) };
</script></body></html>`;
const server = http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/') {
    s.writeHead(200, { 'content-type': 'text/html' });
    s.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    s.writeHead(200, {
      'content-type': /\.(js|mjs)$/.test(u.pathname)
        ? 'text/javascript'
        : u.pathname.endsWith('.glsl')
          ? 'text/plain'
          : 'text/html',
    });
    s.end(b);
  } catch {
    try {
      s.writeHead(404);
    } catch {}
    s.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const pg = await br.newPage();
const logs = [];
pg.on('pageerror', (e) => logs.push(String(e.message)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
try {
  await pg.waitForFunction('typeof window.out!=="undefined"', { timeout: 120000 });
} catch {
  console.log('never finished', logs.join('\n'));
  await br.close();
  server.close();
  process.exit(1);
}
console.log(JSON.stringify(await pg.evaluate(() => window.out)));
await br.close();
server.close();

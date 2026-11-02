// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Gate survey across the real asset corpus.
//
// The question this answers: is the CLASSIC Loop-Blinn route still reachable, and
// for what? debugStats.lbClassicRouteCount counts bundles that fell past the
// unified route onto it; unifiedFillGate says why. Zero across the corpus is what
// would make the classic routes deletable.
import http from 'http';
import path from 'path';
import { readFileSync, readdirSync } from 'fs';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = path.join(ROOT, 'examples/smoke');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.svg'))
  .sort();
const LIMIT = Number(process.env.LIMIT || files.length);
const S = 128;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${S}" height="${S}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S=${S};
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
window.__run = async (names) => {
  const r=createRenderer(gl,shaders); r.setViewport(S,S); r.setLoopBlinnFill('on');
  const gates={}, classicBy={};
  let prevClassic=0;
  for (const name of names) {
    let b=null;
    try {
      const src = await (await fetch('/examples/smoke/'+name)).text();
      b = createBundle(gl, await importSvg(src));
      r.prepareBundle(b);
      if (r.awaitLbReady) { try { await r.awaitLbReady(b, 4000); } catch {} }
      r.beginFrame([0,0,0,1]); r.drawBundle(b); r.endFrame();
      const st=r.debugStats;
      const g = st.unifiedFillGate || 'none';
      gates[g]=(gates[g]|0)+1;
      const c = st.lbClassicRouteCount|0;
      if (c > prevClassic) { const k = st.lbClassicLastGate||'?'; classicBy[k]=(classicBy[k]|0)+1; prevClassic=c; }
    } catch (e) { gates['THREW']=(gates['THREW']|0)+1; }
    if (b) { try { b.dispose(); } catch {} }
  }
  return { n: names.length, gates, classicBy, classicTotal: r.debugStats.lbClassicRouteCount|0 };
};
window.__ready = true;
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p)
    ? 'text/javascript'
    : p.endsWith('.glsl')
      ? 'text/plain'
      : p.endsWith('.svg')
        ? 'image/svg+xml'
        : 'text/html';
const server = http.createServer((q, res) => {
  const u = new URL(q.url, 'http://l');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    res.writeHead(200, { 'content-type': mime(u.pathname) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(u.pathname))));
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 600000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 30000 });
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
const out = await pg.evaluate((n) => window.__run(n), files.slice(0, LIMIT));
console.log('assets:', out.n);
console.log('gates:', JSON.stringify(out.gates, null, 1));
console.log('classic LB reached:', out.classicTotal, JSON.stringify(out.classicBy));
await br.close();
server.close();

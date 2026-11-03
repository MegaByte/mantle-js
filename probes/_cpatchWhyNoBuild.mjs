// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchWhyNoBuild — the balance bench reports "no cpatch shapes" on plain cubic fills that
// _cpatchRouteRender builds without complaint. The two harnesses differ in how they import and
// how they configure the renderer, so this varies one factor at a time and prints what the
// bundle actually carries after prepare.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M22.4 66.4 C31.4 30.4 58.4 30.4 76.4 48.4 L94.4 102.4 L34.4 102.4 Z" fill="#265b9b"/></svg>`;
const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const SVG=${JSON.stringify(SVG)};
const mk=()=>{const c=document.createElement('canvas');c.width=384;c.height=384;document.body.appendChild(c);
  return c.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});};
window.__run=async()=>{
  const out=[];
  const cases=[
    ['route-probe style', {preserveViewport:true}, {cpatchFill:true,cpatchOpts:{interiorN:8,grid:4}}, null],
    ['bench import',      {occupancyGrid:true,gwnTree:true,occlusionCull:true}, {cpatchFill:true,cpatchOpts:{interiorN:8,grid:4}}, null],
    ['bench opts (no cpatchOpts)', {occupancyGrid:true,gwnTree:true,occlusionCull:true}, {cpatchFill:true}, null],
    ['bench opts + lb on', {occupancyGrid:true,gwnTree:true,occlusionCull:true}, {cpatchFill:true}, 'on'],
    ['bench opts + pool off', {occupancyGrid:true,gwnTree:true,occlusionCull:true}, {cpatchFill:true,cpatchOpts:{pool:false}}, 'on'],
  ];
  for (const [name,imp,opts,mode] of cases) {
    try {
      const gl=mk(); const r=createRenderer(gl,shaders,{...opts,precompileFillsBudgetMs:5000}); await r.ready;
      r.setViewport(384,384); if(mode) r.setLoopBlinnFill(mode);
      const b=createBundle(gl,await importSvg(SVG,imp));
      if(r.prepareBundle) r.prepareBundle(b);
      for(let i=0;i<400&&b._cpatchConv==='pending';i++) await new Promise(z=>setTimeout(z,5));
      if(r.prepareBundle) r.prepareBundle(b);
      r.beginFrame([0,0,0,1]); r.drawBundle(b,{}); r.endFrame();
      out.push({name, built:b._cpatchBuilt|0, conv:b._cpatchConv===undefined?'undef':(b._cpatchConv==='pending'?'pending':'map'),
                dropped:b._cpatchDropped|0, unres:b._cpatchUnresolved|0, shapes:b.numShapes|0,
                lbMeshes:(b._lbMeshes||[]).filter(Boolean).length, gate:r._unifiedFillGate||'-'});
    } catch(e){ out.push({name, err:String(e.message).slice(0,90)}); }
  }
  return out;
};
window.__ready=1;
</script></body></html>`;
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 200)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === 1, { timeout: 120000, polling: 50 });
const rows = await pg.evaluate(() => window.__run());
await br.close();
server.close();
console.log('');
for (const r of rows)
  console.log(
    '  ' +
      (r.err
        ? r.name.padEnd(30) + ' ERR ' + r.err
        : r.name.padEnd(30) +
          ' built=' +
          String(r.built).padStart(3) +
          '  conv=' +
          r.conv.padEnd(8) +
          ' dropped=' +
          r.dropped +
          ' unres=' +
          r.unres +
          ' shapes=' +
          r.shapes +
          ' lbMeshes=' +
          r.lbMeshes +
          ' gate=' +
          r.gate),
  );

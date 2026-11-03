// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Curves per CPatch patch, by segment count — the number that sets CPatch's fragment cost.
// Every fragment of a patch evaluates ALL of that patch's curves, so if the decomposition does not
// split a many-curve contour into small groups, cost grows with the shape instead of staying flat.
// maxCurves is meant to cap it (8 in cpatchPack).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEGS = (process.env.SEGS || '8,16,32,64,128,192').split(',').map(Number);
const FAM = process.env.FAMILY || 'quad';
const TOLPX = process.env.TOLPX ? Number(process.env.TOLPX) : null;
const PAGE = `<!doctype html><body><canvas id=c width=256 height=256></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const FAM=${JSON.stringify(FAM)}, SEGS=${JSON.stringify(SEGS)}, TOLPX=${JSON.stringify(TOLPX)};
const ring=(segs)=>{const cx=64,cy=64,r=44,P=[];
  for(let i=0;i<segs;i++){const a=-Math.PI/2+i*2*Math.PI/segs;P.push([cx+r*Math.cos(a),cy+r*Math.sin(a)]);}
  let d='M'+P[0][0].toFixed(4)+' '+P[0][1].toFixed(4);
  for(let i=0;i<segs;i++){const p=P[i],q=P[(i+1)%segs],mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2,bx=cx+(mx-cx)*1.18,by=cy+(my-cy)*1.18;
    if(FAM==='line')d+=' L'+q[0].toFixed(4)+' '+q[1].toFixed(4);
    else d+=' Q'+bx.toFixed(4)+' '+by.toFixed(4)+' '+q[0].toFixed(4)+' '+q[1].toFixed(4);}
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="'+d+' Z" fill="#265b9b"/></svg>';};
const out=[];
for(const segs of SEGS){
  globalThis.__CP_CURVE_HIST=[];
  const r=createRenderer(gl,shaders,{cpatchFill:true,cpatchOpts:TOLPX!=null?{tolPx:TOLPX}:{}}); r.setViewport(256,256); r.setFillEngine({route:'cpatch'});
  const b=createBundle(gl,await importSvg(ring(segs))); r.prepareBundle(b);
  if(r.awaitEngine){try{await r.awaitEngine(b,'cpatch',60000);}catch{}}
  for(let w=0;w<10;w++){r.beginFrame([1,1,1,1]);for(let i=0;i<8;i++)r.drawBundle(b,{});r.endFrame();} gl.finish();
  const ts=[]; for(let k=0;k<7;k++){const t0=performance.now();
    for(let f=0;f<25;f++){r.beginFrame([1,1,1,1]);for(let i=0;i<8;i++)r.drawBundle(b,{});r.endFrame();}
    const px1=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px1);
    ts.push((performance.now()-t0)/25);}
  ts.sort((a,b)=>a-b); const ms=ts[3];
  const counts=globalThis.__CP_CURVE_HIST.slice();
  const per=counts.map(n=>({n}));
  const ds=r.debugStats, e=ds.engines&&ds.engines.draws||{};
  out.push({segs, patches:counts.length, mean:counts.length?counts.reduce((a,c)=>a+c,0)/counts.length:0,
            max:counts.length?Math.max(...counts):0, sum:counts.reduce((a,c)=>a+c,0),
            ms, built:b._cpatchBuilt|0, drew:Object.keys(e).filter(k=>e[k]>0).join('+')||'none'});
}
window.__out=out; window.__ready=true;
</script></body>`;
const srv = http.createServer((q, r) => {
  try {
    if (q.url === '/') {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(PAGE);
      return;
    }
    const p = decodeURIComponent(q.url.split('?')[0]);
    r.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    r.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!r.headersSent) r.writeHead(404);
    r.end();
  }
});
await new Promise((x) => srv.listen(0, '127.0.0.1', x));
const port = srv.address().port;
const args = ['--no-sandbox'];
if (process.env.GPU === '1') args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
const br = await launchBrowser({ headless: 'new', args });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error('[pg]', e.message));
await pg.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__ready, { timeout: 300000 });
const o = await pg.evaluate(() => window.__out);
console.log(`\n  ${FAM} ring — curves per patch (every fragment evaluates all of them)\n`);
console.log('  segs  patches   mean   max    total   ms/frame(x8)  drew');
for (const r of o)
  console.log(
    '  ' +
      String(r.segs).padStart(4) +
      String(r.patches).padStart(9) +
      r.mean.toFixed(2).padStart(7) +
      String(r.max).padStart(6) +
      String(r.sum).padStart(9) +
      r.ms.toFixed(3).padStart(14) +
      '  ' +
      r.drew,
  );
await br.close();
srv.close();

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// WHERE does a CPatch morph go wrong at high segment counts? The balance bench shows s8 clean and
// s32 structurally wrong (12.6k px at 256, 216k at 1024) on line/quad/cubic. This renders the same
// pair at a sweep of segment counts and poses, against Slug, and reports where the wrongness is:
// how many pixels, at which t, and whether CPatch actually drew that frame.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 320);
const FAM = process.env.FAMILY || 'quad';
const SEGS = (process.env.SEGS || '8,16,24,32').split(',').map(Number);
const TS = (process.env.TS || '0,0.25,0.5,0.75,1').split(',').map(Number);
const PAGE = `<!doctype html><body><canvas id=c width=${N} height=${N}></canvas><script type=module>
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const FAM=${JSON.stringify(FAM)}, SEGS=${JSON.stringify(SEGS)}, TS=${JSON.stringify(TS)}, N=${N};
const ring=(r,rot,segs)=>{const P=[],cx=64,cy=64;
  for(let i=0;i<segs;i++){const a=rot*6.283185+i*6.283185/segs;P.push([cx+128*r*Math.cos(a),cy+128*r*Math.sin(a)]);}
  let d='M'+P[0][0].toFixed(3)+' '+P[0][1].toFixed(3);
  for(let i=0;i<segs;i++){const p=P[i],q=P[(i+1)%segs],mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2,bx=cx+(mx-cx)*1.18,by=cy+(my-cy)*1.18;
    if(FAM==='line')d+=' L'+q[0].toFixed(3)+' '+q[1].toFixed(3);
    else if(FAM==='quad')d+=' Q'+bx.toFixed(3)+' '+by.toFixed(3)+' '+q[0].toFixed(3)+' '+q[1].toFixed(3);
    else{const c1x=p[0]+(bx-p[0])*1.35,c1y=p[1]+(by-p[1])*1.35,c2x=q[0]+(bx-q[0])*1.35,c2y=q[1]+(by-q[1])*1.35;
      d+=' C'+c1x.toFixed(3)+' '+c1y.toFixed(3)+' '+c2x.toFixed(3)+' '+c2y.toFixed(3)+' '+q[0].toFixed(3)+' '+q[1].toFixed(3);}}
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="'+d+' Z" fill="#265b9b"/></svg>';};
const run=async(segs,cpatch)=>{
  globalThis.__CP_FROZEN_DECLINES=0;
  const r=createRenderer(gl,shaders,cpatch?{cpatchFill:true,cpatchOpts:{}}:{}); r.setViewport(N,N);
  r.setFillEngine({route: cpatch?'cpatch':'none'});
  const bA=createBundle(gl,await importSvg(ring(.40,0,segs))), bB=createBundle(gl,await importSvg(ring(.26,.55,segs)));
  const m=createShapeMorph(gl,bA,bB), b=m.bundle||m;
  const tp=performance.now();
  r.prepareBundle(b); if(r.awaitEngine){try{await r.awaitEngine(b,cpatch?'cpatch':'slug',180000);}catch{}}
  const planMs=performance.now()-tp;
  const frames=[];
  for(const t of TS){ m.setT(t); r.beginFrame([1,1,1,1]); r.drawBundle(m,{}); r.endFrame();
    const px=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px);
    const ds=r.debugStats, e=ds.engines&&ds.engines.draws||{};
    frames.push({px, built:b._cpatchBuilt|0, drew:Object.keys(e).filter(k=>e[k]>0).join('+')||'none',
                 why:b._cpatchMorphWhy||null, stomps:ds.fillMeshStomps|0}); }
  frames.planMs=planMs; frames.frozenDeclines=globalThis.__CP_FROZEN_DECLINES|0; return frames; };
const out=[];
for(const segs of SEGS){ const ref=await run(segs,false), cp=await run(segs,true);
  const rows=[]; for(let i=0;i<TS.length;i++){ const a=ref[i].px,c=cp[i].px; let wrong=0,worst=0;
    for(let p=0;p<a.length;p+=4){ let d=0; for(let k=0;k<4;k++) d=Math.max(d,Math.abs(a[p+k]-c[p+k]));
      if(d>worst)worst=d; if(d>24)wrong++; }
    rows.push({t:TS[i],wrong,worst,built:cp[i].built,drew:cp[i].drew,why:cp[i].why,stomps:cp[i].stomps}); }
  out.push({segs,rows,planMs:cp.planMs,frozen:cp.frozenDeclines}); }
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
console.log(`\n  ${FAM} morph vs Slug, ${N}px — wrong = |diff| > 24/255\n`);
for (const g of o) {
  console.log(
    `  segs=${g.segs}   plan+warm ${g.planMs != null ? g.planMs.toFixed(0) : '?'}ms   frozen-pair declines: ${g.frozen}`,
  );
  for (const r of g.rows)
    console.log(
      `     t=${String(r.t).padEnd(5)} wrong=${String(r.wrong).padStart(7)} worst=${String(r.worst).padStart(4)}  built=${r.built} drew=${String(r.drew).padEnd(11)} stomps=${r.stomps}${r.why ? '  why=' + r.why : ''}`,
    );
}
await br.close();
srv.close();

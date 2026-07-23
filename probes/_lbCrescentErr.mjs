// _lbCrescentErr — WHERE does LB's curve error live, and what sign?
// LB matches the exact reference on straight edges (0.29/255) and on true SDF implicits
// (kind 6/7), but is 7.7-17.9 on quad/cubic crescents. Map the signed error along the boundary:
// a decomposition bug (crescent + interior composited by OVER) should show structure — a
// systematic bias, or spikes at the seams between adjacent curve pieces.
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const N=192, SS=8;
const circle=(n)=>{ const c=n/2,r=n*0.36,k=0.5523*r;
  const P=[[c-r,c],[c,c-r],[c+r,c],[c,c+r]]; let d=`M ${P[0][0]} ${P[0][1]} `;
  for(let i=0;i<4;i++){ const A=P[i],B=P[(i+1)%4];
    const ta=[-(A[1]-c),(A[0]-c)], tb=[-(B[1]-c),(B[0]-c)];
    d+=`C ${(A[0]+ta[0]/r*k).toFixed(4)} ${(A[1]+ta[1]/r*k).toFixed(4)} ${(B[0]-tb[0]/r*k).toFixed(4)} ${(B[1]-tb[1]/r*k).toFixed(4)} ${B[0]} ${B[1]} `; }
  return d+'Z'; };
// quad ring: exercises kind-1/9/11 crescents (a different path from cubic kind-2)
const quadRing=(n)=>{ const c=n/2,r=n*0.36,K=8;
  const P=(i)=>{const a=(i/K)*2*Math.PI; return [c+r*Math.cos(a), c+r*Math.sin(a)];};
  let d=`M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
  for(let i=0;i<K;i++){ const A=P(i),B=P(i+1);
    const mx=(A[0]+B[0])/2+(B[1]-A[1])*0.35, my=(A[1]+B[1])/2-(B[0]-A[0])*0.35;
    d+=`Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `; }
  return d+'Z'; };
// ellipse: non-circular, tests the rquad / SDF classification. tiny: high curvature.
const ellipse=(n)=>{ const cx=n/2,cy=n/2,rx=n*0.40,ry=n*0.26,k=0.5523;
  const P=[[cx-rx,cy],[cx,cy-ry],[cx+rx,cy],[cx,cy+ry]];
  const C=[[[cx-rx,cy-ry*k],[cx-rx*k,cy-ry]],[[cx+rx*k,cy-ry],[cx+rx,cy-ry*k]],
           [[cx+rx,cy+ry*k],[cx+rx*k,cy+ry]],[[cx-rx*k,cy+ry],[cx-rx,cy+ry*k]]];
  let d=`M ${P[0][0]} ${P[0][1]} `;
  for(let i=0;i<4;i++){ const B=P[(i+1)%4];
    d+=`C ${C[i][0][0].toFixed(4)} ${C[i][0][1].toFixed(4)} ${C[i][1][0].toFixed(4)} ${C[i][1][1].toFixed(4)} ${B[0]} ${B[1]} `; }
  return d+'Z'; };
const tiny=(n)=>{ const c=n/2,r=n*0.028,k=0.5523*r;
  const P=[[c-r,c],[c,c-r],[c+r,c],[c,c+r]]; let d=`M ${P[0][0]} ${P[0][1]} `;
  for(let i=0;i<4;i++){ const A=P[i],B=P[(i+1)%4];
    const ta=[-(A[1]-c),(A[0]-c)], tb=[-(B[1]-c),(B[0]-c)];
    d+=`C ${(A[0]+ta[0]/r*k).toFixed(4)} ${(A[1]+ta[1]/r*k).toFixed(4)} ${(B[0]-tb[0]/r*k).toFixed(4)} ${(B[1]-tb[1]/r*k).toFixed(4)} ${B[0]} ${B[1]} `; }
  return d+'Z'; };
const SHAPES={quad:quadRing, ellipse, tiny, circle};
const SHAPE = SHAPES[process.env.SHAPE] || circle;
const wrap=(d,n)=>`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${d}"/></svg>`;
const HTML=`<!DOCTYPE html><html><body><canvas id="c" width="${N*SS}" height="${N*SS}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
globalThis.__LB_HULL_DILATE = ${JSON.stringify(Number(process.env.DIL||1))};
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, SS=${SS};
const rSlug=createRenderer(gl,shaders,{}); rSlug.setLoopBlinnFill('off');
const rLb=createRenderer(gl,shaders,{});   rLb.setLoopBlinnFill('on');
const grab=(w,h)=>{const p=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a=new Float64Array(w*h); for(let i=0;i<w*h;i++) a[i]=p[i*4]; return a;};
const render=(r,sec,n)=>{const b=createBundle(gl,sec); r.prepareBundle&&r.prepareBundle(b);
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  const c0=r.debugStats.loopBlinnRouteCount;
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const a=grab(n,n); a.routed=r.debugStats.loopBlinnRouteCount-c0; b.dispose(); return a;};
const down=(hi,n,ss)=>{const lo=new Float64Array(n*n);
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){ let s=0;
    for(let j=0;j<ss;j++) for(let i=0;i<ss;i++) s+=hi[(y*ss+j)*(n*ss)+(x*ss+i)];
    lo[y*n+x]=s/(ss*ss);} return lo;};
window.__run=async(lo,hi)=>{
  // preserveViewport: else importSvg fits the path-tight bbox to the viewport and every shape
  // renders at the SAME size — which is how 'tiny' silently rendered as large as 'circle'.
  const IV={preserveViewport:true};
  const secLo=await importSvg(lo,IV), secHi=await importSvg(hi,IV);
  const ref=down(render(rSlug,secHi,N*SS),N,SS);
  const lb=render(rLb,secLo,N);
  // which primitive kinds does this shape emit?
  let kinds={};
  { const b=createBundle(gl,secLo); rLb.prepareBundle&&rLb.prepareBundle(b);
    const M=b._lbMeshes||[];
    if(M[0]&&M[0].verts){ const V=M[0].verts,F=24;
      for(let i=0;i<M[0].vertexCount;i++){ const k=Math.floor(V[i*F+5]+0.001); kinds[k]=(kinds[k]||0)+1; } }
    b.dispose(); }
  // luminance: 255 = empty, 0 = full. coverage = (255-lum)/255. err = lbCov - refCov
  const pts=[];
  let sPos=0,sNeg=0,nPos=0,nNeg=0;
  // split by SIDE of the true edge: refCov<0.5 = pixel centre OUTSIDE the shape (the exterior
  // half of the AA ramp), refCov>0.5 = inside. A missing outer ramp shows as under-coverage
  // confined to the outside half.
  let outSum=0,outN=0,inSum=0,inN=0;
  const c=N/2;
  for(let y=0;y<N;y++) for(let x=0;x<N;x++){
    const r=ref[y*N+x]; if(!(r>2 && r<253)) continue;
    const refCov=(255-r)/255;
    const e=((255-lb[y*N+x])-(255-r));         // signed, /255
    if(e>0){sPos+=e;nPos++;} else {sNeg+=-e;nNeg++;}
    if(refCov<0.5){outSum+=e;outN++;} else {inSum+=e;inN++;}
    if(Math.abs(e)>25){ const ang=Math.atan2(y-c,x-c)*180/Math.PI; pts.push([Math.round(ang), +e.toFixed(0)]); }
  }
  return {routed:lb.routed, kinds, meanPos:sPos/Math.max(1,nPos), meanNeg:sNeg/Math.max(1,nNeg), nPos, nNeg,
    outMean:outSum/Math.max(1,outN), outN, inMean:inSum/Math.max(1,inN), inN,
    bad:pts.length, badAngles:pts.slice(0,40)};
};
window.__ready=true;</script></body></html>`;
const server=http.createServer((q,res)=>{try{if(q.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(HTML);return;}const pp=decodeURIComponent(q.url.split('?')[0]);res.writeHead(200,{'content-type':pp.endsWith('.glsl')?'text/plain':'text/javascript'});res.end(readFileSync(path.join(ROOT,pp)));}catch{if(!res.headersSent)res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const br=await puppeteer.launch({headless:'new',args:['--no-sandbox']});
const pg=await br.newPage(); pg.on('pageerror',e=>console.error(' [err]',e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load',timeout:90000});
await pg.waitForFunction(()=>window.__ready===true,{timeout:120000});
const o=await pg.evaluate((a,b)=>window.__run(a,b), wrap(SHAPE(N),N), wrap(SHAPE(N*SS),N*SS));
await br.close(); server.close();
console.log(`shape=${process.env.SHAPE||'circle'}  lbRouted=${o.routed}  kinds=${JSON.stringify(o.kinds)}`);
console.log(`over-coverage: ${o.nPos} px, mean +${o.meanPos.toFixed(2)}/255`);
console.log(`under-coverage: ${o.nNeg} px, mean -${o.meanNeg.toFixed(2)}/255`);
console.log(`bad (>25/255): ${o.bad}`);
console.log(`OUTSIDE half (refCov<0.5): ${o.outN} px, mean signed ${o.outMean.toFixed(2)}/255`);
console.log(`INSIDE  half (refCov>0.5): ${o.inN} px, mean signed ${o.inMean.toFixed(2)}/255`);
// bucket bad pixels by angle: seams of a 4-cubic circle sit at 0/90/180/270 deg
const buckets = new Map();
for (const [ang] of o.badAngles) { const b = Math.round(ang/15)*15; buckets.set(b,(buckets.get(b)||0)+1); }
console.log('bad-pixel angle histogram (15deg buckets, seams at 0/90/180/-90):');
console.log('   ' + [...buckets.entries()].sort((a,b)=>a[0]-b[0]).map(([a,n])=>`${a}:${n}`).join('  '));

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cubicStrokeZoom — does the CUBIC stroke's closest-point error grow with zoom?
//
// A quadratic's closest point is the root of dot(Q, Q'), which is a CUBIC in t and therefore has a
// closed form -- quadClosestT solves it exactly. A cubic's is degree FIVE, and by Abel-Ruffini a
// general quintic has no solution in radicals, so strokeCubicAccum seeds 9 samples and runs 3
// Newton steps instead. Fixed iterations leave an error constant in EM.
//
// That is exactly the flaw the quad path's closed form avoids. Its own comment: "the stroke mesh is
// built once and used at any zoom, so a fixed em error grows without bound in PIXELS" -- an error of
// ~0.22em is invisible at 1x and 0.9px at 4x. If the cubic has the same shape of error, the same
// argument applies to it.
//
// So: render one stroked curve at increasing zoom against a SUPERSAMPLED reference of itself, and
// report the error in PIXELS at each zoom. A scale-invariant solve holds roughly constant (AA
// noise only). An em-fixed error grows with the zoom factor, which is the signature.
//
// QUAD is measured alongside as the control: it is exact, so its curve is what "flat" looks like.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = +(process.env.BASE || 192),
  SS = +(process.env.SS || 4);
const ZOOMS = (process.env.ZOOMS || '1,2,4,8').split(',').map(Number);

const PAGE = `<!doctype html><body><canvas id=c></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{psoWarmIdle:()=>true});
// One curve, two ways of saying it. The cubic and the quadratic are DIFFERENT shapes -- the point
// is not to compare them to each other but to compare each to ITSELF at higher zoom.
const D={ cubic:'M20 100 C 40 20, 88 20, 108 100', quad:'M20 100 Q64 10 108 100' };
const svgOf=(k)=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">'
  +'<path d="'+D[k]+'" fill="none" stroke="#000" stroke-width="9" stroke-linecap="butt"/></svg>';
const render=async(k,px)=>{
  cv.width=px; cv.height=px; r.setViewport(px,px);
  const b=createBundle(gl, await importSvg(svgOf(k))); r.prepareBundle(b);
  if(r.awaitLbReady){try{await r.awaitLbReady(b,20000);}catch{}}
  for(let w=0;w<3;w++){r.beginFrame([1,1,1,1]); r.drawBundle(b,{}); r.endFrame();}
  const buf=new Uint8Array(px*px*4); gl.readPixels(0,0,px,px,gl.RGBA,gl.UNSIGNED_BYTE,buf);
  b.dispose&&b.dispose(); return buf;};
// Coverage at zoom Z, and the same picture rendered SS times larger and box-downsampled to it.
const covOf=(buf,px)=>{const c=new Float32Array(px*px);
  for(let i=0;i<px*px;i++) c[i]=(255-buf[i*4])/255; return c;};
const down=(buf,px,ss)=>{const o=new Float32Array(px*px);
  for(let y=0;y<px;y++)for(let x=0;x<px;x++){let s=0;
    for(let j=0;j<ss;j++)for(let i=0;i<ss;i++){const p=(((y*ss+j)*px*ss)+(x*ss+i))*4; s+=(255-buf[p])/255;}
    o[y*px+x]=s/(ss*ss);} return o;};
const out=[];
for (const k of ['cubic','quad']) for (const z of ${JSON.stringify(ZOOMS)}) {
  const px=${BASE}*z;
  const got=covOf(await render(k,px),px);
  const ref=down(await render(k,px*${SS}),px,${SS});
  let sum=0,n=0,worst=0;
  for(let i=0;i<px*px;i++){const d=Math.abs(got[i]-ref[i]); if(d>0.004){sum+=d;n++;} if(d>worst)worst=d;}
  out.push({k, z, px, meanErr:n?sum/n:0, worst, edgePx:n});
}
window.__out=out;
</script>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    res.writeHead(200, { 'content-type': mime(_p) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(_p))));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const args = ['--no-sandbox'];
if (process.env.GPU === '1') args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
const br = await launchBrowser({ headless: 'new', args, protocolTimeout: 600000 });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__out', { timeout: 590000, polling: 200 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
console.log(`\n  stroke closest-point error vs a ${SS}x supersample of the SAME picture`);
console.log('    seg     zoom    canvas    edge px    mean err    worst');
for (const x of o)
  console.log(
    `    ${x.k.padEnd(7)} ${String(x.z + 'x').padEnd(7)} ${String(x.px).padEnd(9)} ${String(x.edgePx).padStart(7)} ` +
      `${x.meanErr.toFixed(4).padStart(11)} ${x.worst.toFixed(4).padStart(8)}`,
  );
console.log(
  '\n    QUAD is the control: its solve is exact, so its error is AA only and should not trend.',
);
console.log('    A cubic error that GROWS with zoom is the em-fixed residual of a 3-step Newton.');

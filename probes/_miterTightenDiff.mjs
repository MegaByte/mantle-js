// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _miterTightenDiff — does tightening the stored miter limit change the PICTURE?
//
// The encoder stores the miter ratio a shape actually uses instead of its declared ceiling,
// which collapses the shader's search radius (_reach = halfW * miterLimit). That is a big win --
// up to 3.7x on a stroked ring -- but the same factor pads the shape BBOX, and the bbox sizes the
// band grid. So the bands are re-partitioned, and pixels at band boundaries can shift by a hair.
//
// Ink COUNT cannot tell that apart from lost geometry: both read as "fewer pixels". So this
// renders each asset both ways in ONE page and counts differences by SIZE --
//   any        differing at all (AA noise included)
//   structural differing by more than 24/255, the threshold used elsewhere in this repo
// -- because "9 pixels differ by 1/255" and "9 pixels are missing" are the same number and
// different findings.
import { readFileSync, readdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = +(process.env.SIZE || 512);
const FILES = (process.env.SVGS || 'examples/tiger.svg').split(',');

const svgs = FILES.map((f) => [path.basename(f), readFileSync(path.resolve(ROOT, f), 'utf8')]);
const PAGE = `<!doctype html><body><canvas id=c width=${W} height=${W}></canvas><script type=module>
// YIELD BETWEEN BATCHES, or this probe takes the machine with it. Back-to-back draw loops saturate
// the GPU, WindowServer starves behind Chrome's GPU process, and the desktop stops responding --
// measured the hard way, twice. Headless does NOT help: it removes the window, not the load.
// THROTTLE_MS (default 12) is the pause after each timed batch; 0 disables it for a quiet machine.
const __throttle = ${JSON.stringify(process.env.THROTTLE_MS || '12')};
const __yield = () => new Promise(r => setTimeout(r, +__throttle || 0));
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{psoWarmIdle:()=>true});
r.setViewport(${W},${W});
const mn=(a)=>Math.min.apply(null,a);
/// Keeps the BUNDLE, so the same asset can be timed both ways in one renderer rather than across
/// two runs — the only arrangement whose A/A holds here.
const build=async(svg,tight)=>{
  globalThis.__MANTLE_NO_MITER_TIGHTEN = !tight;
  const b=createBundle(gl, await importSvg(svg)); r.prepareBundle(b);
  if(r.awaitLbReady){try{await r.awaitLbReady(b,20000);}catch{}}
  globalThis.__MANTLE_NO_MITER_TIGHTEN=false; return b;};
const shot=async(svg,tight)=>{
  // The flag is read at ENCODE time, so it has to be set before importSvg -- not before the draw.
  globalThis.__MANTLE_NO_MITER_TIGHTEN = !tight;
  const b=createBundle(gl, await importSvg(svg)); r.prepareBundle(b);
  if(r.awaitLbReady){try{await r.awaitLbReady(b,20000);}catch{}}
  for(let w=0;w<3;w++){r.beginFrame([1,1,1,1]); r.drawBundle(b,{}); r.endFrame();}
  const px=new Uint8Array(${W}*${W}*4); gl.readPixels(0,0,${W},${W},gl.RGBA,gl.UNSIGNED_BYTE,px);
  b.dispose&&b.dispose(); globalThis.__MANTLE_NO_MITER_TIGHTEN=false; return px;};
const out=[];
for (const [name, svg] of ${JSON.stringify(svgs)}) {
  const a=await shot(svg,false), b=await shot(svg,true);
  // TIMED, same renderer, interleaved, rotating, with the loose arm measured twice as the A/A.
  const bl=await build(svg,false), bt=await build(svg,true);
  const pa=()=>{r.beginFrame([1,1,1,1]); r.drawBundle(bl,{}); r.endFrame();};
  const pt=()=>{r.beginFrame([1,1,1,1]); r.drawBundle(bt,{}); r.endFrame();};
  for(let w=0;w<40;w++){ pa(); pt(); if((w&7)===7) await __yield(); }
  {const q=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,q);}
  const arms=[{f:pa,s:[]},{f:pt,s:[]},{f:pa,s:[]}];
  for(let k=0;k<9;k++) for(let j=0;j<3;j++){
    const A=arms[(j+k)%3], t0=performance.now();
    for(let i=0;i<20;i++) A.f();
    const q=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,q);
    A.s.push((performance.now()-t0)/20);
    await __yield();
  }
  const msLoose=mn(arms[0].s), msTight=mn(arms[1].s), msAA=mn(arms[2].s);
  bl.dispose&&bl.dispose(); bt.dispose&&bt.dispose();
  let any=0, structural=0, worst=0, inkA=0, inkB=0;
  for(let i=0;i<a.length;i+=4){
    if(a[i]<200) inkA++; if(b[i]<200) inkB++;
    const d=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));
    if(d>0){any++; if(d>worst) worst=d; if(d>24) structural++;}
  }
  out.push({name, any, structural, worst, inkA, inkB, msLoose, msTight, msAA});
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
console.log('\n  miter tightening — declared limit vs the ratio the shape uses');
console.log(
  '    asset                 ink before/after   any  STRUCT  worst    ms declared   ms tight  speedup   A/A',
);
for (const x of o)
  console.log(
    `    ${x.name.padEnd(20)} ${String(x.inkA).padStart(7)}/${String(x.inkB).padEnd(8)} ${String(x.any).padStart(4)} ${String(x.structural).padStart(6)} ${String(x.worst).padStart(6)} ` +
      `${x.msLoose.toFixed(3).padStart(11)} ${x.msTight.toFixed(3).padStart(10)} ${(x.msLoose / x.msTight).toFixed(2).padStart(8)}x ${(x.msAA / x.msLoose).toFixed(3).padStart(6)}`,
  );
console.log('\n    structural 0 = the picture is the same and the differences are antialiasing');

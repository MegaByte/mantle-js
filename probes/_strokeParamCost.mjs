// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeParamCost — what a stroke's SEGMENT TYPE, WIDTH and JOIN actually cost.
//
// The stroke walk does different work per segment type (a line's closest point is a projection, a
// quad's is a cubic solve, a cubic's is a quintic one, an arc's is trigonometric) and per join
// (miter needs the neighbour tangents and a length clamp; round is a distance; bevel is neither).
// Thickness moves a third lever: a wider band covers more PIXELS, and separately reaches more
// SEGMENTS per pixel because the band search widens.
//
// So ms alone cannot answer "is a thick stroke expensive" -- it is expensive partly because it
// covers more of the screen, which is not the shader being slower. Every row reports ink and
// ms/Mpx (cost per covered pixel) next to ms/frame, and those two say different things:
//   ms/frame  what the frame pays
//   ms/Mpx    what the KERNEL costs, with coverage divided out
//
// Discipline, learned the hard way on the incremental-stroke probe: warm the clock before timing
// anything (the same arm read 0.277ms cold and 0.123ms warm -- a 2.25x swing that is the GPU
// ramping), interleave the cases so drift hits them equally, rotate the order, take the MINIMUM,
// and carry an A/A control (case 0 measured twice) so a difference smaller than the floor is not
// read as a result.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = +(process.env.SIZE || 768),
  SEGS = +(process.env.SEGS || 64);
const BATCH = +(process.env.BATCH || 20),
  SAMPLES = +(process.env.SAMPLES || 7);

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
const SEGS=${SEGS}, W=${W};
const mn=(a)=>Math.min.apply(null,a), med=(a)=>{const b=a.slice().sort((x,y)=>x-y);return b[b.length>>1];};
// ONE RING, FOUR WAYS. Same segment count, same path, same ink to within a per-cent: only the
// segment TYPE the encoder sees changes, so the difference is the kernel's and not the shape's.
const ring=(type)=>{const cx=W/2, cy=W/2, rad=W*0.36, P=[];
  for(let i=0;i<SEGS;i++){const a=-Math.PI/2+i*2*Math.PI/SEGS; P.push([cx+rad*Math.cos(a), cy+rad*Math.sin(a)]);}
  let d='M'+P[0][0].toFixed(3)+' '+P[0][1].toFixed(3);
  for(let i=0;i<SEGS;i++){const p=P[i], q=P[(i+1)%SEGS];
    const mx=(p[0]+q[0])/2, my=(p[1]+q[1])/2, bx=cx+(mx-cx)*1.02, by=cy+(my-cy)*1.02;
    if(type==='line') d+=' L'+q[0].toFixed(3)+' '+q[1].toFixed(3);
    else if(type==='quad') d+=' Q'+bx.toFixed(3)+' '+by.toFixed(3)+' '+q[0].toFixed(3)+' '+q[1].toFixed(3);
    else if(type==='cubic'){const c1=[p[0]+(bx-p[0])*0.66,p[1]+(by-p[1])*0.66], c2=[q[0]+(bx-q[0])*0.66,q[1]+(by-q[1])*0.66];
      d+=' C'+c1[0].toFixed(3)+' '+c1[1].toFixed(3)+' '+c2[0].toFixed(3)+' '+c2[1].toFixed(3)+' '+q[0].toFixed(3)+' '+q[1].toFixed(3);}
    else { // ARC: native elliptical arcs, the encoder's fourth segment kind
      d+=' A'+rad.toFixed(3)+' '+rad.toFixed(3)+' 0 0 1 '+q[0].toFixed(3)+' '+q[1].toFixed(3);}}
  return d+' Z';};
const svgOf=(type,width,join,cap,ml)=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+W+' '+W+'">'
  +'<path d="'+ring(type)+'" fill="none" stroke="#000" stroke-width="'+width+'"'
  +' stroke-linejoin="'+join+'" stroke-linecap="'+cap+'" stroke-miterlimit="'+(ml||8)+'"/></svg>';
const CASES=[];
for (const t of ['line','quad','cubic','arc']) CASES.push({k:'type '+t, t, w:8, j:'miter', c:'butt'});
for (const w of [1,4,16,48])                   CASES.push({k:'width '+w, t:'quad', w, j:'miter', c:'butt'});
for (const j of ['miter','round','bevel'])     CASES.push({k:'join '+j, t:'quad', w:16, j, c:'butt'});
for (const c of ['butt','round','square'])     CASES.push({k:'cap '+c, t:'quad', w:16, j:'miter', c});
// IS IT THE MITER, OR ITS LIMIT? _reach = halfW * miterLimit for a miter join and halfW for round /
// bevel, and _reach is what gates which segments a fragment must walk at all. If the limit is the
// lever, a miter at limit 1 costs what a round join costs while drawing the same miter geometry.
for (const ml of [1,2,4,8,16]) CASES.push({k:'miterlimit '+ml, t:'quad', w:16, j:'miter', c:'butt', ml});
const inkOf=()=>{const px=new Uint8Array(W*W*4); gl.readPixels(0,0,W,W,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let n=0; for(let i=0;i<px.length;i+=4) if(px[i]<200) n++; return n;};
r.setViewport(W,W);
const arms=[];
for (const cs of CASES) {
  const b=createBundle(gl, await importSvg(svgOf(cs.t,cs.w,cs.j,cs.c,cs.ml))); r.prepareBundle(b);
  if(r.awaitLbReady){try{await r.awaitLbReady(b,20000);}catch{}}
  const paint=()=>{r.beginFrame([1,1,1,1]); r.drawBundle(b,{}); r.endFrame();};
  paint(); const ink=inkOf();
  const e=(r.debugStats.engines&&r.debugStats.engines.draws)||{};
  arms.push({...cs, paint, ink, drew:Object.keys(e).filter(x=>e[x]>0).join('+'), s:[]});
}
// TWO A/A CONTROLS, cheap and EXPENSIVE. One control on the cheapest case is not enough: the first
// run of this probe carried three arms that were the SAME configuration (width 16 / join miter /
// cap butt are all quad, w16, miter, butt) and they read 2.640, 2.710 and 2.225 -- a 22% spread,
// where the cheap A/A said 1.8%. Noise scales with the work, so the floor has to be measured at
// both ends or every expensive comparison is read against the wrong one.
arms.push({k:'A/A cheap', paint:arms[0].paint, ink:arms[0].ink, drew:arms[0].drew, s:[], aaOf:0});
const exp=arms.findIndex(a=>a.k==='width 16');
arms.push({k:'A/A costly', paint:arms[exp].paint, ink:arms[exp].ink, drew:arms[exp].drew, s:[], aaOf:exp});
// WARM THE CLOCK on everything before timing anything.
for(let w=0;w<8;w++){ for(const a of arms) a.paint(); await __yield(); }
{const q=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,q);}
for(let k=0;k<${SAMPLES};k++) for(let j=0;j<arms.length;j++){
  const a=arms[(j+k)%arms.length], t=performance.now();
  for(let b=0;b<${BATCH};b++) a.paint();
  const q=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,q);
  a.s.push((performance.now()-t)/${BATCH});
  await __yield();
}
window.__out=arms.map(a=>({k:a.k, ink:a.ink, drew:a.drew, min:mn(a.s), med:med(a.s)}));
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
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const br = await launchBrowser({ headless: 'new', args, protocolTimeout: 600000 });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__out', { timeout: 590000, polling: 200 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
const base = o[0].min;
console.log(
  `\n  stroke parameter cost — ${SEGS}-segment ring, ${W}px, min of ${SAMPLES} batches of ${BATCH}`,
);
console.log('    case            ms/frame   vs first    ink px    ms/Mpx   drew');
for (const x of o)
  console.log(
    `    ${x.k.padEnd(15)} ${x.min.toFixed(3).padStart(8)} ${(x.min / base).toFixed(2).padStart(9)}x ${String(x.ink).padStart(9)} ` +
      `${(x.min / (x.ink / 1e6)).toFixed(1).padStart(8)}   ${x.drew}`,
  );
const aaC = o.find((x) => x.k === 'A/A cheap'),
  aaE = o.find((x) => x.k === 'A/A costly'),
  w16 = o.find((x) => x.k === 'width 16');
console.log(
  `\n    A/A floor  cheap ${(aaC.min / base).toFixed(3)}x   costly ${(aaE.min / w16.min).toFixed(3)}x` +
    ' — a difference smaller than the floor AT THAT COST is not a measurement',
);
console.log(
  '    ms/Mpx divides coverage out: it is the kernel cost, where ms/frame is the frame cost',
);

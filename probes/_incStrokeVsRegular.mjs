// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _incStrokeVsRegular — is the REGULAR stroke path enough for the paint tool too?
//
// Split-stroke geometry has ONE consumer: createIncrementalStroke, the paint-tool fast path. Its
// case is not draw cost -- one band quad per segment is what makes an APPEND O(1), because the
// alternative re-encodes the whole polyline every pointer move. That is a claim about build cost,
// to be measured against the regular stroke path.
//
// So this measures both halves at several stroke lengths:
//   APPEND  growing a stroke to N points, in chunks, the way a pointer move arrives
//             inc      createIncrementalStroke().appendPoints(chunk)
//             regular  rebuild the path and re-import it (what a naive tool does)
//   DRAW    ms/frame for the FINISHED stroke on each path
//
// Both are needed to answer it. If regular append is cheap at realistic lengths, the split-stroke
// program has no consumer left and can go; if it explodes with N, the module earns its keep and
// the answer is "no, and here is the number".
//
// MINIMUM, not median: these samples are bimodal for the same reason every timing here is.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 512,
  H = 512,
  WIDTH = +(process.env.SW || 8);
const LENS = (process.env.LENS || '100,500,2000').split(',').map(Number);
const CHUNK = +(process.env.CHUNK || 10); // points per pointer move
const DRAW_BATCH = +(process.env.BATCH || 30),
  SAMPLES = +(process.env.SAMPLES || 7);

const PAGE = `<!doctype html><body><canvas id=c width=${W} height=${H}></canvas><script type=module>
// YIELD BETWEEN BATCHES, or this probe takes the machine with it. Back-to-back draw loops saturate
// the GPU, WindowServer starves behind Chrome's GPU process, and the desktop stops responding --
// measured the hard way, twice. Headless does NOT help: it removes the window, not the load.
// THROTTLE_MS (default 12) is the pause after each timed batch; 0 disables it for a quiet machine.
const __throttle = ${JSON.stringify(process.env.THROTTLE_MS || '12')};
const __yield = () => new Promise(r => setTimeout(r, +__throttle || 0));
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{psoWarmIdle:()=>true});
const COLOR=[0.8,0.15,0.1,1], LENS=${JSON.stringify(LENS)};
// SAME FRAMING FOR BOTH ARMS. setViewport+drawBundle fit the CONTENT bbox, so an imported SVG is
// scaled to its path's bounds while an incremental stroke uses the bbox it was given -- different
// scales, different fragment counts, and a draw comparison that is not of the same picture. First
// run this way: ink differed by up to 48% and the draw ratios were meaningless. Give the
// incremental stroke the polyline's own bounds so both arms frame identically; ink then agreeing
// is what says the comparison is real.
const boundsOf=(P)=>{let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for(const p of P){if(p[0]<x0)x0=p[0]; if(p[0]>x1)x1=p[0]; if(p[1]<y0)y0=p[1]; if(p[1]>y1)y1=p[1];}
  const pad=${WIDTH}; return [x0-pad,y0-pad,(x1-x0)+2*pad,(y1-y0)+2*pad];};
const mn=(a)=>Math.min.apply(null,a), med=(a)=>{const b=a.slice().sort((x,y)=>x-y);return b[b.length>>1];};
// A wandering polyline, the shape a brush stroke actually has.
const pts=(n)=>{const P=[];let x=40,y=${H}/2,a=0;
  for(let i=0;i<n;i++){a+=Math.sin(i*0.31)*0.28; x+=Math.cos(a)*1.6+((${W}-80)/n); y+=Math.sin(a)*2.2;
    P.push([Math.max(6,Math.min(${W}-6,x)), Math.max(6,Math.min(${H}-6,y))]);} return P;};
const svgOf=(P)=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">'
  +'<path d="M'+P.map(p=>p[0].toFixed(2)+' '+p[1].toFixed(2)).join('L')
  +'" fill="none" stroke="rgb(204,38,26)" stroke-width="${WIDTH}" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const clear=()=>{r.setViewport(${W},${H}); r.beginFrame([0,0,0,1]);};
const inkOf=()=>{const px=new Uint8Array(${W}*${H}*4); gl.readPixels(0,0,${W},${H},gl.RGBA,gl.UNSIGNED_BYTE,px);
  let n=0; for(let i=0;i<px.length;i+=4) if(px[i]>40) n++; return n;};
/// INK SHAPE, so a difference in AMOUNT can be told apart from a difference in PLACE. A smaller
/// bounding box means the two arms are framed differently (the renderer fits the content bbox); the
/// same box with fewer pixels inside means coverage is actually being lost.
const inkShapeOf=()=>{const px=new Uint8Array(${W}*${H}*4); gl.readPixels(0,0,${W},${H},gl.RGBA,gl.UNSIGNED_BYTE,px);
  let x0=1e9,y0=1e9,x1=-1,y1=-1,n=0;
  for(let y=0;y<${H};y++) for(let x=0;x<${W};x++){ const i=(y*${W}+x)*4;
    if(px[i]>40){n++; if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;} }
  return {n, box:[x0,y0,x1-x0+1,y1-y0+1]};};
const out={};
for (const N of LENS) {
  const P=pts(N), row={N}, BBOX=boundsOf(P);
  // ── build both arms first; time neither yet ────────────────────────────
  const t0=performance.now();
  const inc=r.createIncrementalStroke({color:COLOR,width:${WIDTH},bbox:BBOX});
  for(let i=0;i<P.length;i+=${CHUNK}) inc.appendPoints(P.slice(i,i+${CHUNK}));
  if (inc.flush) inc.flush();
  row.appendInc=performance.now()-t0;
  const t1=performance.now();
  let bundle=null;
  for(let i=${CHUNK};i<=P.length;i+=${CHUNK}){
    if(bundle && bundle.dispose) bundle.dispose();
    bundle=createBundle(gl, await importSvg(svgOf(P.slice(0,i))));
    r.prepareBundle(bundle);
  }
  row.appendReg=performance.now()-t1;
  const paintInc=()=>{clear(); r.drawBundle(inc.bundle,{}); r.endFrame();};
  const paintReg=()=>{clear(); r.drawBundle(bundle,{}); r.endFrame();};
  paintInc(); const si=inkShapeOf(); paintReg(); const sr=inkShapeOf();
  row.inkInc=si.n; row.inkReg=sr.n; row.boxInc=si.box; row.boxReg=sr.box;
  row.drewReg=Object.keys((r.debugStats.engines&&r.debugStats.engines.draws)||{}).join('+');
  // ── WARM THE CLOCK BEFORE TIMING ANYTHING. Measured the hard way: the same N=100 regular arm
  // read 0.277ms as the first row of a run and 0.123ms as the last -- a 2.25x swing that is the
  // GPU ramping, not the renderer, and it is what made a first pass report the incremental path
  // as 1.98x faster when it is not.
  for(let w=0;w<60;w++){paintInc(); paintReg();}
  const q0=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,q0);
  // ── INTERLEAVED, ROTATING, WITH AN A/A CONTROL. Three arms: inc, reg, and reg AGAIN. The
  // second reg costs the same work as the first, so regB/regA is the noise floor this run can
  // resolve -- any inc/reg ratio inside it is not a measurement.
  const arms=[{k:'inc',f:paintInc,s:[]},{k:'reg',f:paintReg,s:[]},{k:'regAA',f:paintReg,s:[]}];
  for(let k=0;k<${SAMPLES};k++) for(let j=0;j<arms.length;j++){
    const a=arms[(j+k)%arms.length], t=performance.now();
    for(let b=0;b<${DRAW_BATCH};b++) a.f();
    const q=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,q);
    a.s.push((performance.now()-t)/${DRAW_BATCH});
  }
  row.drawInc=mn(arms[0].s); row.drawReg=mn(arms[1].s); row.drawAA=mn(arms[2].s);
  row.drawIncMed=med(arms[0].s); row.drawRegMed=med(arms[1].s);
  inc.dispose && inc.dispose(); if(bundle && bundle.dispose) bundle.dispose();
  out[N]=row;
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
console.log(
  `\n  incremental stroke vs the regular path — ${CHUNK} pts/append, width ${WIDTH}, ${W}px`,
);
console.log(
  '    N      append inc    append reg     ratio      draw inc     draw reg      ratio     A/A    ink inc/reg',
);
for (const N of LENS) {
  const x = o[N];
  if (!x) {
    console.log('    ' + N + '  (missing)');
    continue;
  }
  const ai = x.appendInc,
    ar = x.appendReg,
    di = x.drawInc,
    dr = x.drawReg;
  console.log(
    `    ${String(N).padEnd(6)} ${ai.toFixed(1).padStart(9)}ms ${ar.toFixed(1).padStart(11)}ms ${(ar / ai).toFixed(1).padStart(8)}x ` +
      `${di.toFixed(3).padStart(11)}ms ${dr.toFixed(3).padStart(11)}ms ${(dr / di).toFixed(2).padStart(8)}x ` +
      `${(x.drawAA / x.drawReg).toFixed(2).padStart(6)}x  ${x.inkInc}/${x.inkReg}` +
      (Math.abs(x.inkInc - x.inkReg) > 0.08 * Math.max(x.inkInc, x.inkReg)
        ? '  !! ink differs >8% — NOT comparable (reg drew ' + x.drewReg + ')'
        : ''),
  );
}
for (const N of LENS) {
  const x = o[N];
  if (!x) continue;
  console.log(
    `    N=${String(N).padEnd(5)} ink box  inc [${x.boxInc.join(',')}]   reg [${x.boxReg.join(',')}]`,
  );
}
console.log('\n    append = growing the stroke to N points in chunks (what a pointer move costs)');
console.log(
  '    draw   = ms/frame for the finished stroke, min of ' + SAMPLES + ' batches of ' + DRAW_BATCH,
);

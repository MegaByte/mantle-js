// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchPerDrawCost — what the WIRED CPatch route does per draw that the kernel does not.
//
// The hand-packed probe (_cpatchDrawSpeed) reports CPatch FASTER than Loop-Blinn per pixel (0.205
// vs 0.2257 ns/px) and per draw at 2048px. The balance bench, at 256px and 32 draws a frame, has
// it 5x SLOWER. Both cannot be about the math: that probe takes the slope between 512 and 2048
// precisely so per-draw fixed cost cancels, and the bench is dominated by it. So this counts the
// GL work each engine issues per frame for the same shape -- uploads, binds, draws -- rather than
// timing anything, because a count is exact where this machine's clock is not.
//
// WHY THE ARC ROW LOOKS THE WAY IT DOES, corrected. Loop-Blinn emits SIX vertices for a
// 192-segment arc ring, and the reason is not a fallback: the bench's arc family builds exact
// circular arcs, so the ring IS a circle, and buildLoopBlinnMesh recognizes it
// (circleFromContours / ellipseFromContours) and returns ONE elliptical-SDF disc, kind 7. The
// mesh is real -- sentinel 0, kindMask 128, engine ledger `lb` -- and it is the most analytic answer
// available, not the least. CPatch has no such recognition and decomposes the same circle into
// 1206 vertices of patches. That is a shape-recognition win for LB on this family, and it is why
// the same comparison on the QUAD family goes the other way (cpatch 261 verts against lb 1872):
// a 16-segment quad ring is not exactly a circle, so nothing collapses it.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEGS = +(process.env.SEGS || 16),
  SIZE = +(process.env.SIZE || 256),
  N = +(process.env.N || 32);
const SHAPES = +(process.env.SHAPES || 1); // shapes per BUNDLE — the bench's `count` axis
// THE BENCH'S own GEOMETRY, so a case here is the case there: a polar ring of `segments` pieces at
// radius cell*0.38, laid out on a ceil(sqrt(shapes)) grid of 120/side cells offset by 4.
const FAM = process.env.FAMILY || 'quad';
const polar = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
const pathFor = (fam, cx, cy, r, segments) => {
  const n = Math.max(fam === 'line' ? 3 : 4, segments | 0);
  const pts = Array.from({ length: n }, (_, i) =>
    polar(cx, cy, r, -Math.PI / 2 + (i * Math.PI * 2) / n),
  );
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / n,
      b = a + (Math.PI * 2) / n,
      p = pts[(i + 1) % n];
    if (fam === 'line') d += ` L${p[0]} ${p[1]}`;
    else if (fam === 'arc') d += ` A${r} ${r} 0 0 1 ${p[0]} ${p[1]}`;
    else if (fam === 'quad') {
      const cr = r / Math.cos((b - a) / 2),
        c = polar(cx, cy, cr, (a + b) / 2);
      d += ` Q${c[0]} ${c[1]} ${p[0]} ${p[1]}`;
    } else {
      const k = (4 / 3) * Math.tan((b - a) / 4) * r,
        p0 = pts[i],
        c1 = [p0[0] - Math.sin(a) * k, p0[1] + Math.cos(a) * k],
        c2 = [p[0] + Math.sin(b) * k, p[1] - Math.cos(b) * k];
      d += ` C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p[0]} ${p[1]}`;
    }
  }
  return d + ' Z';
};
const ring = () => {
  const side = Math.ceil(Math.sqrt(SHAPES)),
    cell = 120 / side;
  let body = '';
  for (let i = 0; i < SHAPES; i++) {
    const cx = ((i % side) + 0.5) * cell + 4,
      cy = (((i / side) | 0) + 0.5) * cell + 4,
      r = cell * 0.38;
    body += `<path d="${pathFor(FAM, cx, cy, r, SEGS)}" fill="#265b9b"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
};

const PAGE = `<!doctype html><body><canvas id=c width=${SIZE} height=${SIZE}></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
if (${JSON.stringify(process.env.NOSDF || '')}) globalThis.__MANTLE_DEBUG__ = globalThis.__MANTLE_NO_SDF_PRIMS = true;
const svg=${JSON.stringify(ring())};
const COUNT=['drawArrays','drawElements','texSubImage2D','texImage2D','bufferData','bufferSubData',
             'bindTexture','useProgram','uniform1f','uniform4fv','vertexAttribPointer','clear','activeTexture'];
const out={};
for (const [name,opts] of [['cpatch',{cpatchFill:true}],['lb',{}],['slug',{}]]) {
  const r=createRenderer(gl,shaders,opts);
  r.setViewport(${SIZE},${SIZE});
  if(name==='lb') r.setLoopBlinnFill&&r.setLoopBlinnFill('on');
  r.setFillEngine&&r.setFillEngine({route:name==='cpatch'?'cpatch':name});
  const b=createBundle(gl,await importSvg(svg)); r.prepareBundle(b);
  if(name==='cpatch'&&r.awaitEngine){try{await r.awaitEngine(b,'cpatch',60000);}catch{}}
  if(name==='lb'&&r.awaitLbReady){try{await r.awaitLbReady(b,20000);}catch{}}
  const paint=()=>{r.beginFrame([1,1,1,1]); for(let i=0;i<${N};i++) r.drawBundle(b,{}); r.endFrame();};
  paint(); paint();                                    // warm: first frame builds caches
  // CPU SUBMIT TIME, separately from GL counts. 6.65ms over 32 draws is 0.208ms PER DRAW, which is
  // far more than fragment work can account for at 256px -- so time the JS that issues the frame,
  // with no GPU sync in the loop, where the clock is not the GPU's and is far less noisy.
  const cpuSamp=[];
  for(let s2=0;s2<15;s2++){ const t0=performance.now(); for(let i2=0;i2<10;i2++) paint();
    cpuSamp.push((performance.now()-t0)/10); }
  cpuSamp.sort((a,b)=>a-b);
  const saved={}, tally={};
  for(const k of COUNT){ tally[k]=0; saved[k]=gl[k].bind(gl); gl[k]=(...a)=>{tally[k]++; return saved[k](...a);} ; }
  let bytes=0; const sub=gl.texSubImage2D.bind(gl);
  paint();
  for(const k of COUNT) gl[k]=saved[k];
  const e=r.debugStats.engines&&r.debugStats.engines.draws||{};
  // WHAT THE MESHES ACTUALLY ARE. A bundle can hold SENTINEL meshes flagged slug:true, meaning
  // "this shape is not Loop-Blinn geometry, draw it the Slug way". Counting vertices alone cannot
  // tell a real LB mesh from a sentinel, and the engine ledger reports the ROUTE that ran.
  const lbm=(b._lbMeshes||[]);
  out[name]={cpu:cpuSamp[cpuSamp.length>>1], tally,
             drew:Object.keys(e).filter(k=>e[k]>0).map(k=>k+':'+e[k]).join(' ')||'none',
             verts:lbm.reduce((s,m)=>s+((m&&m.vertexCount)|0),0),
             meshes:lbm.length,
             real:lbm.filter(m=>m&&!m.slug&&(m.vertexCount|0)>0).length,
             sentinel:lbm.filter(m=>m&&m.slug).length,
             kindMask:b._lbKindMask|0};
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
await pg.waitForFunction('window.__out', { timeout: 300000 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
const keys = Object.keys(o.cpatch.tally).filter((k) =>
  ['cpatch', 'lb', 'slug'].some((e) => o[e].tally[k] > 0),
);
console.log(
  `\n  ${SEGS}-segment ring, ${N} draws per frame at ${SIZE}px — GL calls in ONE steady-state frame\n`,
);
console.log(
  '    ' + 'call'.padEnd(22) + ['cpatch', 'lb', 'slug'].map((e) => e.padStart(9)).join(''),
);
for (const k of keys)
  console.log(
    '    ' +
      k.padEnd(22) +
      ['cpatch', 'lb', 'slug'].map((e) => String(o[e].tally[k]).padStart(9)).join(''),
  );
console.log(
  '    ' +
    'drew'.padEnd(22) +
    ['cpatch', 'lb', 'slug'].map((e) => String(o[e].drew).padStart(9)).join(''),
);
console.log(
  '    ' +
    'fill verts'.padEnd(22) +
    ['cpatch', 'lb', 'slug'].map((e) => String(o[e].verts).padStart(9)).join(''),
);
console.log(
  '    ' +
    'CPU ms/frame'.padEnd(22) +
    ['cpatch', 'lb', 'slug'].map((e) => o[e].cpu.toFixed(3).padStart(9)).join(''),
);
console.log(
  '    ' +
    'CPU us/draw'.padEnd(22) +
    ['cpatch', 'lb', 'slug'].map((e) => ((o[e].cpu * 1000) / N).toFixed(1).padStart(9)).join(''),
);
for (const k of ['meshes', 'real', 'sentinel', 'kindMask'])
  console.log(
    '    ' +
      ('lbMeshes.' + k).padEnd(22) +
      ['cpatch', 'lb', 'slug'].map((e) => String(o[e][k]).padStart(9)).join(''),
  );
console.log('\n    engine ledger (draws by engine):');
for (const e of ['cpatch', 'lb', 'slug']) console.log(`      ${e.padEnd(7)} ${o[e].drew}`);

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _bandWalkCap — a band holding more than 1024 segments of one type silently loses the rest.
//
// _coverage.glsl walks a band as `for (int i = 0; i < 1024; i++) { if (i >= nLine) break; ... }`.
// The 1024 is a STATIC bound (GLSL wants one); the real exit is the count test. So the bound is
// invisible until a band actually holds more than 1024 segments of a type -- and then the walk
// stops early and every segment past it contributes nothing. No error, no warning: just less ink.
//
// Found via a dense freehand polyline, where the regular stroke path drew 3675 px against the
// incremental path's 6349 on identical geometry in an identical frame. Raising the bound made it
// 6500 and the gap vanished.
//
// This sweeps a dense scribble and reports ink for FILL and STROKE. Ink should grow smoothly with
// density and then FLATTEN (the shape stops changing); a DROP is the cap. Run it against a build
// with the bound raised to see the same curve without the cliff.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 512,
  LENS = (process.env.LENS || '400,800,1200,1600,2400').split(',').map(Number);

const PAGE = `<!doctype html><body><canvas id=c width=${W} height=${W}></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{psoWarmIdle:()=>true});
// IT TAKES A PATH THAT PACKS ONE BAND, not merely a dense one. A spiral at 2400 segments shows no
// drop at all: its segments spread across many bands and no single walk exceeds the bound. This
// wanders HORIZONTALLY across the canvas while oscillating in y, so one band holds a large share of
// the path -- which is what a freehand stroke, a signature or a road actually looks like.
// Ink stays near-constant with N (the region is fixed), so a DROP is the cap and not the shape.
const pts=(n)=>{const P=[];let x=40,y=${W}/2,a=0;
  for(let i=0;i<n;i++){a+=Math.sin(i*0.31)*0.28; x+=Math.cos(a)*1.6+((${W}-80)/n); y+=Math.sin(a)*2.2;
    P.push([Math.max(6,Math.min(${W}-6,x)), Math.max(6,Math.min(${W}-6,y))]);} return P;};
const d=(P)=>'M'+P.map(p=>p[0].toFixed(2)+' '+p[1].toFixed(2)).join('L');
const inkOf=()=>{const px=new Uint8Array(${W}*${W}*4); gl.readPixels(0,0,${W},${W},gl.RGBA,gl.UNSIGNED_BYTE,px);
  let n=0; for(let i=0;i<px.length;i+=4) if(px[i]<200) n++; return n;};
const shot=async(svg)=>{const b=createBundle(gl, await importSvg(svg)); r.prepareBundle(b);
  if(r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  r.setViewport(${W},${W}); for(let w=0;w<3;w++){r.beginFrame([1,1,1,1]); r.drawBundle(b,{}); r.endFrame();}
  const ink=inkOf(); const e=(r.debugStats.engines&&r.debugStats.engines.draws)||{};
  b.dispose&&b.dispose(); return {ink, drew:Object.keys(e).filter(k=>e[k]>0).join('+')};};
const out={};
for (const N of ${JSON.stringify(LENS)}) {
  const P=pts(N);
  // STROKE: the case that exposed this. FILL: the same walk, so it should show the same cliff.
  const st=await shot('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}"><path d="'+d(P)+'" fill="none" stroke="#000" stroke-width="3"/></svg>');
  const fl=await shot('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}"><path d="'+d(P)+' Z" fill="#000"/></svg>');
  out[N]={strokeInk:st.ink, fillInk:fl.ink, drew:st.drew+' / '+fl.drew};
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
console.log('\n  band-walk cap — ink vs segment count (a DROP is the cap, not the shape)');
console.log('    N       stroke ink   fill ink    drew (stroke / fill)');
let ps = null,
  pf = null;
for (const N of LENS) {
  const x = o[N];
  if (!x) continue;
  const ds = ps !== null && x.strokeInk < ps * 0.92 ? '  << STROKE DROPPED' : '';
  const df = pf !== null && x.fillInk < pf * 0.92 ? '  << FILL DROPPED' : '';
  console.log(
    `    ${String(N).padEnd(7)} ${String(x.strokeInk).padStart(9)} ${String(x.fillInk).padStart(11)}    ${x.drew}${ds}${df}`,
  );
  ps = x.strokeInk;
  pf = x.fillInk;
}

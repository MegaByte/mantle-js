// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbTranslucentCheck — the 'auto' gate vetoes ANY translucent fill, but the combined
// route claims to serve translucent SOLIDS exactly ("_ensureLbMeshes builds them as
// CDT PARTITIONS, so the route's direct OVER composites α exactly"). Which is right?
//
// Corpus-wide, fill-opacity appears in 24.1% of SVGs (gradients: 0.09%), so this gate
// — not gradients — is the batching win. Tests OVERLAPPING translucent shapes, where
// painter-order α compositing is actually load-bearing.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 512;
function sheet(K, segs, alpha, overlap) {
  const cols = Math.round(Math.sqrt(K)),
    cell = N / cols,
    r = cell * (overlap ? 0.62 : 0.36);
  let out = '';
  for (let i = 0; i < K; i++) {
    const cx = (i % cols) * cell + cell / 2,
      cy = Math.floor(i / cols) * cell + cell / 2;
    const P = (j) => {
      const a = (j / segs) * 2 * Math.PI;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };
    let d = 'M ' + P(0)[0].toFixed(2) + ' ' + P(0)[1].toFixed(2) + ' ';
    for (let j = 0; j < segs; j++) {
      const A = P(j),
        B = P(j + 1);
      const bx = (B[1] - A[1]) * 0.3,
        by = -(B[0] - A[0]) * 0.3;
      const c1 = [A[0] + (B[0] - A[0]) / 3 + bx, A[1] + (B[1] - A[1]) / 3 + by],
        c2 = [A[0] + (2 * (B[0] - A[0])) / 3 - bx, A[1] + (2 * (B[1] - A[1])) / 3 - by];
      d +=
        'C ' +
        c1[0].toFixed(2) +
        ' ' +
        c1[1].toFixed(2) +
        ' ' +
        c2[0].toFixed(2) +
        ' ' +
        c2[1].toFixed(2) +
        ' ' +
        B[0].toFixed(2) +
        ' ' +
        B[1].toFixed(2) +
        ' ';
    }
    const hue = (i * 37) % 360;
    out += '<path fill="hsl(' + hue + ',60%,50%)" fill-opacity="' + alpha + '" d="' + d + 'Z"/>';
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
    N +
    ' ' +
    N +
    '" width="' +
    N +
    '" height="' +
    N +
    '">' +
    out +
    '</svg>'
  );
}
const CASES = {
  'opaque-16 (control)': sheet(16, 12, 1.0, false),
  'translucent-16': sheet(16, 12, 0.5, false),
  'translucent-16-overlap': sheet(16, 12, 0.5, true),
  'translucent-64-overlap': sheet(64, 8, 0.45, true),
};
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const CASES=${JSON.stringify(CASES)}, N=${N}, K=10;
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const mk=(m)=>{const r=createRenderer(gl,shaders,{}); r.setViewport(N,N); r.setLoopBlinnFill(m); return r;};
const rOff=mk('off'), rOn=mk('on'), rAuto=mk('auto');
const shot=(r,b)=>{r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const px=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); return px;};
const amort=(r,b)=>{const runs=[]; for(let rep=0;rep<7;rep++){
  r.beginFrame([1,1,1,1]); for(let i=0;i<2;i++) r.drawBundle(b); r.endFrame(); sync();
  const t0=performance.now(); r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync();
  runs.push((performance.now()-t0)/K);} runs.sort((a,b)=>a-b); return runs[3];};
const out=[];
try{
for(const [name,svg] of Object.entries(CASES)){
  const b=createBundle(gl, await importSvg(svg));
  for(const r of [rOff,rOn,rAuto]) r.prepareBundle&&r.prepareBundle(b);
  const c0=rOn.debugStats.loopBlinnRouteCount;
  const pxOff=shot(rOff,b), pxOn=shot(rOn,b);
  const routed=rOn.debugStats.loopBlinnRouteCount-c0;
  const cA=rAuto.debugStats.loopBlinnRouteCount; shot(rAuto,b);
  const autoRouted=rAuto.debugStats.loopBlinnRouteCount-cA;
  let mx=0,sum=0; for(let i=0;i<pxOff.length;i++){const d=Math.abs(pxOff[i]-pxOn[i]); if(d>mx)mx=d; sum+=d;}
  const t={off:amort(rOff,b), on:amort(rOn,b)};
  const t2={on:amort(rOn,b), off:amort(rOff,b)};
  out.push({name, combined:!!b._lbCombined, routed, autoRouted,
    maxDiff:mx, meanDiff:sum/pxOff.length,
    off:Math.min(t.off,t2.off), on:Math.min(t.on,t2.on)});
  b.dispose();
}
}catch(e){ window.__err=String(e)+'\\n'+e.stack; }
window.__out=out; window.__ready=true;</script></body></html>`;
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
const port = server.address().port;
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 120000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 180000 });
const err = await pg.evaluate(() => window.__err);
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
if (err) {
  console.error('threw:', err);
  process.exit(1);
}
console.log(
  'case                     combined routed auto | lbOff   lbOn   speedup | meanDiff maxDiff  correct?',
);
// LB and Slug genuinely disagree on cubic AA edges by mean ~2-3 (the 52-bundle sweep
// sees 3.03 on syn-cubic-196), so 1.0 would fail the OPAQUE control too. What matters
// is that translucency does not make it WORSE than the opaque baseline.
const baseline = o[0].meanDiff;
for (const r of o) {
  const okPix = r.meanDiff <= Math.max(3.0, baseline * 1.2);
  console.log(
    `${r.name.padEnd(24)} ${String(r.combined).padStart(8)} ${String(r.routed).padStart(6)} ${String(r.autoRouted).padStart(4)} | ${r.off.toFixed(3)} ${r.on.toFixed(3)}  ${(r.off / r.on).toFixed(2)}x   | ${r.meanDiff.toFixed(4).padStart(8)} ${String(r.maxDiff).padStart(7)}  ${okPix ? 'yes' : 'NO  <-- WRONG'}`,
  );
}

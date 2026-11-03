// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbLoopDecline — do loop cubics decline off LB, and what does that cost?
//
// lbFastMesh and lbPartition send a cubicLoop() segment to the Slug fallback.
// cubicLoopParams already returns the double-point parameters that would split it
// into three loop-free pieces (verified: probes/_cubicLoopSplit.mjs), and LB's
// winding comes from the triangulation, so the degenerate chord that defeats a GWN
// winding is not automatically fatal here.
//
// SPLITTING DOES NOT WORK. Adding the double-point cuts to lbFastMesh's split list DOES
// build meshes and DOES route, and the render is catastrophically wrong (most of the
// loop's ink differs, max 255, against a baseline of ~1020 px).
//
// WHY, and it is the same failure as GWN's in a different costume. The three
// pieces are individually fine — loop-free, each with a valid implicit
// (probes/_cubicLoopSplit.mjs). What does not survive is the ASSEMBLY. The loop body
// [lo,hi] has B(lo) == B(hi): it is a CLOSED sub-contour whose interior is covered
// TWICE (winding 2). Threading it through the rim pushes a duplicate consecutive
// vertex, making a self-touching polygon, and neither the rim nor earcut can express
// a winding-2 region inside an otherwise winding-1 contour.
//
// So cubicLoopParams' docstring is right about the PIECES and wrong about the whole:
// "each of which the ordinary klmn/Bezout crescent + CDT winding renders exactly" holds
// per piece and does not compose. A correct implementation has to promote the loop body
// to its own contour with its own winding contribution — not feed it back into the
// parent rim — which is a different and much larger change than a split.
//
// Reports, per fixture: whether LB routed the shape at all, how many shapes fell
// back, and the pixel agreement against an AAC reference (independent of both).
//
// PROBE TRAP: awaitLbReady must run on THE BUNDLE BEING DRAWN. Awaiting a throwaway
// bundle leaves the drawn one cold, it renders through Slug, and the change reads as
// a perfect no-op — meshes built, pixels byte-identical — so a broken change reads
// as a clean one.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="${d}" fill="#000"/></svg>`;
const CASES = {
  loop: svg('M 120 260 C 380 80, 20 80, 280 260 Z'),
  wideLoop: svg('M 50 300 C 450 60, -50 60, 350 300 Z'),
  asymLoop: svg('M 100 250 C 400 90, 60 120, 240 270 Z'),
  cusp: svg('M 120 280 C 340 60, 120 60, 200 300 Z'),
  plainCubic: svg('M 80 300 C 80 40, 320 40, 320 300 Z'), // control: no loop, must stay on LB
};
CASES.tiger = readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8');
for (const f of ['braid', 'complex_nested', 'slug_logo', 'test_path']) {
  try {
    CASES[f] = readFileSync(path.join(ROOT, '../fixtures/svg/' + f + '.svg'), 'utf8');
  } catch {}
}
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const rLb =createRenderer(gl,shaders,{}); rLb.setLoopBlinnFill('on');
const rRef=createRenderer(gl,shaders,{aacFill:true});
async function shot(r,sec,n){
  const b=createBundle(gl,sec,{preferBezout:(new URL(location.href)).searchParams.get('bez')==='1'});
  r.prepareBundle&&r.prepareBundle(b);
  // Await readiness on THE BUNDLE BEING DRAWN. Awaiting a throwaway bundle leaves
  // this one cold, so it renders through Slug and the LB change is invisible.
  if(r.awaitLbReady) await r.awaitLbReady(b, 20000).catch(()=>{});
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const px=new Uint8Array(n*n*4); gl.readPixels(0,0,n,n,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const st={slugFallback:(b._lbMeshes||[]).filter(m=>m&&m.slug).length,
            meshes:(b._lbMeshes||[]).filter(m=>m&&!m.slug&&m.vertexCount>0).length,
            routed:r.debugStats.loopBlinnRouteCount|0, uni:r.debugStats.unifiedFillDraws|0};
  b.dispose(); return {px,st};
}
window.__run=async(cases,n)=>{
  const out=[];
  for(const [name,s] of Object.entries(cases)){
    const sec=await importSvg(s);
    const A=await shot(rLb,sec,n), B=await shot(rRef,sec,n);
    let ink=0,diff=0,max=0,bad=0;
    for(let i=0;i<A.px.length;i+=4){
      const a=255-A.px[i], b2=255-B.px[i];
      if(b2>8) ink++;
      const d=Math.abs(a-b2); if(d>2){diff++; if(d>max)max=d;}
    }
    out.push({name, ...A.st, ink, diff, max, bad});
  }
  return out;
};
window.__ready=true;
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': mime(pp) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
pg.on('console', (m) => {
  if (m.type() !== 'log') console.log('[' + m.type() + ']', m.text());
});
await pg.goto(`http://127.0.0.1:${server.address().port}/?bez=${process.env.BEZ || '0'}`, {
  waitUntil: 'load',
  timeout: 60000,
});
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
const rows = await pg.evaluate((c) => window.__run(c, 512), CASES);
console.log('fixture           LB meshes  fallback   ink px   diff vs AAC   max   >128px');
for (const r of rows)
  console.log(
    `${r.name.padEnd(17)} ${String(r.meshes).padStart(9)} ${String(r.slugFallback).padStart(9)} ${String(r.ink).padStart(8)} ${String(r.diff).padStart(13)} ${String(r.max).padStart(5)} ${String(r.bad).padStart(7)}`,
  );
await br.close();
server.close();

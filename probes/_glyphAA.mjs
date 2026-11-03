// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _glyphAA — the measurement splitInteriorByCurve exists for, and which no gate covers:
// interior AA on GLYPHS ("the N stem runs, the acute notch tip"), scored absolutely
// against an 8x-supersampled reference.
//
// The whole render suite passes with the interior recursion turned OFF (depth 0), so the suite
// cannot tell us what the 4^depth split buys. Text can. Interior triangles whose pixels sit
// inside a boundary's AA band must ramp; if the face is attached to the wrong feature (or to
// none) it paints solid 1.0 and the glyph gets hard, chunky edges — invisible in an ink or
// mean-diff check, obvious against an 8x reference.
//
// Score = mean |error| on edge pixels /255, plus the count of pixels off by >0.1 coverage.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MANTLE_ROOT
  ? path.resolve(process.env.MANTLE_ROOT)
  : path.resolve(__dirname, '..');
// Use an explicitly supplied font for production-corpus checks; the fetched
// Roboto fixture keeps the probe reproducible in a clean checkout.
const FONT_PATH = process.env.FONT_PATH || path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf');
const FONT_BYTES = Array.from(new Uint8Array(readFileSync(FONT_PATH)));
// N IS THE SIZE THAT MATTERS, not SIZE. setViewport fits the bundle's CONTENT BBOX to the
// viewport, so fontSize only changes the em grid the outline is expressed on -- the glyphs cover
// the same pixels whatever it is, and a SIZE sweep returns the identical numbers four times.
// The rendered size is the canvas.
const N = +(process.env.N || 256),
  SS = +(process.env.SS || 8);
// stems, acute notches, counters, diagonals — the shapes the splitter's comments name.
const TEXT = process.env.TEXT || 'NAWMgo8';
const SIZE = +(process.env.SIZE || 64);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
window.__MANTLE_DEBUG__=true;
if (${!!process.env.NOCHAIN}) globalThis.Worker=undefined;
window.__LB_BAND2_NOCHAIN=${!!process.env.NOCHAIN};   // debug bisect: bands with span-clip-only ends
import { createRenderer, loadShaders, MantleFontAsset, createTextBundle } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, SS=${SS};
const rSlug=createRenderer(gl,shaders,{}); rSlug.setLoopBlinnFill('off');
const rLb  =createRenderer(gl,shaders,{}); rLb.setLoopBlinnFill('on');
// ALL FOUR ENGINES, on the NATIVE text path. Converting glyphs to an SVG to reuse the tiger
// harness tests the importer as much as the engine, and the renderer has a font path of its own;
// this is that path, with the same 8x-supersampled reference the probe already trusted.
const rAac =createRenderer(gl,shaders,{aacFill:true});
const rCp  =createRenderer(gl,shaders,{cpatchFill:true, aacFill:false});
const grab=(w,h)=>{const p=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a=new Float64Array(w*h); for(let i=0;i<w*h;i++) a[i]=p[i*4]; return a;};
const down=(hi,n,ss)=>{const lo=new Float64Array(n*n);
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){ let s=0;
    for(let j=0;j<ss;j++) for(let i=0;i<ss;i++) s+=hi[(y*ss+j)*(n*ss)+(x*ss+i)];
    lo[y*n+x]=s/(ss*ss); } return lo; };
window.__run=async(bytes,text,size)=>{
  const font=new MantleFontAsset(new Uint8Array(bytes));
  const render=async(r,n,px,wantCp)=>{
    const tb=await createTextBundle(gl,{font,text,style:{fontSize:px,fill:[0,0,0,1]}});
    // createTextBundle returns a WRAPPER; the LB meshes live on tb.bundle. Preparing the
    // wrapper silently does nothing and LB never routes (lbVerts=0, lb == slug exactly).
    const bun=tb.bundle||tb;
    r.prepareBundle&&r.prepareBundle(bun);
    // WAIT FOR THE ENGINE THE ARM NAMES. CPatch converts asynchronously and Loop-Blinn builds off
    // the main thread; render before either finishes and the frame is Slug's, so all four arms
    // come back identical to three decimals with routed=0. Without this wait the probe measures
    // Slug four times and reports it as agreement.
    if (wantCp) {
      let w=0; while(bun._cpatchConv==='pending' && w<60000){ await new Promise((z)=>setTimeout(z,5)); w+=5; }
      r.prepareBundle&&r.prepareBundle(bun);
    }
    if (r.awaitLbReady) await r.awaitLbReady(bun);
    r.setViewport(n,n); gl.viewport(0,0,n,n);
    const c0=r.debugStats.loopBlinnRouteCount;
    r.beginFrame([1,1,1,1]); r.drawBundle(tb); r.endFrame();
    const a=grab(n,n);
    let verts=0, sent=0; for(const m of (bun._lbMeshes||[])){ if(m&&m.vertexCount) verts+=m.vertexCount; if(m&&m.slug) sent++; }
    a.verts=verts; a.sent=sent; a.routed=r.debugStats.loopBlinnRouteCount-c0;
    // THE DRAW TALLY, because a fallback renders correctly and an arm that never engaged reports
    // the fallback's numbers under its own name.
    a.draws=JSON.stringify((r.debugStats.engines&&r.debugStats.engines.draws)||{});
    tb.dispose&&tb.dispose(); return a;
  };
  const ref=down(await render(rSlug,N*SS,size*SS),N,SS);
  const s=await render(rSlug,N,size), x=await render(rLb,N,size);
  const aa=await render(rAac,N,size), cp=await render(rCp,N,size,true);
  const err=(a)=>{ let sum=0,nEdge=0,nBad=0,mx=0,nDrop=0,dropMax=0,nOver=0,overMax=0; const worst=[];
    // The edge score excludes solid cells, so track both structural directions:
    // black reference left white is dropout; white reference painted black is
    // overpaint. Testing only the latter and calling it dropout mislabels it.
    for(let i=0;i<a.length;i++){ const r=ref[i];
      if(r<=2){ const d=a[i]-r; if(d>25){ nDrop++; if(d>dropMax) dropMax=d; } }
      else if(r>=253){ const d=r-a[i]; if(d>25){ nOver++; if(d>overMax) overMax=d; } } }
    let nBinary=0;
    for(let i=0;i<a.length;i++){ const r=ref[i]; if(r>2&&r<253){ const d=Math.abs(a[i]-r); sum+=d; if(d>mx)mx=d; if(d>25)nBad++; if(a[i]<=2||a[i]>=253)nBinary++; nEdge++;
      if(d>60) worst.push([i%N, (i/N)|0, Math.round(d), Math.round(a[i]), Math.round(r)]); } }
    worst.sort((p,q)=>q[2]-p[2]);
    return {mean:sum/Math.max(1,nEdge), nBad, nEdge, nBinary, max:mx,
      nDrop, dropMax, nOver, overMax, worst:worst.slice(0,10)}; };
  const tally = { slug:s.draws, aac:aa.draws, lb:x.draws, cpatch:cp.draws };
  return { tally, slug:err(s), aac:err(aa), lb:err(x), cpatch:err(cp),
           lbVerts:x.verts, lbSent:x.sent, lbRouted:x.routed };
};
window.__ready=true;
</script></body></html>`;

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
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((b, t, s) => window.__run(b, t, s), FONT_BYTES, TEXT, SIZE);
await br.close();
server.close();

console.log(
  `  ${path.basename(FONT_PATH)} "${TEXT}" @${SIZE}px  edgePx=${o.lb.nEdge}` +
    `  lbVerts=${o.lbVerts} sentinels=${o.lbSent} routed=${o.lbRouted}`,
);
// One line per engine, same columns, so a regression in any of them is a column and not a rerun.
for (const k of ['slug', 'aac', 'lb', 'cpatch']) {
  const e = o[k];
  console.log(
    `  ${k.padEnd(6)} ${(o.tally[k] || '').padEnd(22)} mean=${e.mean.toFixed(3)} bad=${e.nBad} max=${e.max.toFixed(1)}` +
      `  hard-edge=${e.nBinary}  dropout=${e.nDrop}/${e.dropMax}  overpaint=${e.nOver}/${e.overMax}`,
  );
}
if (process.env.WORST)
  for (const k of ['aac', 'lb', 'cpatch']) {
    if (o[k].worst.length)
      console.log(`  ${k} worst (x,y,d,got,ref): ` + o[k].worst.map((w) => w.join(',')).join('  '));
  }
if (process.env.WORST && o.lb.worst.length)
  console.log('  lb worst (x,y,d,got,ref):', o.lb.worst.map((w) => w.join(',')).join('  '));

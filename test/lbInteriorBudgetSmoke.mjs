// lbInteriorBudgetSmoke — the LB interior mesh must stay small AND keep its glyph AA.
//
// splitInteriorByCurve subdivides interior faces so each one owns at most one boundary feature to
// ramp against. It used to do that with blind midpoint recursions (4^depth on a span failure,
// 3^depth to isolate features), which was the dominant cost of the whole LB build: tiger's 11,089
// earcut triangles became 174,328, and its first build took 1025ms. Faces are now clipped to the
// edge's span (the middle slab fits by construction) and features are isolated in ONE midpoint
// split, at depth 2.
//
// Both halves are gated here on purpose. A vertex budget alone would pass a build that emitted
// nothing and rendered hard edges; an AA bound alone would pass the 10x-geometry recursion this
// replaced. Neither the render suite nor the shape probes catch either: every render smoke passes
// with the recursion entirely OFF, because none of them measures glyph interiors.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROBOTO = Array.from(new Uint8Array(readFileSync(ROOT + '/test/font/fixtures/roboto-regular.ttf')));
const N = 256, SS = 8, SIZE = 64;
const TEXT = 'NAWMgo8';   // stems, acute notches, counters, diagonals, a curved bowl

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
import { createRenderer, loadShaders, MantleFontAsset, createTextBundle } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, SS=${SS};
const rSlug=createRenderer(gl,shaders,{}); rSlug.setLoopBlinnFill('off');
const rLb  =createRenderer(gl,shaders,{}); rLb.setLoopBlinnFill('on');
const grab=(w,h)=>{const p=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a=new Float64Array(w*h); for(let i=0;i<w*h;i++) a[i]=p[i*4]; return a;};
const down=(hi,n,ss)=>{const lo=new Float64Array(n*n);
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){ let s=0;
    for(let j=0;j<ss;j++) for(let i=0;i<ss;i++) s+=hi[(y*ss+j)*(n*ss)+(x*ss+i)];
    lo[y*n+x]=s/(ss*ss); } return lo; };
window.__run=async(bytes,text,size)=>{
  const font=new MantleFontAsset(new Uint8Array(bytes));
  const render=async(r,n,px)=>{
    const tb=await createTextBundle(gl,{font,text,style:{fontSize:px,fill:[0,0,0,1]}});
    // createTextBundle returns a WRAPPER — the LB meshes hang off tb.bundle. Preparing the
    // wrapper is a silent no-op and LB never routes, so LB would score exactly as Slug.
    const bun=tb.bundle||tb;
    r.prepareBundle&&r.prepareBundle(bun);
    r.setViewport(n,n); gl.viewport(0,0,n,n);
    const c0=r.debugStats.loopBlinnRouteCount;
    r.beginFrame([1,1,1,1]); r.drawBundle(tb); r.endFrame();
    const a=grab(n,n);
    let verts=0; for(const m of (bun._lbMeshes||[])) if(m&&m.vertexCount) verts+=m.vertexCount;
    a.verts=verts; a.routed=r.debugStats.loopBlinnRouteCount-c0;
    tb.dispose&&tb.dispose(); return a;
  };
  const ref=down(await render(rSlug,N*SS,size*SS),N,SS);
  const x=await render(rLb,N,size);
  let sum=0,nEdge=0,nBad=0;
  for(let i=0;i<x.length;i++){ const r=ref[i]; if(r>2&&r<253){ const d=Math.abs(x[i]-r); sum+=d; if(d>25)nBad++; nEdge++; } }
  return { mean:sum/Math.max(1,nEdge), nBad, nEdge, verts:x.verts, routed:x.routed };
};
window.__ready=true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((b, t, s) => window.__run(b, t, s), ROBOTO, TEXT, SIZE);
await br.close(); server.close();

let fail = 0;
const ok = (c, m) => c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m));
console.log(`  "${TEXT}" @${SIZE}px: lbVerts=${o.verts}  lb mean=${o.mean.toFixed(3)}/255  bad=${o.nBad}  edgePx=${o.nEdge}`);

ok(o.routed > 0, `LB routed (${o.routed}) — else the numbers below are Slug's, not LB's`);
// GEOMETRY. 3186 verts today; the midpoint recursions gave 35430 for this same text.
ok(o.verts > 0 && o.verts < 9000, `interior mesh stays small (${o.verts} verts < 9000; was 35430)`);
// QUALITY. 5.614/255 today. A build that emitted no ramp faces would blow past this, which is
// exactly what a geometry-only budget would let through.
ok(o.mean < 7.5, `glyph AA holds vs the 8x reference (${o.mean.toFixed(3)} < 7.5 /255)`);
ok(o.nBad < 150, `few pixels off by >0.1 coverage (${o.nBad} < 150)`);

console.log(fail ? `\nLB-INTERIOR-BUDGET FAIL (${fail})` : '\nLB-INTERIOR-BUDGET PASS');
process.exit(fail ? 1 : 0);

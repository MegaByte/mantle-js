// _glyphAA — the measurement splitInteriorByCurve was actually written for, and which no gate
// covers: interior AA on GLYPHS ("the N stem runs, the acute notch tip"), scored absolutely
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
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MANTLE_ROOT
  ? path.resolve(process.env.MANTLE_ROOT)
  : path.resolve(__dirname, '..');
// Use an explicitly supplied font for production-corpus checks; the fetched
// Roboto fixture keeps the probe reproducible in a clean checkout.
const FONT_PATH = process.env.FONT_PATH || path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf');
const FONT_BYTES = Array.from(new Uint8Array(readFileSync(FONT_PATH)));
const N = 256, SS = 8;
// stems, acute notches, counters, diagonals — the shapes the splitter's comments name.
const TEXT = process.env.TEXT || 'NAWMgo8';
const SIZE = +(process.env.SIZE || 64);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
window.__MANTLE_DEBUG__=true;
if (${process.env.PART !== undefined || process.env.CONIC !== undefined || !!process.env.NOCHAIN}) globalThis.Worker=undefined;
window.__LB_BAND2_NOCHAIN=${!!process.env.NOCHAIN};   // debug bisect: bands with span-clip-only ends
${process.env.PART === undefined ? '' : 'globalThis.__LB_PART_CHAIN = ' + (process.env.PART === '1') + ';'}
${process.env.CONIC === undefined ? '' : 'globalThis.__LB_CONIC = ' + (process.env.CONIC === '1') + ';'}
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
    // createTextBundle returns a WRAPPER; the LB meshes live on tb.bundle. Preparing the
    // wrapper silently does nothing and LB never routes (lbVerts=0, lb == slug exactly).
    const bun=tb.bundle||tb;
    r.prepareBundle&&r.prepareBundle(bun);
    r.setViewport(n,n); gl.viewport(0,0,n,n);
    const c0=r.debugStats.loopBlinnRouteCount;
    r.beginFrame([1,1,1,1]); r.drawBundle(tb); r.endFrame();
    const a=grab(n,n);
    let verts=0, sent=0; for(const m of (bun._lbMeshes||[])){ if(m&&m.vertexCount) verts+=m.vertexCount; if(m&&m.slug) sent++; }
    a.verts=verts; a.sent=sent; a.routed=r.debugStats.loopBlinnRouteCount-c0;
    tb.dispose&&tb.dispose(); return a;
  };
  const ref=down(await render(rSlug,N*SS,size*SS),N,SS);
  const s=await render(rSlug,N,size), x=await render(rLb,N,size);
  const err=(a)=>{ let sum=0,nEdge=0,nBad=0,mx=0,nDrop=0,dropMax=0,nOver=0,overMax=0; const worst=[];
    // The edge score excludes solid cells, so track both structural directions:
    // black reference left white is dropout; white reference painted black is
    // overpaint. The old probe tested only the latter and mislabeled it dropout.
    for(let i=0;i<a.length;i++){ const r=ref[i];
      if(r<=2){ const d=a[i]-r; if(d>25){ nDrop++; if(d>dropMax) dropMax=d; } }
      else if(r>=253){ const d=r-a[i]; if(d>25){ nOver++; if(d>overMax) overMax=d; } } }
    let nBinary=0;
    for(let i=0;i<a.length;i++){ const r=ref[i]; if(r>2&&r<253){ const d=Math.abs(a[i]-r); sum+=d; if(d>mx)mx=d; if(d>25)nBad++; if(a[i]<=2||a[i]>=253)nBinary++; nEdge++;
      if(d>60) worst.push([i%N, (i/N)|0, Math.round(d), Math.round(a[i]), Math.round(r)]); } }
    worst.sort((p,q)=>q[2]-p[2]);
    return {mean:sum/Math.max(1,nEdge), nBad, nEdge, nBinary, max:mx,
      nDrop, dropMax, nOver, overMax, worst:worst.slice(0,10)}; };
  return { slug:err(s), lb:err(x), lbVerts:x.verts, lbSent:x.sent, lbRouted:x.routed };
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
const o = await pg.evaluate((b, t, s) => window.__run(b, t, s), FONT_BYTES, TEXT, SIZE);
await br.close(); server.close();

console.log(`  ${WANT} "${TEXT}" @${SIZE}px  edgePx=${o.lb.nEdge}  lbVerts=${o.lbVerts} sentinels=${o.lbSent} routed=${o.lbRouted}`);
console.log(`  slug mean=${o.slug.mean.toFixed(3)} bad=${o.slug.nBad} max=${o.slug.max.toFixed(1)}`);
console.log(`  lb   mean=${o.lb.mean.toFixed(3)} bad=${o.lb.nBad} max=${o.lb.max.toFixed(1)}`);
console.log(`  HARD EDGE CELLS (fractional in 8x reference, binary in render): slug=${o.slug.nBinary} lb=${o.lb.nBinary}`);
console.log(`  STRUCTURAL CELLS (>25/255):`);
console.log(`    slug dropout=${o.slug.nDrop} worst=${o.slug.dropMax} overpaint=${o.slug.nOver} worst=${o.slug.overMax}`);
console.log(`    lb   dropout=${o.lb.nDrop} worst=${o.lb.dropMax} overpaint=${o.lb.nOver} worst=${o.lb.overMax}`);
if (process.env.WORST && o.lb.worst.length) console.log('  lb worst (x,y,d,got,ref):', o.lb.worst.map((w) => w.join(',')).join('  '));

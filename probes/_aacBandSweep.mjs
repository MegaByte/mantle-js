// _aacBandSweep — is the band-count tuning right for AAC, or only for Slug?
//
// pickBandsAxis(n) = clamp(round(sqrt(32n)), 4, 96)  (identical in JS and C#).
// It was tuned for SLUG, whose H-walker casts a ray at exactly y = c.y and so
// reads exactly ONE band. For Slug, more bands is monotonically better: shorter
// per-band lists, no downside.
//
// AAC integrates the whole 1px cell, so it must walk every band the cell touches.
// The fraction of fragment rows whose cell straddles a boundary is ~ bandsY /
// shapeHeightPx, and each straddle costs a second band walk. So AAC pays a cost
// that GROWS with bandsY, and its optimum should sit lower than Slug's.
//
// Sweep bandsY by pinning pickBandsAxis, and measure both engines on a dense
// shape (512 segments) where banding actually matters. Run via _aacBandSweepRun.sh
// which pins the band count, since pickBandsAxis is module-internal.
const N = 512, cx = 256, cy = 256;

function wavy(K, R, amp, lobes) {
  const P = (i) => { const a=(i/K)*2*Math.PI, r=R+amp*Math.sin(lobes*a); return [cx+r*Math.cos(a), cy+r*Math.sin(a)]; };
  let d = '';
  for (let i=0;i<K;i++){
    const A=P(i), B=P(i+1);
    const bx=(B[1]-A[1])*0.55, by=-(B[0]-A[0])*0.55;
    const c1=[A[0]+(B[0]-A[0])/3+bx, A[1]+(B[1]-A[1])/3+by];
    const c2=[A[0]+2*(B[0]-A[0])/3-bx, A[1]+2*(B[1]-A[1])/3-by];
    if(i===0) d+=`M ${A[0].toFixed(3)} ${A[1].toFixed(3)} `;
    d+=`C ${c1[0].toFixed(3)} ${c1[1].toFixed(3)} ${c2[0].toFixed(3)} ${c2[1].toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d+'Z';
}
function gear(K, R, amp, lobes) {
  let d='';
  for(let i=0;i<K;i++){ const a=(i/K)*2*Math.PI, r=R+amp*Math.sin(lobes*a);
    d+=(i?'L ':'M ')+`${(cx+r*Math.cos(a)).toFixed(3)} ${(cy+r*Math.sin(a)).toFixed(3)} `; }
  return d+'Z';
}
// scalloped ring of K small circular arcs — the dense-ARC counterpart to
// wavy(cubic) and gear(line). Small radii are exactly where AAC's old band-chord
// was worst (38/255) and where the exact solve does the most work.
function scallop(K, R, bulge) {
  const P = (i) => { const a=(i/K)*2*Math.PI; return [cx+R*Math.cos(a), cy+R*Math.sin(a)]; };
  let d = '';
  for (let i=0;i<K;i++){
    const A=P(i), B=P(i+1);
    const chord = Math.hypot(B[0]-A[0], B[1]-A[1]);
    const r = (chord/2) * bulge;                  // >= chord/2 so the arc is valid
    if (i===0) d += `M ${A[0].toFixed(3)} ${A[1].toFixed(3)} `;
    d += `A ${r.toFixed(3)} ${r.toFixed(3)} 0 0 ${i%2} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d+'Z';
}
// dense quads too, so every curve type is represented
function quadWave(K, R, amp, lobes) {
  const P = (i) => { const a=(i/K)*2*Math.PI, r=R+amp*Math.sin(lobes*a); return [cx+r*Math.cos(a), cy+r*Math.sin(a)]; };
  let d = '';
  for (let i=0;i<K;i++){
    const A=P(i), B=P(i+1);
    const mx = (A[0]+B[0])/2 + (B[1]-A[1])*0.6, my = (A[1]+B[1])/2 - (B[0]-A[0])*0.6;
    if (i===0) d += `M ${A[0].toFixed(3)} ${A[1].toFixed(3)} `;
    d += `Q ${mx.toFixed(3)} ${my.toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d+'Z';
}
const SHAPES = {
  'wavy-512-cubic': wavy(512, 200, 26, 17),
  'gear-512-line':  gear(512, 200, 26, 17),
  'quad-512':       quadWave(512, 200, 26, 17),
  'scallop-256-arc': scallop(256, 200, 1.05),
  'scallop-32-arc':  scallop(32, 200, 1.05),
};
const SVGS = Object.fromEntries(Object.entries(SHAPES).map(([k,d]) =>
  [k, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#3366cc" d="${d}"/></svg>`]));

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const SVGS = ${JSON.stringify(SVGS)};
const K = 20;
const sync = () => { const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0]; };
const jit = (i)=>[1,0,0,0,1,0,(i%13)*1e-3,0,1];
const rAAC  = createRenderer(gl, shaders, { aacFill: true }); rAAC.setViewport(${N},${N}); rAAC.setLoopBlinnFill('off');
const rSlug = createRenderer(gl, shaders, {});               rSlug.setViewport(${N},${N}); rSlug.setLoopBlinnFill('off');
async function amort(r, svg){
  const b = createBundle(gl, await importSvg(svg)); r.prepareBundle && r.prepareBundle(b);
  let best = 1e9;
  for (let rep = 0; rep < 5; rep++) {
    r.beginFrame([1,1,1,1]); for(let i=0;i<4;i++) r.drawBundle(b,{worldMatrix:jit(i)}); r.endFrame(); sync();
    const t0=performance.now();
    r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(b,{worldMatrix:jit(i)}); r.endFrame(); sync();
    best = Math.min(best, (performance.now()-t0)/K);
  }
  b.dispose(); return best;
}
const out={};
try { for (const k of Object.keys(SVGS)) out[k] = { slug: await amort(rSlug, SVGS[k]), aac: await amort(rAAC, SVGS[k]) }; }
catch(e){ out.err = String(e); }
window.__out=out; window.__ready=true;
</script></body></html>`;

const server = http.createServer((req,res)=>{ try{ if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(HTML);return;} const p=decodeURIComponent(req.url.split('?')[0]); res.writeHead(200,{'content-type':p.endsWith('.glsl')?'text/plain':'text/javascript'}); res.end(readFileSync(path.join(ROOT,p))); }catch{ if(!res.headersSent)res.writeHead(404); res.end(); } });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({headless:'new',args:['--enable-unsafe-swiftshader','--no-sandbox']});
const page=await browser.newPage();
page.on('pageerror',e=>console.error('  [page-err]',e.message));
await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'load',timeout:60000});
await page.waitForFunction(()=>window.__ready===true,{timeout:60000});
const out=await page.evaluate(()=>window.__out);
await browser.close(); server.close();
if (out.err) { console.error('threw:', out.err); process.exit(1); }
const bandsY = process.argv[2] || '?';
for (const k of Object.keys(SHAPES))
  console.log(`bandsY=${String(bandsY).padStart(3)}  ${k.padEnd(16)} slug=${out[k].slug.toFixed(4)}  aac=${out[k].aac.toFixed(4)}  ratio=${(out[k].aac/out[k].slug).toFixed(2)}x`);

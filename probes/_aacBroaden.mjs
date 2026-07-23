// _aacBroaden.mjs — prove AAC is feature-complete enough to REPLACE Slug, beyond
// solid fills: (1) even-odd holes, (2) SELF-INTERSECTION (pentagram) where AAC's
// conflation-free signed area is EXACT and Slug's box filter only approximates,
// (3) gradient paint (AAC replaces coverage only; the paint pipeline is downstream
// and must still work). Rendered in the real renderer with opts.aacFill, LB off.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 200, cx = 100, cy = 100;
// pentagram via 5 outer points connected star-wise (self-intersecting), one subpath
const sp = []; for (let i = 0; i < 5; i++) { const a = -Math.PI/2 + i*4*Math.PI/5; sp.push([cx + 80*Math.cos(a), cy + 80*Math.sin(a)]); }
let dStar = `M ${sp[0][0].toFixed(1)} ${sp[0][1].toFixed(1)} `; for (let i = 1; i < 5; i++) dStar += `L ${sp[i][0].toFixed(1)} ${sp[i][1].toFixed(1)} `; dStar += 'Z';
const SVGS = {
  // even-odd donut: outer circle minus inner circle, fill-rule evenodd
  evenodd: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill-rule="evenodd" fill="#3366cc" d="M20 100 A80 80 0 1 0 180 100 A80 80 0 1 0 20 100 Z M60 100 A40 40 0 1 0 140 100 A40 40 0 1 0 60 100 Z"/></svg>`,
  pentagram_nz: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill-rule="nonzero" fill="#3366cc" d="${dStar}"/></svg>`,
  pentagram_eo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill-rule="evenodd" fill="#3366cc" d="${dStar}"/></svg>`,
  gradient: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#00ff00"/></linearGradient></defs><circle cx="100" cy="100" r="80" fill="url(#g)"/></svg>`,
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const SVGS = ${JSON.stringify(SVGS)};
async function render(svg, aac){
  const sec = await importSvg(svg);
  const r = createRenderer(gl, shaders, aac ? { aacFill: true } : {}); r.setViewport(${N},${N}); r.setLoopBlinnFill('off');
  const b = createBundle(gl, sec); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px); b.dispose(); return Array.from(px);
}
const out={};
try { for (const k of Object.keys(SVGS)) out[k] = { slug: await render(SVGS[k], false), aac: await render(SVGS[k], true) }; }
catch(e){ out.err = String(e); }
window.__out = out; window.__ready = true;
</script></body></html>`;

const server = http.createServer((req,res)=>{ try{ if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(HTML);return;} const p=decodeURIComponent(req.url.split('?')[0]); res.writeHead(200,{'content-type':p.endsWith('.glsl')?'text/plain':'text/javascript'}); res.end(readFileSync(path.join(ROOT,p))); }catch{ if(!res.headersSent)res.writeHead(404); res.end(); } });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({headless:'new',args:['--enable-unsafe-swiftshader','--no-sandbox']});
let out;
try{ const page=await browser.newPage(); page.on('pageerror',e=>console.error('  [page-err]',e.message)); page.on('console',m=>{if(m.type()==='error')console.error('  [console]',m.text());});
  await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'load',timeout:30000}); await page.waitForFunction(()=>window.__ready===true,{timeout:30000}); out=await page.evaluate(()=>window.__out);
}catch(e){ console.error('setup failed:',e.message); await browser.close(); server.close(); process.exit(1); }
await browser.close(); server.close();

let fail=0; const ok=m=>console.log('ok',m); const bad=m=>{fail++;console.error('FAIL',m);};
const at=(px,x,y)=>{ const j=(y*N+x)*4; return [px[j],px[j+1],px[j+2]]; };
const isFill=(c)=>c[2]>120 && c[0]<160;      // #3366cc-ish (blue fill on white)
const isWhite=(c)=>c[0]>245&&c[1]>245&&c[2]>245;
if (out.err) bad('threw: '+out.err);
else {
  // even-odd donut: center (100,100) is inside the HOLE → empty (white) in both
  { const A=out.evenodd.aac; isWhite(at(A,cx,cy)) ? ok('even-odd donut: hole is empty under AAC') : bad('even-odd hole not empty: '+at(A,cx,cy));
    const ring=at(A,cx,cy-60); isFill(ring)?ok('even-odd donut: ring is filled'):bad('ring not filled: '+ring); }
  // pentagram nonzero: center pentagon DOUBLE-wound → FILLED
  { const A=out.pentagram_nz.aac; isFill(at(A,cx,cy)) ? ok('pentagram nonzero: double-wound center FILLED (AAC handles self-intersection)') : bad('pentagram nz center not filled: '+at(A,cx,cy)); }
  // pentagram even-odd: center → EMPTY
  { const A=out.pentagram_eo.aac; isWhite(at(A,cx,cy)) ? ok('pentagram even-odd: double-wound center EMPTY') : bad('pentagram eo center not empty: '+at(A,cx,cy)); }
  // gradient: AAC coverage + gradient paint → left side reddish, right side greenish
  { const A=out.gradient.aac; const L=at(A,cx-60,cy), R=at(A,cx+60,cy);
    (L[0]>L[1] && R[1]>R[0]) ? ok(`gradient paint under AAC: left red ${L}, right green ${R}`) : bad(`gradient wrong: L${L} R${R}`); }
}
console.log(fail?`\nAAC-BROADEN FAIL (${fail})`:`\nAAC-BROADEN PASS`);
process.exit(fail?1:0);

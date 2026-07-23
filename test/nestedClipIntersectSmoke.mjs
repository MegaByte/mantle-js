// nestedClipIntersectSmoke.mjs — nested `clip-path` must INTERSECT, not replace
// (SVG 1.1 §14.3). This is the pdftocairo / Illustrator export shape: an outer
// artboard-bbox `<g clip-path>` wrapping an inner contour clip. Mantle used to
// keep only the innermost clip, silently over-drawing by the outer clip's area.
//
// Two nesting spellings are covered — clip on a nested <g>, and clip on the
// leaf shape inside a clipped <g> — because they resolve through different
// code paths (importWalk.js's stack push vs importWalkShapes.js's leaf read).
// The canvas aspect matches the viewBox, so the browser's own SVG rasterizer
// is a valid pixel reference for the expected intersection.
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path';
import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 400, H = 400;                       // matches the 400x400 viewBox below
const VB = 'viewBox="0 0 400 400" width="400" height="400"';
const OUTER = 'M 0 100 L 400 100 L 400 300 L 0 300 Z';    // horizontal band
const INNER = 'M 100 0 L 300 0 L 300 400 L 100 400 Z';    // vertical band
const FILL  = '<rect x="0" y="0" width="400" height="400" fill="#00ff00"/>';
const docs = {
  outerOnly: `<svg xmlns="http://www.w3.org/2000/svg" ${VB}><defs><clipPath id="a"><path d="${OUTER}"/></clipPath></defs><g clip-path="url(#a)">${FILL}</g></svg>`,
  innerOnly: `<svg xmlns="http://www.w3.org/2000/svg" ${VB}><defs><clipPath id="b"><path d="${INNER}"/></clipPath></defs><g clip-path="url(#b)">${FILL}</g></svg>`,
  nested:    `<svg xmlns="http://www.w3.org/2000/svg" ${VB}><defs><clipPath id="a"><path d="${OUTER}"/></clipPath><clipPath id="b"><path d="${INNER}"/></clipPath></defs><g clip-path="url(#a)"><g clip-path="url(#b)">${FILL}</g></g></svg>`,
  gThenLeaf: `<svg xmlns="http://www.w3.org/2000/svg" ${VB}><defs><clipPath id="a"><path d="${OUTER}"/></clipPath><clipPath id="b"><path d="${INNER}"/></clipPath></defs><g clip-path="url(#a)"><rect x="0" y="0" width="400" height="400" fill="#00ff00" clip-path="url(#b)"/></g></svg>`,
};
const HTML=`<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cnv=document.getElementById('c');
const gl=cnv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const renderer=createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href));
const src={}; const get=async k=>(src[k]=src[k]||await (await fetch('/__v/'+k)).text());
const stat=(d,td)=>{let n=0,x0=1e9,x1=-1,y0=1e9,y1=-1;
  for(let y=0;y<${H};y++)for(let x=0;x<${W};x++){const i=((td?y:${H}-1-y)*${W}+x)*4;
    if(d[i+3]>60&&d[i+1]>80&&d[i]<80){n++;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}}
  return {n,box:n?[x0,y0,x1,y1]:null};};
window.__mantle=async k=>{const imp=await importSvg(await get(k));const b=createBundle(gl,imp);
  if(renderer.awaitLbReady){try{await renderer.awaitLbReady(b);}catch{}}
  renderer.setViewport(${W},${H});renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(b,{worldMatrix:new Float32Array([1,0,0,0,1,0,0,0,1])});renderer.endFrame();
  const px=new Uint8Array(${W}*${H}*4);gl.readPixels(0,0,${W},${H},gl.RGBA,gl.UNSIGNED_BYTE,px);
  const r=stat(px,false); r.clipRows=imp.clipperRows?Object.keys(imp.clipperRows).length:0; return r;};
window.__native=async k=>{const s=await get(k);return new Promise(res=>{
  const c2=document.createElement('canvas');c2.width=${W};c2.height=${H};
  const cx=c2.getContext('2d');const img=new Image();
  img.onload=()=>{cx.drawImage(img,0,0,${W},${H});res(stat(cx.getImageData(0,0,${W},${H}).data,true));};
  img.onerror=()=>res(null);img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(s);});};
window.__ready=true;
</script></body></html>`;
const server=http.createServer((q,r)=>{
  if(q.url==='/'){r.writeHead(200,{'content-type':'text/html; charset=utf-8'});r.end(HTML);return;}
  if(q.url.startsWith('/__v/')){r.writeHead(200,{'content-type':'image/svg+xml'});r.end(docs[q.url.slice(5)]||'');return;}
  const p=decodeURIComponent(q.url.split('?')[0]);
  try{r.writeHead(200,{'content-type':(p.endsWith('.glsl')?'text/plain':'text/javascript')+'; charset=utf-8'});r.end(readFileSync(path.join(ROOT,p)));}
  catch{if(!r.headersSent)r.writeHead(404);r.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({headless:'new',args:['--enable-unsafe-swiftshader','--no-sandbox']});
const page=await browser.newPage();
page.on('pageerror',e=>console.error('  [page-err]',e.message));
await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'load',timeout:60000});
await page.waitForFunction(()=>window.__ready===true,{timeout:120000});
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

for (const k of Object.keys(docs)) {
  const m = await page.evaluate(kk => window.__mantle(kk), k);
  const n = await page.evaluate(kk => window.__native(kk), k);
  if (!n || !m) { fail(`${k}: render produced nothing (mantle=${JSON.stringify(m)} native=${JSON.stringify(n)})`); continue; }
  // Area within 5% AND the same ink bbox (±2px for AA): area alone would let
  // a same-size-but-displaced region pass.
  const areaOk = Math.abs(m.n - n.n) <= n.n * 0.05;
  const boxOk = m.box && n.box && m.box.every((v, i) => Math.abs(v - n.box[i]) <= 2);
  if (areaOk && boxOk) ok(`${k}: ${m.n}px ${JSON.stringify(m.box)} matches native`);
  else fail(`${k}: mantle ${m.n} ${JSON.stringify(m.box)} vs native ${n.n} ${JSON.stringify(n.box)}`);
}

await browser.close(); server.close();
if (failures === 0) console.log('\nNESTED-CLIP-INTERSECT PASS');
else console.log(`\nNESTED-CLIP-INTERSECT FAIL (${failures})`);
process.exit(failures ? 1 : 0);

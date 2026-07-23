import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
if (!process.env.SVG) throw new Error('SVG must name the input asset');
const SVG = readFileSync(process.env.SVG, 'utf8');
const NN=300;
const mk=(flags)=>`<!DOCTYPE html><html><body><script>${flags}</script><canvas id="c" width="${NN}" height="${NN}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(${NN},${NN});
const bundle=createBundle(gl,await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const read=()=>{const px=new Uint8Array(${NN}*${NN}*4); gl.readPixels(0,0,${NN},${NN},gl.RGBA,gl.UNSIGNED_BYTE,px); return px;};
const ink=(px)=>{let n=0;for(let i=0;i<${NN}*${NN};i++){const o=i*4;if(!(px[o+1]-Math.max(px[o],px[o+2])>25))n++;}return n;};
const draw=(m)=>{renderer.setLoopBlinnFill(m);const r0=renderer.debugStats.loopBlinnRouteCount;renderer.beginFrame([0,0.8,0,1]);renderer.drawBundle(bundle);renderer.endFrame();return {ink:ink(read()),routed:renderer.debugStats.loopBlinnRouteCount-r0};};
const s=draw('off'),l=draw('on');
window.__out={slugInk:s.ink,lbInk:l.ink,routed:l.routed}; window.__ready=true;
</script></body></html>`;
const server=http.createServer((req,res)=>{try{
  if(req.url.startsWith('/f')){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(mk(decodeURIComponent(req.url.slice(3))));return;}
  const p=decodeURIComponent(req.url.split('?')[0]);
  res.writeHead(200,{'content-type':p.endsWith('.glsl')?'text/plain':'text/javascript'});res.end(readFileSync(path.join(ROOT,p)));
}catch{if(!res.headersSent)res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const browser=await puppeteer.launch({headless:false,args:['--no-sandbox','--use-angle=metal','--enable-gpu']});
for(const [name,flags] of [['default',''],['PART_CHAIN=false','globalThis.__LB_PART_CHAIN=false;'],['POLYCLIP','globalThis.__LB_POLYCLIP=true;']]){
  const page=await browser.newPage(); page.on('console',m=>{if(m.type()==='error')console.error('['+name+']',m.text());});
  await page.goto(`http://127.0.0.1:${port}/f/${encodeURIComponent(flags)}`,{waitUntil:'load',timeout:20000});
  await page.waitForFunction(()=>window.__ready===true,{timeout:15000});
  const o=await page.evaluate(()=>window.__out);
  console.log(`${name}: Slug=${o.slugInk} LB=${o.lbInk} routed=${o.routed}  ${o.lbInk<o.slugInk*0.8?'UNDER-FILL':'ok'}`);
  await page.close();
}
await browser.close(); server.close();

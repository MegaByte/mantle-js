import { readFileSync } from 'fs'; import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = readFileSync(ROOT + '/examples/tiger.svg','utf8');
const PAGE = `<!DOCTYPE html><body><canvas id=c width=512 height=512></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
// wrap: count the priciest per-draw GL state calls
const COUNT={}; for (const m of ['useProgram','enable','disable','blendFunc','blendEquation','depthFunc','depthMask','bindTexture','activeTexture','uniform1i','uniform2f','uniform4f','drawArrays']) { const orig=gl[m].bind(gl); gl[m]=(...a)=>{COUNT[m]=(COUNT[m]||0)+1; return orig(...a);}; }
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(512,512);
const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(b); await renderer.awaitLbReady(b);
const N = 10;
renderer.beginFrame([1,1,1,1]); for (let i=0;i<N;i++) renderer.drawBundle(b, { worldMatrix:[1,0,0,0,1,0, i*2, i*2, 1] }); renderer.endFrame();
for (const k in COUNT) COUNT[k]=0;   // reset, measure a clean frame
renderer.beginFrame([1,1,1,1]); for (let i=0;i<N;i++) renderer.drawBundle(b, { worldMatrix:[1,0,0,0,1,0, i*2, i*2, 1] }); renderer.endFrame();
const routes = renderer.debugStats ? renderer.debugStats.loopBlinnRouteCount : '?';
window.__out = { COUNT, N, routes, draws: COUNT.drawArrays }; window.__ready=true;
</script></body>`;
const srv=http.createServer((q,r)=>{try{if(q.url==='/'){r.writeHead(200,{'content-type':'text/html'});r.end(PAGE);return;}const p=decodeURIComponent(q.url.split('?')[0]);r.writeHead(200,{'content-type':p.endsWith('.glsl')?'text/plain':'text/javascript'});r.end(readFileSync(path.join(ROOT,p)));}catch{if(!r.headersSent)r.writeHead(404);r.end();}});
await new Promise(x=>srv.listen(0,'127.0.0.1',x)); const port=srv.address().port;
const br=await puppeteer.launch({headless:'new',args:['--no-sandbox','--enable-unsafe-swiftshader']}); const pg=await br.newPage();
pg.on('pageerror',e=>console.error('[pg]',e.message));
await pg.goto('http://127.0.0.1:'+port+'/',{waitUntil:'load',timeout:25000}); await pg.waitForFunction(()=>window.__ready,{timeout:25000});
const o=await pg.evaluate(()=>window.__out);
console.log('drawing tiger x'+o.N+' per frame (LB route x'+o.routes+'), GL calls in one frame:');
for (const [k,v] of Object.entries(o.COUNT).sort((a,b)=>b[1]-a[1])) console.log('  '+String(v).padStart(5)+'  '+k+'  ('+(v/o.N).toFixed(1)+'/draw)');
await br.close(); srv.close();

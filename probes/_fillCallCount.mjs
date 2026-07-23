import { readFileSync } from 'fs'; import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="8" y="8" width="40" height="40" fill="#c33"/><rect x="60" y="8" width="40" height="40" fill="#3c3"/><rect x="8" y="60" width="40" height="40" fill="#33c"/><circle cx="80" cy="80" r="20" fill="#cc3"/></svg>';
const PAGE = `<!DOCTYPE html><body><canvas id=c width=256 height=256></canvas><script type=module>
globalThis.__MANTLE_DEBUG__=true; globalThis.__MANTLE_FORCE_SLUG=true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const C={}; for (const m of ['bindTexture','activeTexture','uniform1i']) { const o=gl[m].bind(gl); gl[m]=(...a)=>{C[m]=(C[m]||0)+1;return o(...a);}; }
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const r = createRenderer(gl, shaders); r.setViewport(256,256);
const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); r.prepareBundle(b);
const N=10;
r.beginFrame([1,1,1,1]); for(let i=0;i<N;i++) r.drawBundle(b); r.endFrame();   // warm
for(const k in C) C[k]=0;
r.beginFrame([1,1,1,1]); for(let i=0;i<N;i++) r.drawBundle(b); r.endFrame();   // measured
window.__out={C,N}; window.__ready=true;
</script></body>`;
const srv=http.createServer((q,r)=>{try{if(q.url==='/'){r.writeHead(200,{'content-type':'text/html'});r.end(PAGE);return;}const p=decodeURIComponent(q.url.split('?')[0]);r.writeHead(200,{'content-type':p.endsWith('.glsl')?'text/plain':'text/javascript'});r.end(readFileSync(path.join(ROOT,p)));}catch{if(!r.headersSent)r.writeHead(404);r.end();}});
await new Promise(x=>srv.listen(0,'127.0.0.1',x)); const port=srv.address().port;
const br=await puppeteer.launch({headless:'new',args:['--no-sandbox','--enable-unsafe-swiftshader']}); const pg=await br.newPage();
pg.on('pageerror',e=>console.error('[pg]',e.message));
await pg.goto('http://127.0.0.1:'+port+'/',{waitUntil:'load',timeout:25000}); await pg.waitForFunction(()=>window.__ready,{timeout:25000});
const o=await pg.evaluate(()=>window.__out);
console.log('Slug fillPass, '+o.N+' draws/frame:  bindTexture='+(o.C.bindTexture||0)+' activeTexture='+(o.C.activeTexture||0)+' uniform1i='+(o.C.uniform1i||0));
await br.close(); srv.close();

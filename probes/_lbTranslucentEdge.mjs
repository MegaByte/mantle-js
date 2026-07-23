// Translucent-rect edge AA: does LB over/under-fill the edge band vs Slug?
// Opaque fills hide edge-coverage error (interior clamps); a translucent fill
// (slot alpha 0.392) exposes an over-fill as a DARKER RING at the perimeter.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// a translucent axis-aligned rect, straight edges only, single shape
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="20" y="30" width="60" height="40" fill="#3070c0" fill-opacity="0.392"/></svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(200, 200);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle);
await renderer.awaitLbReady(bundle);
const readAll = () => { const px = new Uint8Array(200*200*4); gl.readPixels(0,0,200,200,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
// draw over WHITE so translucent fill = visible mid color; premult straight alpha in RGB
const draw = (mode) => { renderer.setLoopBlinnFill(mode);
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame(); return readAll(); };
// sample a horizontal scanline through the rect interior, crossing the LEFT + RIGHT edges,
// and a vertical scanline crossing TOP + BOTTOM. Report per-pixel R (lower R = more fill).
const at = (px,x,yTop) => { const o=((199-yTop)*200+x)*4; return [px[o],px[o+1],px[o+2],px[o+3]]; };
const slug = draw('off'), lb = draw('on');
// interior is well inside; edge bands are near the rect boundary in device px (2x scale: x20->40, x80->160, y30->60(top)->... viewBox y down)
const scanH = (px,yTop) => { const r=[]; for (let x=32;x<=56;x++) r.push([x, at(px,x,yTop)[0]]); return r; };
const prof = (px) => { const out={}; // left edge region x=[32..56] at interior y
  out.leftR = []; for (let x=34;x<=46;x++) out.leftR.push(at(px,x,100)[0]);
  out.interiorR = at(px,100,100)[0];
  // scan the whole left-edge column band, find min R (max fill) vs interior
  let minR=999; for (let x=30;x<=50;x++){ const v=at(px,x,100)[0]; if(v<minR)minR=v; }
  out.leftMinR = minR;
  let minRt=999; for (let y=52;y<=72;y++){ const v=at(px,100,y)[0]; if(v<minRt)minRt=v; } // top edge band
  out.topMinR = minRt;
  let minRb=999; for (let y=128;y<=148;y++){ const v=at(px,100,y)[0]; if(v<minRb)minRb=v; } // bottom edge band
  out.botMinR = minRb;
  return out; };
window.__out = { slug: prof(slug), lb: prof(lb),
  slugRouted: renderer.debugStats.loopBlinnRouteCount };
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req,res)=>{ try{
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(HTML);return;}
  const p=decodeURIComponent(req.url.split('?')[0]);
  res.writeHead(200,{'content-type':p.endsWith('.glsl')?'text/plain':'text/javascript'});res.end(readFileSync(path.join(ROOT,p)));
}catch{if(!res.headersSent)res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({headless:'new',args:['--enable-unsafe-swiftshader','--no-sandbox']});
const page=await browser.newPage();
page.on('pageerror',e=>console.error('[page-err]',e.message));
page.on('console',m=>{if(m.type()==='error')console.error('[console]',m.text());});
await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'load',timeout:15000});
await page.waitForFunction(()=>window.__ready===true,{timeout:10000});
const o=await page.evaluate(()=>window.__out);
console.log('interior R  slug=%d lb=%d  (fill darkens R; equal edges should not go BELOW interior)', o.slug.interiorR, o.lb.interiorR);
console.log('left  edge minR  slug=%d lb=%d', o.slug.leftMinR, o.lb.leftMinR);
console.log('top   edge minR  slug=%d lb=%d', o.slug.topMinR, o.lb.topMinR);
console.log('bot   edge minR  slug=%d lb=%d', o.slug.botMinR, o.lb.botMinR);
console.log('LB over-fill ring? left=%d top=%d bot=%d (interior-minR<0 ⇒ edge DARKER than interior = ring)',
  o.lb.interiorR-o.lb.leftMinR, o.lb.interiorR-o.lb.topMinR, o.lb.interiorR-o.lb.botMinR);
console.log('Slug ring?        left=%d top=%d bot=%d', o.slug.interiorR-o.slug.leftMinR, o.slug.interiorR-o.slug.topMinR, o.slug.interiorR-o.slug.botMinR);
await browser.close(); server.close();

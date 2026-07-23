// Faithful REAL-GPU repro of the translucent HUD slot: draw the captured
// rect (white, alpha 0.392) via drawBundleInstanced with the captured
// anisotropic worldMatrices, LB vs Slug, on ANGLE-Metal, over a DARK bg.
// Saves magnified LB / Slug / diff crops of a slot corner.
import { readFileSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WM3 = [[0.238,0,0,0,0.147,0,-0.475,0.94,1],[0.322,0,0,0,0.147,0,0.105,0.94,1],[0.243,0,0,0,0.147,0,0.689,0.94,1]];
const VW=1800, VH=1768;
// crop a corner region of the first slot (device px), magnify MZ×
const CROP = [250, 1630, 340, 138], MZ = 6;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><path d="M0 0 L100 0 L100 40 L0 40 Z" fill="#ffffff" fill-opacity="0.392"/></svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${VW}" height="${VH}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
if (${process.env.NOCHAIN === '1'}) globalThis.__LB_PART_CHAIN = false;
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(${VW}, ${VH});
globalThis.__EDGE_TAP = [];
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle);
await renderer.awaitLbReady(bundle);
// force a static build on the main thread too (in case awaitLbReady used the worker)
renderer.setLoopBlinnFill('on'); renderer.beginFrame([0,0,0,1]); renderer.drawBundleInstanced(bundle, [{worldMatrix:${JSON.stringify(WM3[0])},alpha:1}], {}); renderer.endFrame();
const edgeTap = (globalThis.__EDGE_TAP||[]).map(es=>es.map(e=>[e.p1[0],e.p1[1],e.p2[0],e.p2[1]]));
const readAll = () => { const px = new Uint8Array(${VW}*${VH}*4); gl.readPixels(0,0,${VW},${VH},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const inst = ${JSON.stringify(WM3)}.map(m=>({ worldMatrix:m, alpha:1 }));
const draw = (mode) => { renderer.setLoopBlinnFill(mode);
  renderer.beginFrame([0.12,0.07,0.04,1]); renderer.drawBundleInstanced(bundle, inst, {}); renderer.endFrame(); return readAll(); };
const slug = draw('off'); const routedSlug = renderer.debugStats.loopBlinnRouteCount;
const lb   = draw('on');  const routedLb   = renderer.debugStats.loopBlinnRouteCount - routedSlug;
let total=0, minx=1e9,miny=1e9,maxx=-1,maxy=-1;
for (let i=0;i<${VW}*${VH};i++){ const o=i*4;
  const d=Math.abs(lb[o]-slug[o])+Math.abs(lb[o+1]-slug[o+1])+Math.abs(lb[o+2]-slug[o+2]);
  if(d>6){ total++; const x=i%${VW}, y=(i/${VW})|0; if(x<minx)minx=x;if(x>maxx)maxx=x;if(y<miny)miny=y;if(y>maxy)maxy=y; } }
const [cx,cy,cw,ch]=${JSON.stringify(CROP)};
function mag(get){ const cv=document.createElement('canvas'); cv.width=cw*${MZ}; cv.height=ch*${MZ}; const ct=cv.getContext('2d');
  const id=ct.createImageData(cw*${MZ},ch*${MZ});
  for(let y=0;y<ch*${MZ};y++)for(let x=0;x<cw*${MZ};x++){ const sx=cx+((x/${MZ})|0), sy=cy+((y/${MZ})|0);
    const so=((${VH}-1-sy)*${VW}+sx)*4; const dd=(y*cw*${MZ}+x)*4; const c=get(so);
    id.data[dd]=c[0];id.data[dd+1]=c[1];id.data[dd+2]=c[2];id.data[dd+3]=255; }
  ct.putImageData(id,0,0); return cv.toDataURL('image/png'); }
const lbUrl=mag(o=>[lb[o],lb[o+1],lb[o+2]]);
const slugUrl=mag(o=>[slug[o],slug[o+1],slug[o+2]]);
const diffUrl=mag(o=>{ const d=Math.abs(lb[o]-slug[o])+Math.abs(lb[o+1]-slug[o+1])+Math.abs(lb[o+2]-slug[o+2]);
  return d>6 ? [Math.min(255,d*4),0,0] : [lb[o],lb[o+1],lb[o+2]]; });
// histogram diff pixels by row (y) and column (x) to locate the diverging edges
const rowH={}, colH={};
for (let i=0;i<${VW}*${VH};i++){ const o=i*4;
  const d=Math.abs(lb[o]-slug[o])+Math.abs(lb[o+1]-slug[o+1])+Math.abs(lb[o+2]-slug[o+2]);
  if(d>6){ const x=i%${VW}, y=(i/${VW})|0; rowH[y]=(rowH[y]||0)+1; colH[x]=(colH[x]||0)+1; } }
const topRows=Object.entries(rowH).sort((a,b)=>b[1]-a[1]).slice(0,12);
const topCols=Object.entries(colH).sort((a,b)=>b[1]-a[1]).slice(0,12);
// numeric scans: pick the diff-bbox center column and row, dump LB vs Slug (green).
const midx = ((minx+maxx)/2)|0, midy=((miny+maxy)/2)|0;
const G=(px,x,yfb)=>px[(yfb*${VW}+x)*4+1];        // RAW framebuffer row (matches histogram)
const vscan=[], hscan=[];
const COLIN=450;                                  // slot-1 interior column (not a gap)
for(let y=miny-5;y<=maxy+5;y++) vscan.push([y, G(lb,COLIN,y), G(slug,COLIN,y)]);
for(let x=minx-4;x<=maxx+4;x++) hscan.push([x, G(lb,x,midy), G(slug,x,midy)]);
window.__out={ routedSlug, routedLb, total, bbox:[minx,miny,maxx,maxy], midx, midy, topRows, topCols, vscan, hscan, edgeTap, lbUrl, slugUrl, diffUrl };
window.__ready=true;
</script></body></html>`;
const server=http.createServer((req,res)=>{ try{
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(HTML);return;}
  const p=decodeURIComponent(req.url.split('?')[0]);
  res.writeHead(200,{'content-type':p.endsWith('.glsl')?'text/plain':'text/javascript'});res.end(readFileSync(path.join(ROOT,p)));
}catch{if(!res.headersSent)res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({headless:false,args:['--no-sandbox','--use-angle=metal','--enable-gpu']});
const page=await browser.newPage();
page.on('pageerror',e=>console.error('[page-err]',e.message));
page.on('console',m=>{if(m.type()==='error')console.error('[console]',m.text());});
await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'load',timeout:20000});
await page.waitForFunction(()=>window.__ready===true,{timeout:15000});
const o=await page.evaluate(()=>window.__out);
console.log('routed slug=%d lb=%d  diff total=%d bbox=%s mid=[%d,%d]', o.routedSlug,o.routedLb,o.total,JSON.stringify(o.bbox),o.midx,o.midy);
console.log('EDGE_TAP assemble() calls:', o.edgeTap.length);
o.edgeTap.forEach((es,i)=>console.log('  assemble#'+i+' edges:', es.map(e=>`(${e[0]},${e[1]})->(${e[2]},${e[3]})`).join('  ')));
console.log('TOP DIFF ROWS (y:count):', o.topRows.map(([y,c])=>y+':'+c).join('  '));
console.log('TOP DIFF COLS (x:count):', o.topCols.map(([x,c])=>x+':'+c).join('  '));
console.log('VSCAN (y: LB Slug Δ) through x=%d:', o.midx);
for(const [y,l,s] of o.vscan) console.log('  y=%d  LB=%d  Slug=%d  Δ=%d', y, l, s, l-s);
console.log('HSCAN (x: LB Slug Δ) through y=%d:', o.midy);
for(const [x,l,s] of o.hscan) if(Math.abs(l-s)>3) console.log('  x=%d  LB=%d  Slug=%d  Δ=%d', x, l, s, l-s);
for(const [k,f] of [['lbUrl','slot_lb.png'],['slugUrl','slot_slug.png'],['diffUrl','slot_diff.png']])
  if(o[k]) writeFileSync('probes/_hudCaptureOut/'+f, Buffer.from(o[k].split(',')[1],'base64'));
console.log('wrote slot_lb.png slot_slug.png slot_diff.png');
await browser.close(); server.close();

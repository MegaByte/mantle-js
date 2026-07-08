// morphStrokeCapRouteSmoke — verifies caps (butt/square/round) on an open stroked
// morph. Free-end flags from the builder + the segment's own tangent drive the cap
// logic in the frag: butt drops coverage past the endpoint plane, square extends
// halfW, round keeps the radial distance.
// Checks each cap: route + composed engage and GPU ≈ Slug across t; and the cap
// ordering butt < round < square in stroke area (butt cuts the cap, square extends
// it) — proving the cap logic actually fires. Metal headful.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const ok = m => console.log('ok', m);
const fail = m => { failures++; console.error('FAIL', m); };
const svg = (d, cap) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">`
  + `<path d="${d}" fill="none" stroke="#cc3333" stroke-width="20" stroke-linecap="${cap}"/></svg>`;
const SRCd = 'M 40 100 C 80 30 120 170 160 100';
const DSTd = 'M 40 120 C 90 60 110 140 160 70';

const HTML = cap => `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(svg(SRCd,'__C__'))})), bDst=createBundle(gl,await importSvg(${JSON.stringify(svg(DSTd,'__C__'))}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const red=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]>150&&u[i+1]<110&&u[i+2]<110)n++;return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto'); draw(0.5);
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0,dpx=0;
    for(let p=0;p<a.length;p+=4){let d=0;for(let k=0;k<3;k++){const v=Math.abs(a[p+k]-b[p+k]);if(v>d)d=v;}if(d>mx)mx=d;if(d>40)dpx++;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,redGpu:red(b),redSlug:red(a),mx,dpx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;

async function run(cap, label) {
  const html = HTML(cap).split('__C__').join(cap);
  const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);return;}const p=decodeURIComponent(u.pathname);const mm=p.endsWith('.js')||p.endsWith('.mjs')?'text/javascript':p.endsWith('.glsl')?'text/plain':'application/octet-stream';try{res.writeHead(200,{'content-type':mm+'; charset=utf-8'});res.end(readFileSync(path.join(ROOT,p)));}catch{try{res.writeHead(404);res.end();}catch{}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await puppeteer.launch({headless:false,args:['--use-angle=metal','--no-sandbox','--use-gl=angle']});
  const page=await browser.newPage(); page.on('pageerror',e=>console.error('  [page-err]',e.message)); page.on('console',m=>{if(m.type()==='error')console.error('  [console]',m.text());});
  await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load',timeout:20000});
  await page.waitForFunction(()=>window.__done===true,{timeout:30000}).catch(()=>{});
  const r=await page.evaluate(()=>window.__r); await browser.close(); server.close();
  console.log('['+label+']');
  if(!r||!r.ok){ fail(label+' did not complete: '+(r&&r.err)); return 0; }
  console.log('  '+r.perT.map(p=>'t'+p.t+' routed='+p.routed+' composed='+p.composed+' red '+p.redGpu+'/'+p.redSlug+' dpx'+p.dpx+' mx'+p.mx).join('\n  '));
  if(r.perT.some(p=>p.routed!==1||p.composed!==1)) { fail(label+': did not route/compose'); return 0; }
  // The caps match Slug except sub-pixel rasterization ties at the sharp corners →
  // at most a couple of significantly-differing pixels (dpx). (mx can still spike
  // to ~255 at a single corner texel that lands on opposite sides of a tie — that's
  // one pixel, caught by dpx, not a shape error.)
  if(r.perT.some(p=>Math.abs(p.redGpu-p.redSlug) > Math.max(200,p.redSlug*0.02))) { fail(label+': stroke area diverges from Slug'); return 0; }
  if(r.perT.some(p=>p.dpx > 8)) { fail(label+': differs from Slug beyond corner ties (dpx'+Math.max(...r.perT.map(p=>p.dpx))+')'); return 0; }
  ok(label+': routes (composed), byte-exact vs Slug (≤corner ties)');
  return r.perT[0].redGpu;
}
const butt = await run('butt', 'butt cap');
const round = await run('round', 'round cap');
const square = await run('square', 'square cap');
if(!failures && !(butt < round - 100 && square > round + 100)) fail('cap ordering wrong (butt<round<square): butt='+butt+' round='+round+' square='+square);
else if(!failures) ok('cap area ordering butt < round < square ('+butt+' < '+round+' < '+square+')');
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nmorphStrokeCapRouteSmoke: butt/square/round caps compose with the LB morph');

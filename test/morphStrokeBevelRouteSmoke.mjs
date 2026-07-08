// morphStrokeBevelRouteSmoke — verifies bevel joins (stroke-linejoin="bevel").
// Both the Slug walk (_slugCoverage strokeBandAccum, line segs) and the GPU morph
// stroke (_strokeMath strokeCapsJoinsDash, curve segs) clip the round corner to
// the bevel chord — the flat line joining the two segments' outer offset points —
// guarded by joinStyle==2 so round/miter/caps are unaffected. A sharp-cornered
// fill=none stroked square morph.
// Checks: (1) bevel routes + composes + ≈ Slug bevel (morph + Slug clips agree,
// else the corners diverge → high mx); (2) bevel has less stroke area than round
// at the corners (the round bulge beyond the chord is gone); (3) bevel isn't
// over-clipped (still has most of the round area). Metal headful.
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
const svg = (d, join) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">`
  + `<path d="${d}" fill="none" stroke="#cc3333" stroke-width="16" stroke-linejoin="${join}" stroke-miterlimit="10"/></svg>`;
const SRCd = 'M 50 50 L 150 50 L 150 150 L 50 150 Z';
const DSTd = 'M 60 40 L 162 64 L 140 160 L 40 138 Z';

const HTML = join => `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(svg(SRCd,'__J__'))})), bDst=createBundle(gl,await importSvg(${JSON.stringify(svg(DSTd,'__J__'))}));
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
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v>mx)mx=v;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,redGpu:red(b),redSlug:red(a),mx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;

async function run(join, label) {
  const html = HTML(join).split('__J__').join(join);
  const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html);return;}const p=decodeURIComponent(u.pathname);const mm=p.endsWith('.js')||p.endsWith('.mjs')?'text/javascript':p.endsWith('.glsl')?'text/plain':'application/octet-stream';try{res.writeHead(200,{'content-type':mm+'; charset=utf-8'});res.end(readFileSync(path.join(ROOT,p)));}catch{try{res.writeHead(404);res.end();}catch{}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await puppeteer.launch({headless:false,args:['--use-angle=metal','--no-sandbox','--use-gl=angle']});
  const page=await browser.newPage(); page.on('pageerror',e=>console.error('  [page-err]',e.message)); page.on('console',m=>{if(m.type()==='error')console.error('  [console]',m.text());});
  await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load',timeout:20000});
  await page.waitForFunction(()=>window.__done===true,{timeout:30000}).catch(()=>{});
  const r=await page.evaluate(()=>window.__r); await browser.close(); server.close();
  console.log('['+label+']');
  if(!r||!r.ok){ fail(label+' did not complete: '+(r&&r.err)); return 0; }
  console.log('  '+r.perT.map(p=>'t'+p.t+' routed='+p.routed+' composed='+p.composed+' red '+p.redGpu+'/'+p.redSlug+' mx'+p.mx).join('\n  '));
  if(r.perT.some(p=>p.routed!==1||p.composed!==1)) { fail(label+': did not route/compose'); return 0; }
  if(r.perT.some(p=>Math.abs(p.redGpu-p.redSlug) > Math.max(500,p.redSlug*0.12))) { fail(label+': stroke area diverges from Slug'); return 0; }
  if(r.perT.some(p=>p.mx > 90)) { fail(label+': diverges from Slug at corners (mx'+Math.max(...r.perT.map(p=>p.mx))+')'); return 0; }
  ok(label+': routes (composed), ≈ Slug');
  return r.perT[0].redGpu;   // t0 red area
}
const bevelRed = await run('bevel', 'bevel join');
const roundRed = await run('round', 'round join (control)');
// Bevel CLIPS the round corner bulge → strictly less stroke area at the 4 corners,
// but only the small circular-segment-beyond-chord per corner (not over-clipped).
if(!failures && !(bevelRed < roundRed - 20)) fail('bevel did not clip below round (chord clip not applied?) bevel='+bevelRed+' round='+roundRed);
else if(!failures && !(bevelRed > roundRed - 600)) fail('bevel OVER-clipped (removed too much) bevel='+bevelRed+' round='+roundRed);
else if(!failures) ok('bevel clips the round corner to the chord ('+bevelRed+' < '+roundRed+', within bound)');
if(failures){ console.error('\\n'+failures+' failure(s)'); process.exit(1); }
console.log('\\nmorphStrokeBevelRouteSmoke: exact bevel joins compose with the LB morph + match Slug');

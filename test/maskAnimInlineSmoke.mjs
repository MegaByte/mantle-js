// maskAnimInlineSmoke.mjs — animated SINGLE-shape <mask> (inline path) +
// animated mask under drawSprite. The single-shape mask is evaluated inline
// in mantle.frag (not the offscreen bake), so it needs transformClipCoord too.
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Single-shape mask (one window) → inline path. Wrapped in sprite 'hero'.
const SHEET = readFileSync(new URL('../examples/smoke/maskAnimInline__SHEET.svg', import.meta.url), 'utf8');

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{premultipliedAlpha:true,preserveDrawingBuffer:true});
const sh = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, sh);
const b = createBundle(gl, await importSvg(${JSON.stringify(SHEET)}));
const ovr = createOverrideTable(gl, b);
const id = new Float32Array([1,0,0,0,1,0,0,0,1]);
window.__hasWin = b.shapeIds.includes('win');
window.__drawWhole = (o) => { r.setViewport(200,100); r.beginFrame([0,0,0,1]); r.drawBundle(b, o?{worldMatrix:id,overrides:ovr}:{worldMatrix:id}); r.endFrame(); };
window.__drawSprite = (o) => { r.setViewport(200,100); r.beginFrame([0,0,0,1]); r.drawSprite(b,'hero', o?{worldMatrix:id,overrides:ovr}:{worldMatrix:id}); r.endFrame(); };
window.__move = (dx) => ovr.set('win',{localPosition:[dx,0]});
window.__px = (x) => { const p=new Uint8Array(4); gl.readPixels(x,50,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return [p[0],p[1],p[2],p[3]]; };
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req,res)=>{ if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(HTML);return;} let p=decodeURIComponent(req.url.split('?')[0]); try{res.writeHead(200,{'content-type':p.endsWith('.glsl')?'text/plain':'text/javascript'});res.end(readFileSync(path.join(ROOT,p)));}catch{if(!res.headersSent)res.writeHead(404);res.end();} });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port = server.address().port;
let failures=0; const ok=m=>console.log('ok '+m); const fail=m=>{failures++;console.error('FAIL: '+m);};
const isOrange=p=>p[0]>180&&p[1]>50&&p[1]<170&&p[2]<70; const isBg=p=>p[0]<60&&p[1]<60&&p[2]<60;
const browser=await puppeteer.launch({headless:'new',args:['--enable-unsafe-swiftshader','--no-sandbox']});
const page=await browser.newPage(); page.on('pageerror',e=>console.error('  [page-err]',e.message));
try { await page.goto('http://127.0.0.1:'+port+'/',{waitUntil:'load',timeout:15000}); await page.waitForFunction(()=>window.__ready===true,{timeout:10000}); }
catch(e){ fail('setup: '+e.message); await browser.close(); server.close(); process.exit(1); }

// Whole-bundle draw: single-shape inline mask animates.
const w = await page.evaluate(()=>{ window.__move(0); window.__drawWhole(true); const a=window.__px(30); window.__move(60); window.__drawWhole(true); return {base:a, at30:window.__px(30), at90:window.__px(90)}; });
if (isOrange(w.base)) ok('inline mask: baseline orange at x=30'); else fail('baseline: '+w.base);
if (isOrange(w.at90)) ok('inline mask: reveal MOVED to x=90 (single-shape mask animates)'); else fail('inline mask frozen, x=90: '+w.at90);
if (isBg(w.at30)) ok('inline mask: old position masked out'); else fail('old pos still revealed: '+w.at30);

// drawSprite: the same animated mask under a sprite subset draw.
const s = await page.evaluate(()=>{ window.__move(0); window.__drawSprite(true); const a=window.__px(30); window.__move(60); window.__drawSprite(true); return {base:a, at30:window.__px(30), at90:window.__px(90)}; });
if (isOrange(s.base)) ok('drawSprite: baseline orange at x=30'); else fail('sprite baseline: '+s.base);
if (isOrange(s.at90)) ok('drawSprite: animated mask reveal MOVED to x=90 (the original sprite bug)'); else fail('sprite mask frozen, x=90: '+s.at90);
if (isBg(s.at30)) ok('drawSprite: old position masked out'); else fail('sprite old pos revealed: '+s.at30);

await browser.close(); server.close();
console.log(failures===0?'\nMASK-ANIM-INLINE PASS':'\nMASK-ANIM-INLINE FAIL ('+failures+')');
process.exit(failures?1:0);

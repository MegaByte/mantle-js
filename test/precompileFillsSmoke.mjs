// precompileFillsSmoke — renderer.precompileFills() warms every loaded bundle's
// fill pipelines up-front so a no-idle game runs on lean variants from frame one.
import { readFileSync } from 'fs'; import http from 'http'; import path from 'path';
import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = p => p.endsWith('.html')?'text/html':(p.endsWith('.js')||p.endsWith('.mjs'))?'text/javascript':p.endsWith('.glsl')?'text/plain':'application/octet-stream';
const server = http.createServer((rq,rs)=>{const u=new URL(rq.url,'http://x');const p=decodeURIComponent(u.pathname==='/'?'/mantleDemo.html':u.pathname);
  try{rs.writeHead(200,{'content-type':mime(p)});rs.end(readFileSync(path.join(ROOT,p)));}catch{try{rs.writeHead(404);rs.end();}catch{}}});
await new Promise(r=>server.listen(0,'127.0.0.1',r)); const port=server.address().port;
const SVGS = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="5" y="5" width="90" height="90" rx="12" fill="#c33"/></svg>`,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#3c6"/><path d="M20 80 Q50 20 80 80 Z" fill="#36c"/></svg>`,
];
const br = await puppeteer.launch({headless:'new',args:['--enable-unsafe-swiftshader','--no-sandbox']});
const pg = await br.newPage(); await pg.setViewport({width:300,height:300});
let fail=0; pg.on('pageerror',e=>{console.error('FAIL page',e.message);fail++;});
await pg.goto(`http://127.0.0.1:${port}/mantleDemo.html`,{waitUntil:'load',timeout:15000});
await pg.waitForFunction(()=>window.__mantleRenderer&&window.__mantleGl,{timeout:10000});
const out = await pg.evaluate(async (SVGS)=>{
  const { importSvg, createBundle } = await import('/src/index.js');
  const gl = window.__mantleGl, renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas'); cnv.width=300; cnv.height=300; renderer.setViewport(300,300);
  const bundles = [];
  for (const s of SVGS) { const b = createBundle(gl, await importSvg(s)); bundles.push(b); renderer.createBundleHandle(b); }
  if (typeof renderer.precompileFills !== 'function') return { err: 'precompileFills not exposed' };
  // draw one frame so bundles enqueue for prewarm, then precompile.
  renderer.beginFrame([1,1,1,1]); for (const b of bundles) renderer.createBundleHandle(b).draw(); renderer.endFrame();
  const warmed = renderer.precompileFills();
  return { warmed, ranClean: true };
}, SVGS);
await br.close(); server.close();
if (out.err) { console.error('FAIL', out.err); process.exit(1); }
if (!(out.warmed >= 0 && out.ranClean)) { console.error('FAIL precompileFills', JSON.stringify(out)); process.exit(1); }
console.log(`precompileFills warmed=${out.warmed} bundles, no errors`);
if (fail) { console.error(`page errors: ${fail}`); process.exit(1); }
console.log('PRECOMPILE-FILLS PASS');

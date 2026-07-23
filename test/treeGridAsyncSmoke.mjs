// treeGridAsyncSmoke — the async GWN tier-3 occupancy grid (auto tree-hard path).
//
// A stroke-covered cubic bundle routes tree-hard (noaa-tree). Its winding tree is
// baked synchronously, but the TIER-3 interior grid (85% of the bake) is RESERVED
// zeroed and filled by a post-load idle pass. Zeroed cells have margin 0 so the
// shader falls through to tier-2 — correct, unaccelerated — until the real cells
// land. This proves: (1) first draw is immediate + correct with a dormant tier-3,
// (2) the idle patch is pixel-identical (dormant == active), and (3) both match a
// Slug reference (the tier-3 skip is output-identical).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 512;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
const ring = (K, cx, cy, r) => Array.from({ length: K }, (_, j) => [cx + r*Math.cos(2*Math.PI*j/K), cy + r*Math.sin(2*Math.PI*j/K)]);
const cubicRing = (K, cx, cy, r) => { const P = ring(K,cx,cy,r); const T=(j)=>{const a=2*Math.PI*j/K;return[-Math.sin(a),Math.cos(a)];}; const h=r*2*Math.PI/K/3;
  let d='M '+P[0][0].toFixed(2)+' '+P[0][1].toFixed(2)+' '; for(let j=0;j<K;j++){const A=P[j],B=P[(j+1)%K],ta=T(j),tb=T(j+1); d+='C '+(A[0]+ta[0]*h).toFixed(2)+' '+(A[1]+ta[1]*h).toFixed(2)+' '+(B[0]-tb[0]*h).toFixed(2)+' '+(B[1]-tb[1]*h).toFixed(2)+' '+B[0].toFixed(2)+' '+B[1].toFixed(2)+' ';} return d+'Z'; };
const cols=4, cell=N/cols; let body='';
for (let i=0;i<16;i++) body += '<path fill="#c0392b" stroke="#111" stroke-width="8" d="'+cubicRing(24,(i%cols)*cell+cell/2,Math.floor(i/cols)*cell+cell/2,cell*0.42)+'"/>';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+N+' '+N+'" width="'+N+'" height="'+N+'">'+body+'</svg>';
const rAuto = createRenderer(gl, shaders, { aacFill: 'auto' }); rAuto.setLoopBlinnFill('off');
const rSlug = createRenderer(gl, shaders, {}); rSlug.setLoopBlinnFill('off');
const grab = () => { const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
const draw = (r, b) => { r.setViewport(N,N); gl.viewport(0,0,N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); const s=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,s); return grab(); };
const diff = (a,b) => { let mx=0,n=0; for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]); if(d>mx)mx=d; if(d>16)n++;} return {mx, n:Math.round(n/4)}; };
window.__run = async () => {
  const secAuto = await importSvg(SVG);           // auto tree-hard → async tier-3
  const hadPending = !!(secAuto.pendingTier3 && secAuto.pendingTier3.length);
  const bAuto = createBundle(gl, secAuto);
  const bSlug = createBundle(gl, await importSvg(SVG, { occupancyGrid: false }));
  const before = draw(rAuto, bAuto);              // tier-3 dormant
  const engine = rAuto.debugStats.autoEngine;
  const slug = draw(rSlug, bSlug);
  await new Promise((res) => { let k=0; const t=()=>{ if(++k>30) return res(); requestAnimationFrame(t); }; requestAnimationFrame(t); });
  await new Promise((res) => setTimeout(res, 300));
  const after = draw(rAuto, bAuto);               // tier-3 active
  return { hadPending, engine, dBeforeAfter: diff(before, after), dBeforeSlug: diff(before, slug), dAfterSlug: diff(after, slug) };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try { if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
    const pp = decodeURIComponent(q.url.split('?')[0]); res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, pp)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate(() => window.__run());
await br.close(); server.close();

let fail = 0;
const ok = (c, m) => c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m));
console.log('  result:', JSON.stringify(o));
ok(o.hadPending, 'auto tree-hard import produced a pending (async) tier-3 grid');
ok(o.engine === 'noaa-tree', `routed tree-hard (got ${o.engine})`);
ok(o.dBeforeSlug.n < 60, `dormant tier-3 render matches Slug (${o.dBeforeSlug.n} px differ >16, max ${o.dBeforeSlug.mx})`);
// The grid skip must be output-identical to the full walk. The winding is integer-exact, so a
// mis-certified cell would flip 0<->255 (caught by n). Allow a 1/255 tolerance on the single worst
// pixel: the two paths compute the AA-transition pixel's coverage through different FP expression
// trees, and swiftshader's codegen rounds one knife-edge pixel nondeterministically by 1 ulp
// (reproducible on HEAD by adding any never-taken branch to renderFillGWNSDF's leaf loop).
ok(o.dBeforeAfter.mx <= 1 && o.dBeforeAfter.n === 0,
   `idle tier-3 patch is pixel-identical (dormant == active, max ${o.dBeforeAfter.mx}, ${o.dBeforeAfter.n} px >16)`);
ok(o.dAfterSlug.n < 60, `active tier-3 render matches Slug (${o.dAfterSlug.n} px differ >16, max ${o.dAfterSlug.mx})`);
console.log(fail ? `\nTREE-GRID-ASYNC FAIL (${fail})` : '\nTREE-GRID-ASYNC PASS');
process.exit(fail ? 1 : 0);

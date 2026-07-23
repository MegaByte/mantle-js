// lbBand2Smoke — guards the LB unified curve band (kind 12, always-on).
//
// Kind-12 replaces the legacy kind-9 bbox strip + kind-8 corner cap zoo for
// integral/rational exterior bands: one primitive per arc owning the exterior
// band AND both end wedges (all non-straight curve–curve corners chain; shallow
// joints use κ≡0 tangent combine so kind-8 is unnecessary).
//
// Asserts: emission (kind-12, no kind-9), corner quality vs 4× AAC, no new
// artifacts on ring / quad-line box.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 192, SS = 4;
const wrap = (d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#000000" d="${d}"/></svg>`;
const wrapHi = (d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N * SS} ${N * SS}" width="${N * SS}" height="${N * SS}"><path fill="#000000" d="${d}"/></svg>`;
function quadRing(n) { const c = n / 2, r = n * 0.36, K = 8;
  const P = (i) => { const a = (i / K) * 2 * Math.PI; return [c + r * Math.cos(a), c + r * Math.sin(a)]; };
  let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
  for (let i = 0; i < K; i++) { const A = P(i), B = P(i + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.35, my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.35;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `; }
  return d + 'Z'; }
function quadLineBox(n) { const a = 0.18 * n, b = 0.82 * n, bulge = 0.14 * n, m = n / 2;
  return `M ${a} ${a} Q ${m} ${a - bulge} ${b} ${a} L ${b} ${b} Q ${m} ${b + bulge} ${a} ${b} Z`; }
function quadStar(n) { const c = n / 2, R = n * 0.42, r = n * 0.19, K = 5; let pts = [];
  for (let i = 0; i < 2 * K; i++) { const a = -Math.PI / 2 + i * Math.PI / K, rad = (i % 2 ? r : R);
    pts.push([c + rad * Math.cos(a), c + rad * Math.sin(a)]); }
  let d = `M ${pts[0][0].toFixed(4)} ${pts[0][1].toFixed(4)} `;
  for (let i = 0; i < 2 * K; i++) { const A = pts[i], B = pts[(i + 1) % (2 * K)];
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.12, my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.12;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `; }
  return d + 'Z'; }
const SHAPES = {
  ring: [wrap(quadRing(N)), wrapHi(quadRing(N * SS))],
  box: [wrap(quadLineBox(N)), wrapHi(quadLineBox(N * SS))],
  star: [wrap(quadStar(N)), wrapHi(quadStar(N * SS))],
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N * SS}" height="${N * SS}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, SS=${SS};
const mkR=(o,lb)=>{const r=createRenderer(gl,shaders,o); r.setLoopBlinnFill(lb); return r;};
const rAac=mkR({aacFill:true},'off'), rLb=mkR({},'on');
const grab=(w,h)=>{const p=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a=new Float64Array(w*h); for(let i=0;i<w*h;i++) a[i]=p[i*4]; return a;};
const render=async (r,svgTxt,n)=>{const b=createBundle(gl,svgTxt);
  r.prepareBundle && r.prepareBundle(b);
  if (r.awaitLbReady) await r.awaitLbReady(b);
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  const c0=r.debugStats.loopBlinnRouteCount;
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const routed=r.debugStats.loopBlinnRouteCount-c0;
  const kinds={};
  for(const m of (b._lbMeshes||[])){ if(!m||!m.verts) continue;
    for(let i=0;i<m.vertexCount;i++){ const k=Math.floor(m.verts[i*24+5]+0.001); kinds[k]=(kinds[k]||0)+1; } }
  const a=grab(n,n); b.dispose(); return {a, routed, kinds};};
const down=(hi,n,ss)=>{const lo=new Float64Array(n*n);
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){ let s=0;
    for(let j=0;j<ss;j++) for(let i=0;i<ss;i++) s+=hi[(y*ss+j)*(n*ss)+(x*ss+i)];
    lo[y*n+x]=s/(ss*ss); } return lo; };
const err=(a,ref)=>{ let sum=0, nEdge=0, nBad=0;
  for(let i=0;i<a.length;i++){ const r=ref[i]; if(r>2 && r<253){ const d=Math.abs(a[i]-r); sum+=d; if(d>25) nBad++; nEdge++; } }
  return {mean:sum/Math.max(1,nEdge), nBad}; };
window.__run = async (shapes) => {
  const out={};
  for(const [name,[svgTxt,svgHi]] of Object.entries(shapes)){
    const IV = { preserveViewport: true };
    const secLo=await importSvg(svgTxt, IV), secHi=await importSvg(svgHi, IV);
    const refR=await render(rAac, secHi, N*SS); const ref=down(refR.a,N,SS);
    const lb=await render(rLb, secLo, N);
    out[name]={ e:err(lb.a,ref), routed:lb.routed, kinds:lb.kinds };
  }
  return out;
};
window.__ready=true;</script></body></html>`;

const server = http.createServer((q, res) => { try { if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; } const pp = decodeURIComponent(q.url.split('?')[0]); res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, pp))); } catch { if (!res.headersSent) res.writeHead(404); res.end(); } });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage(); pg.on('pageerror', e => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000 });
const band2 = await pg.evaluate((s) => window.__run(s), SHAPES);
await pg.close(); await br.close(); server.close();

let fail = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`); if (!ok) fail++; };
for (const n of ['ring', 'box', 'star']) {
  check(band2[n].routed === 1, `${n}: LB routed`);
}
check((band2.star.kinds[12] || 0) > 0, `star emits kind-12 (${band2.star.kinds[12] || 0} verts)`);
check((band2.star.kinds[9] || 0) === 0, `star emits no kind-9 strips (${band2.star.kinds[9] || 0})`);
check((band2.star.kinds[1] || 0) === 0, `star emits no kind-1 crescents (${band2.star.kinds[1] || 0})`);
check((band2.star.kinds[11] || 0) === 0, `star emits no kind-11 (${band2.star.kinds[11] || 0}; integral→kind-5)`);
check((band2.star.kinds[5] || 0) > 0, `star emits kind-5 fill crescents (${band2.star.kinds[5] || 0})`);
check((band2.star.kinds[8] || 0) === 0, `star emits no kind-8 caps (${band2.star.kinds[8] || 0})`);
check(band2.star.e.nBad <= 12, `star bad px small (${band2.star.e.nBad} <= 12)`);
check(band2.star.e.mean < 2.0, `star mean err (${band2.star.e.mean.toFixed(3)} < 2.0 /255)`);
check(band2.ring.e.nBad === 0, `ring zero bad px (${band2.ring.e.nBad})`);
check(band2.ring.e.mean < 0.8, `ring mean err (${band2.ring.e.mean.toFixed(3)} < 0.8 /255)`);
check(band2.box.e.nBad <= 4, `box bad px bounded (${band2.box.e.nBad} <= 4)`);
if (fail) { console.error(`LB-BAND2 FAIL (${fail})`); process.exit(1); }
console.log('LB-BAND2 PASS');

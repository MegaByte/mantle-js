// _band2Census — per-kind vertex census of the kind-12 band fixtures.
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 192;
const wrap = (d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#000000" d="${d}"/></svg>`;
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
const SVGS = { ring: wrap(quadRing(N)), box: wrap(quadLineBox(N)), star: wrap(quadStar(N)) };
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
window.__MANTLE_DEBUG__=true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('on');
window.__run=async(svgs)=>{
  const out=[];
  for(const [name,txt] of Object.entries(svgs)){
    const b=createBundle(gl, await importSvg(txt,{preserveViewport:true})); r.prepareBundle(b);
    const kinds={}; let total=0;
    for(const m of (b._lbMeshes||[])){ if(!m||!m.verts) continue;
      for(let i=0;i<m.vertexCount;i++){ const k=Math.floor(m.verts[i*24+5]+0.001);
        kinds[k]=(kinds[k]||0)+1; total++; } }
    out.push({name, kinds, total}); b.dispose();
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
const o = await pg.evaluate(s => window.__run(s), SVGS);
for (const r of o) console.log(` ${r.name.padEnd(5)} total ${String(r.total).padStart(5)}  kinds ${JSON.stringify(r.kinds)}`);
await br.close(); server.close();

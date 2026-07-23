// _gwnEarlyExit — the GWN early-exit tiers must be OUTPUT-IDENTICAL, not just fast.
// Renders every fixture with the full kernel vs MANTLE_GWN_NOEXIT (tiers 2+3 disabled,
// full-tree walk) and byte-compares. Tier 2 skips only provably-zero contributions (a cut
// subtree's chords/lunes/geometry all lie inside its circle; off-row or left-of-pixel circles
// contribute nothing to a +x-ray crossing count and no AA candidate within cellR); tier 3
// returns the folded 0/1 the full walk would return (certified margin > cellR ⇒ no candidate
// inside the AA window). So ANY byte diff is a bug.
// Scales: 512 (deep interior, gate-heavy), 192 (probe standard), 24 (bandH <= 2*cellR — the
// banding-invalid fallback + gate margins mostly failing).
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const K = 8;
const flower = (n, bulge) => { const c = n / 2, r = n * 0.36;
  const P = (j) => [c + r * Math.cos(2 * Math.PI * j / K), c + r * Math.sin(2 * Math.PI * j / K)];
  let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
  for (let j = 0; j < K; j++) { const A = P(j), B = P(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bulge, my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bulge;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `; }
  return d + 'Z'; };
const tri = (n) => `M ${0.20 * n} ${0.22 * n} L ${0.80 * n} ${0.40 * n} L ${0.34 * n} ${0.82 * n} Z`;
const holed = (n) => { const c = n / 2;
  const ring = (r, bulge, rev) => { const P = (j) => [c + r * Math.cos(2 * Math.PI * (rev ? -j : j) / K), c + r * Math.sin(2 * Math.PI * (rev ? -j : j) / K)];
    let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
    for (let j = 0; j < K; j++) { const A = P(j), B = P(j + 1);
      const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bulge, my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bulge;
      d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `; }
    return d + 'Z '; };
  return ring(n * 0.40, 0.15, false) + ring(n * 0.22, 0.15, true); };
const cubicCircle = (n) => { const c = n / 2, r = n * 0.36, k = 0.5523 * r;
  const P = [[c - r, c], [c, c - r], [c + r, c], [c, c + r]]; let d = `M ${P[0][0]} ${P[0][1]} `;
  for (let i = 0; i < 4; i++) { const A = P[i], B = P[(i + 1) % 4];
    const ta = [-(A[1] - c), (A[0] - c)], tb = [-(B[1] - c), (B[0] - c)];
    d += `C ${(A[0] + ta[0] / r * k).toFixed(4)} ${(A[1] + ta[1] / r * k).toFixed(4)} ${(B[0] - tb[0] / r * k).toFixed(4)} ${(B[1] - tb[1] / r * k).toFixed(4)} ${B[0]} ${B[1]} `; }
  return d + 'Z'; };
const arcCapsule = (n) => { const a = 0.25 * n, b = 0.75 * n, r = 0.18 * n, m = n / 2;
  return `M ${a} ${m - r} L ${b} ${m - r} A ${r} ${r} 0 0 1 ${b} ${m + r} L ${a} ${m + r} A ${r} ${r} 0 0 1 ${a} ${m - r} Z`; };
const eoRings = (n) => { const c = n / 2;
  const ring = (r) => `M ${c - r} ${c} A ${r} ${r} 0 1 1 ${c + r} ${c} A ${r} ${r} 0 1 1 ${c - r} ${c} Z `;
  return ring(n * 0.4) + ring(n * 0.22); };
const SHAPES = [
  ['flower', (n) => `<path fill="#000" d="${flower(n, 0.35)}"/>`],
  ['triangle', (n) => `<path fill="#000" d="${tri(n)}"/>`],
  ['holed ring', (n) => `<path fill="#000" d="${holed(n)}"/>`],
  ['cubic circle', (n) => `<path fill="#000" d="${cubicCircle(n)}"/>`],
  ['arc capsule', (n) => `<path fill="#000" d="${arcCapsule(n)}"/>`],
  ['even-odd rings', (n) => `<path fill="#000" fill-rule="evenodd" d="${eoRings(n)}"/>`],
];
const SIZES = [512, 192, 24];
const wrap = (inner, n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}">${inner}</svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const rFast=createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF']}); rFast.setLoopBlinnFill('off');
const rRef =createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF','MANTLE_GWN_NOEXIT']}); rRef.setLoopBlinnFill('off');
const render=(r,b,n)=>{ r.setViewport(n,n); gl.viewport(0,0,n,n);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const p=new Uint8Array(n*n*4); gl.readPixels(0,0,n,n,gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
window.__run=async(svg,n)=>{
  const sec=await importSvg(svg,{preserveViewport:true,gwnTree:true});
  const b=createBundle(gl,sec);
  const pf=render(rFast,b,n), pr=render(rRef,b,n);
  let diff=0, maxd=0, first=-1;
  for(let i=0;i<n*n;i++){ const d=Math.abs(pf[i*4]-pr[i*4]);
    if(d>0){ diff++; if(d>maxd) maxd=d; if(first<0) first=i; } }
  b.dispose();
  return { diff, maxd, first };
};
window.__ready=true;
</script></body></html>`;
const server = http.createServer((q, res) => { try { if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; } const pp = decodeURIComponent(q.url.split('?')[0]); res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, pp))); } catch { if (!res.headersSent) res.writeHead(404); res.end(); } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage(); pg.on('pageerror', (e) => console.error(' [err]', e.message.slice(0, 400)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });

let fail = 0;
for (const [name, inner] of SHAPES) {
  for (const n of SIZES) {
    const o = await pg.evaluate((s, nn) => window.__run(s, nn), wrap(inner(n), n), n);
    const ok = o.diff === 0;
    if (!ok) fail++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} @${n}: ${o.diff} px differ (max ${o.maxd}${o.first >= 0 ? `, first at ${o.first % n},${(o.first / n) | 0}` : ''})`);
  }
}
await br.close(); server.close();
if (fail) { console.error(`GWN-EARLY-EXIT PARITY FAIL (${fail})`); process.exit(1); }
console.log('GWN-EARLY-EXIT PARITY PASS');

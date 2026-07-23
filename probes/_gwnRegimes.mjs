// _gwnRegimes — WHERE does GWN+SDF win? Real-GPU (headed, ANGLE Metal) fill-cost sweep of
// Slug vs AAC vs GWN+SDF across the axes that separate the architectures:
//   * segment count per shape (the tree's O(log n) far-field vs the bands' per-band lists)
//   * canvas size (per-fragment cost dominance)
//   * shape count (per-draw/per-shape overhead)
//   * curve degree (native quad/cubic/arc handling on all three)
// Timing: fixed-work amortized draws with a readPixels hard sync (ANGLE exposes no GPU timer;
// finish() does not block — the _meshFreeShaderBench precedent). An ink cross-check guards
// against silently-broken renders being timed.
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const flowerPath = (n, K, bulge, cx, cy, r) => {
  const P = (j) => [cx + r * Math.cos(2 * Math.PI * j / K), cy + r * Math.sin(2 * Math.PI * j / K)];
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let j = 0; j < K; j++) {
    const A = P(j), B = P(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bulge, my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bulge;
    d += `Q ${mx.toFixed(3)} ${my.toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d + 'Z';
};
const cubicFlowerPath = (n, K, cx, cy, r) => {
  // smooth closed C-spline through K ring points (tangent = ring tangent)
  const P = (j) => [cx + r * Math.cos(2 * Math.PI * j / K), cy + r * Math.sin(2 * Math.PI * j / K)];
  const T = (j) => { const a = 2 * Math.PI * j / K; return [-Math.sin(a), Math.cos(a)]; };
  const h = r * 2 * Math.PI / K / 3;
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let j = 0; j < K; j++) {
    const A = P(j), B = P(j + 1), ta = T(j), tb = T(j + 1);
    d += `C ${(A[0] + ta[0] * h).toFixed(3)} ${(A[1] + ta[1] * h).toFixed(3)} ${(B[0] - tb[0] * h).toFixed(3)} ${(B[1] - tb[1] * h).toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d + 'Z';
};
const arcRingPath = (n, cx, cy, r) => {
  // full circle as two A arcs + a hole of two A arcs (multi-contour + pure arcs)
  const ri = r * 0.55;
  return `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z ` +
         `M ${cx - ri} ${cy} A ${ri} ${ri} 0 1 0 ${cx + ri} ${cy} A ${ri} ${ri} 0 1 0 ${cx - ri} ${cy} Z`;
};
const wrap = (paths, n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}">${paths.map((d) => `<path fill="#000000" d="${d}"/>`).join('')}</svg>`;

const CASES = [];
for (const n of [256, 1024]) {
  CASES.push(['quads-8    @' + n, n, wrap([flowerPath(n, 8, 0.2, n / 2, n / 2, n * 0.36)], n)]);
  CASES.push(['quads-64   @' + n, n, wrap([flowerPath(n, 64, 0.2, n / 2, n / 2, n * 0.36)], n)]);
  CASES.push(['quads-512  @' + n, n, wrap([flowerPath(n, 512, 0.12, n / 2, n / 2, n * 0.36)], n)]);
  CASES.push(['cubics-64  @' + n, n, wrap([cubicFlowerPath(n, 64, n / 2, n / 2, n * 0.36)], n)]);
  CASES.push(['arcs-holed @' + n, n, wrap([arcRingPath(n, n / 2, n / 2, n * 0.36)], n)]);
  const grid = [];
  for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 8; gx++) {
    grid.push(flowerPath(n, 8, 0.2, (gx + 0.5) * n / 8, (gy + 0.5) * n / 8, n * 0.05));
  }
  CASES.push(['grid-64sh  @' + n, n, wrap(grid, n)]);
}

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="1024" height="1024"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const rSlug=createRenderer(gl,shaders,{}); rSlug.setLoopBlinnFill('off');
const rAac =createRenderer(gl,shaders,{aacFill:true}); rAac.setLoopBlinnFill('off');
const rSdf =createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF']}); rSdf.setLoopBlinnFill('off');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const ink=(n)=>{const p=new Uint8Array(n*n*4); gl.readPixels(0,0,n,n,gl.RGBA,gl.UNSIGNED_BYTE,p);
  let s=0; for(let i=0;i<n*n;i++) s+=255-p[i*4]; return s/255;};
const bench=(r,sec,n)=>{const b=createBundle(gl,sec); r.prepareBundle&&r.prepareBundle(b);
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const inkV=ink(n);
  const K=12, runs=[];
  for(let rep=0;rep<7;rep++){const t0=performance.now();
    r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync();
    runs.push((performance.now()-t0)/K);}
  runs.sort((a,b)=>a-b); b.dispose();
  return { ms: runs[3], ink: inkV };
};
window.__run=async(cases)=>{
  const out=[];
  for(const [name,n,svg] of cases){
    const sec=await importSvg(svg,{preserveViewport:true});
    const secG=await importSvg(svg,{preserveViewport:true,gwnTree:true});
    const slug=bench(rSlug,sec,n), aac=bench(rAac,sec,n), sdf=bench(rSdf,secG,n);
    out.push({name, n, slug, aac, sdf});
  }
  return out;
};
window.__ready=true;
</script></body></html>`;
const server = http.createServer((q, res) => { try { if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; } const pp = decodeURIComponent(q.url.split('?')[0]); res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, pp))); } catch { if (!res.headersSent) res.writeHead(404); res.end(); } });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await puppeteer.launch({ headless: false, args: ['--no-sandbox', '--use-angle=metal'] });
const pg = await br.newPage(); pg.on('pageerror', (e) => console.error(' [err]', e.message.slice(0, 300)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((c) => window.__run(c), CASES);
await br.close(); server.close();
console.log('\n  fill cost, ms/draw (readback-synced, median of 7x12 draws) — real GPU (ANGLE Metal)\n');
console.log('  case              |   Slug     AAC   GWN+SDF |  SDF/AAC  SDF/Slug | ink drift');
for (const r of o) {
  const drift = Math.max(Math.abs(r.sdf.ink - r.slug.ink), Math.abs(r.aac.ink - r.slug.ink)) / Math.max(r.slug.ink, 1);
  console.log(`  ${r.name.padEnd(17)} | ${r.slug.ms.toFixed(3).padStart(6)}  ${r.aac.ms.toFixed(3).padStart(6)}  ${r.sdf.ms.toFixed(3).padStart(7)} | ${(r.sdf.ms / r.aac.ms).toFixed(2).padStart(8)}  ${(r.sdf.ms / r.slug.ms).toFixed(2).padStart(8)} | ${(drift * 100).toFixed(2)}%`);
}

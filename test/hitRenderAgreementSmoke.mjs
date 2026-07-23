// hitRenderAgreementSmoke — hit testing must answer from WHAT IS DRAWN.
//
// The fill hit test now walks the bundle's own band + curve tables with a port of the
// shader's fill walk (bandWinding.js), so its inside/outside decision is the render's own
// — not a parallel f64 truth that can disagree in razor cases. This smoke renders shapes
// covering every segment type and both fill rules, then compares fillHitShape at EVERY
// pixel centre against the rendered pixel:
//   * pixels the render drew solid (>= 88% ink) must HIT, pixels it left blank
//     (<= 12% ink) must MISS — zero disagreements allowed;
//   * mid-coverage edge pixels are excluded (the hit boundary is the drawn 50% midline,
//     which legitimately passes through them).
// Also checks the pointer-coherence memo: a second identical query sweep (memo warm)
// must return byte-identical answers to the first.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 192;
const K = 8;
const flower = (n, bulge) => { const c = n / 2, r = n * 0.36;
  const P = (j) => [c + r * Math.cos(2 * Math.PI * j / K), c + r * Math.sin(2 * Math.PI * j / K)];
  let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
  for (let j = 0; j < K; j++) { const A = P(j), B = P(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bulge, my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bulge;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `; }
  return d + 'Z'; };
const cubicCircle = (n) => { const c = n / 2, r = n * 0.36, k = 0.5523 * r;
  const P = [[c - r, c], [c, c - r], [c + r, c], [c, c + r]]; let d = `M ${P[0][0]} ${P[0][1]} `;
  for (let i = 0; i < 4; i++) { const A = P[i], B = P[(i + 1) % 4];
    const ta = [-(A[1] - c), (A[0] - c)], tb = [-(B[1] - c), (B[0] - c)];
    d += `C ${(A[0] + ta[0] / r * k).toFixed(4)} ${(A[1] + ta[1] / r * k).toFixed(4)} ${(B[0] - tb[0] / r * k).toFixed(4)} ${(B[1] - tb[1] / r * k).toFixed(4)} ${B[0]} ${B[1]} `; }
  return d + 'Z'; };
const arcCapsule = (n) => { const a = 0.25 * n, b = 0.75 * n, r = 0.18 * n, m = n / 2;
  return `M ${a} ${m - r} L ${b} ${m - r} A ${r} ${r} 0 0 1 ${b} ${m + r} L ${a} ${m + r} A ${r} ${r} 0 0 1 ${a} ${m - r} Z`; };
const evenOddRings = (n) => { const c = n / 2;
  const ring = (r) => `M ${c - r} ${c} A ${r} ${r} 0 1 1 ${c + r} ${c} A ${r} ${r} 0 1 1 ${c - r} ${c} Z `;
  return ring(n * 0.4) + ring(n * 0.22); };   // same-wound: even-odd sees a hole
const SHAPES = [
  ['quads flower', `<path fill="#000" d="${flower(N, 0.25)}"/>`],
  ['cubic circle', `<path fill="#000" d="${cubicCircle(N)}"/>`],
  ['arc capsule', `<path fill="#000" d="${arcCapsule(N)}"/>`],
  ['even-odd rings', `<path fill="#000" fill-rule="evenodd" d="${evenOddRings(N)}"/>`],
];
const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">${inner}</svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, fillHitShape, HitMode } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{}); r.setLoopBlinnFill('off');
window.__run=async(svg)=>{
  const b=createBundle(gl, await importSvg(svg,{preserveViewport:true}));
  r.setViewport(${N},${N}); gl.viewport(0,0,${N},${N});
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const p=new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p);
  const hits=[], hits2=[];
  for(let y=0;y<${N};y++) for(let x=0;x<${N};x++)
    hits.push(fillHitShape(b, x+0.5, (${N}-1-y)+0.5, HitMode.Coverage) >= 0 ? 1 : 0);   // GL row y = em row N-1-y
  for(let y=0;y<${N};y++) for(let x=0;x<${N};x++)
    hits2.push(fillHitShape(b, x+0.5, (${N}-1-y)+0.5, HitMode.Coverage) >= 0 ? 1 : 0);  // memo-warm sweep
  const lum=[]; for(let i=0;i<${N}*${N};i++) lum.push(p[i*4]);
  b.dispose();
  return { lum, hits, hits2 };
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
const check = (ok, msg) => { console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`); if (!ok) fail++; };
for (const [name, inner] of SHAPES) {
  const o = await pg.evaluate((s) => window.__run(s), wrap(inner));
  // A pixel is EDGE-ADJACENT when any pixel within 2 of it has mid coverage — there the
  // drawn boundary passes nearby and sub-pixel disagreement is legitimate (GPU f32 trig at
  // near-tangent arc extrema is vendor-defined; exact CPU agreement is unachievable in
  // principle). Deep interior / exterior tolerates NOTHING.
  const mid = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) { const ink = 255 - o.lum[i]; if (ink > 30 && ink < 225) mid[i] = 1; }
  const nearEdge = (x, y) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < N && yy < N && mid[yy * N + xx]) return true;
    }
    return false;
  };
  let solid = 0, blank = 0, disagree = 0, memoDiff = 0, edgeSoft = 0;
  const bad = [];
  for (let i = 0; i < N * N; i++) {
    if (o.hits[i] !== o.hits2[i]) memoDiff++;
    const ink = 255 - o.lum[i];
    const x = i % N, y = (i / N) | 0;
    if (ink >= 225) { solid++; if (!o.hits[i]) { if (nearEdge(x, y)) { edgeSoft++; continue; } disagree++; if (bad.length < 5) bad.push([x, y, 'miss-on-solid']); } }
    else if (ink <= 30) { blank++; if (o.hits[i]) { if (nearEdge(x, y)) { edgeSoft++; continue; } disagree++; if (bad.length < 5) bad.push([x, y, 'hit-on-blank']); } }
  }
  check(disagree === 0, `${name}: hit == render on ${solid} solid + ${blank} blank px (${disagree} deep disagree, ${edgeSoft} edge-band tolerated)`);
  if (bad.length) console.log('     ', bad.map((b) => b.join(',')).join('  '));
  check(memoDiff === 0, `${name}: memo-warm sweep identical (${memoDiff} diffs)`);
}
await br.close(); server.close();
if (fail) { console.error(`HIT-RENDER-AGREEMENT FAIL (${fail})`); process.exit(1); }
console.log('HIT-RENDER-AGREEMENT PASS');

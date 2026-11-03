// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _bandCost — decide the LB architecture question with numbers instead of a prior.
//
// LB's AA machinery (kinds 3/8/9/10/11 + dilation/clips/spans/caps/rings/healCracks) exists only
// because we want analytic coverage under single-pass OVER compositing. Two alternatives lose
// on cost: INVERSION (LB paints the interior, Slug's exact walker paints the band) and a
// COMPOSITE PASS (accumulate distance, convert once).
//
// Since then Slug's kernel became exactBoxCov (band fragments got MORE expensive → hurts
// inversion) and LB grew rings/strips (its own band fragments got more expensive → helps it).
// So re-price it. The decision needs three numbers per engine, not one:
//
//   ms(N) = FIXED (per-draw, resolution-independent) + SLOPE * fragments(N)
//
// Render the same bundle at N and 2N (4x the fragments) and solve for both. Then:
//
//   predicted inversion = LB_fixed + LB_slope*interiorPx + Slug_slope*bandPx + Slug_fixed
//
// bandPx / inkPx is the fraction that decides everything: inversion pays Slug's slope only on
// band fragments, and Slug's slope is the expensive one.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// three regimes. The band fraction is a property of shape SIZE and curve density, so each
// stresses a different point: tiger = many mid-size cubic shapes, flowers = quad arcs,
// bigDisc = interior-dominated, smallShapes = text-like (nearly all band).
const flowers = (n, count, r) => {
  const parts = [];
  const cols = Math.ceil(Math.sqrt(count));
  const cell = n / cols;
  for (let i = 0; i < count; i++) {
    const cx = (i % cols) * cell + cell / 2,
      cy = Math.floor(i / cols) * cell + cell / 2,
      K = 8;
    const P = (j) => [
      cx + r * Math.cos((2 * Math.PI * j) / K),
      cy + r * Math.sin((2 * Math.PI * j) / K),
    ];
    let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
    for (let j = 0; j < K; j++) {
      const A = P(j),
        B = P(j + 1);
      const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.35,
        my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.35;
      d += `Q ${mx.toFixed(3)} ${my.toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
    }
    parts.push(`<path fill="#204080" d="${d}Z"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}">${parts.join('')}</svg>`;
};
const disc = (n) => {
  const c = n / 2,
    r = n * 0.45,
    k = 0.5523 * r;
  const P = [
    [c - r, c],
    [c, c - r],
    [c + r, c],
    [c, c + r],
  ];
  let d = `M ${P[0][0]} ${P[0][1]} `;
  for (let i = 0; i < 4; i++) {
    const A = P[i],
      B = P[(i + 1) % 4];
    const ta = [-(A[1] - c), A[0] - c],
      tb = [-(B[1] - c), B[0] - c];
    d += `C ${(A[0] + (ta[0] / r) * k).toFixed(3)} ${(A[1] + (ta[1] / r) * k).toFixed(3)} ${(B[0] - (tb[0] / r) * k).toFixed(3)} ${(B[1] - (tb[1] / r) * k).toFixed(3)} ${B[0]} ${B[1]} `;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#204080" d="${d}Z"/></svg>`;
};

const CASES = {
  'tiger (cubic)': readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8'),
  'flowers x120 (quad)': flowers(512, 120, 16),
  'bigDisc (interior)': disc(512),
  'smallShapes x400 (text-like)': flowers(512, 400, 7),
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="1024" height="1024"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const rSlug=createRenderer(gl,shaders,{}); rSlug.setLoopBlinnFill('off');
const rLb  =createRenderer(gl,shaders,{}); rLb.setLoopBlinnFill('on');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const timeDraw=(r,sec,n)=>{
  const b=createBundle(gl,sec); r.prepareBundle&&r.prepareBundle(b);
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  const K=6, runs=[];
  for(let rep=0;rep<9;rep++){
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
    const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b);
    r.endFrame(); sync(); runs.push((performance.now()-t0)/K);
  }
  const routed=r.debugStats.loopBlinnRouteCount;
  b.dispose(); runs.sort((a,b)=>a-b); return {ms:runs[4], routed};
};
// band = pixels the AA ramp touches; ink = pixels the shape covers at all.
// Counted from the SLUG render (engine-independent ground truth for "what is a band pixel").
const census=(sec,n)=>{
  const b=createBundle(gl,sec); rSlug.setViewport(n,n); gl.viewport(0,0,n,n);
  rSlug.beginFrame([1,1,1,1]); rSlug.drawBundle(b); rSlug.endFrame();
  const p=new Uint8Array(n*n*4); gl.readPixels(0,0,n,n,gl.RGBA,gl.UNSIGNED_BYTE,p);
  // The canvas clears to OPAQUE white, so alpha is 255 everywhere — read LUMINANCE against the
  // white background instead. Shapes are dark (#204080 / tiger's palette), so lum < 253 = touched.
  let ink=0, band=0;
  for(let i=0;i<n*n;i++){ const lum=p[i*4];
    if(lum<253){ ink++; } }
  // band: a pixel whose neighborhood straddles the boundary. Partial coverage against white
  // shows as lum strictly between the shape's solid value and 255 — but shapes have many colors,
  // so detect the boundary GEOMETRICALLY: a touched pixel with an untouched 4-neighbor, dilated
  // by 1px (the AA ramp is ~1px either side).
  const touched=new Uint8Array(n*n);
  for(let i=0;i<n*n;i++) touched[i] = p[i*4]<253 ? 1 : 0;
  for(let y=1;y<n-1;y++) for(let x=1;x<n-1;x++){ const i=y*n+x;
    const t=touched[i], l=touched[i-1], r2=touched[i+1], u=touched[i-n], d2=touched[i+n];
    if(t!==l || t!==r2 || t!==u || t!==d2) band++; }
  b.dispose(); return {ink, band};
};
window.__run=async(cases,N1,N2)=>{
  const out=[];
  for(const [name,txt] of Object.entries(cases)){
    const sec=await importSvg(txt);
    const c1=census(sec,N1);
    const s1=timeDraw(rSlug,sec,N1), s2=timeDraw(rSlug,sec,N2);
    const l1=timeDraw(rLb,sec,N1),   l2=timeDraw(rLb,sec,N2);
    out.push({name, ink:c1.ink, band:c1.band, lbRouted:l1.routed,
              slug:[s1.ms,s2.ms], lb:[l1.ms,l2.ms]});
  }
  return out;
};
window.__ready=true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const N1 = 256,
  N2 = 512;
const o = await pg.evaluate((c, a, b) => window.__run(c, a, b), CASES, N1, N2);
await br.close();
server.close();

console.log(`\nms = FIXED + SLOPE*fragments.  Solved from N=${N1} and N=${N2} (4x fragments).`);
console.log('band/ink measured at N=' + N1 + '. slope in ns per fragment.\n');
console.log(
  'case                          band/ink |  Slug fixed  slope |   LB fixed  slope | LB/Slug',
);
for (const r of o) {
  // ms(N) = F + S*f ; ms(2N) = F + S*4f  =>  S = (ms2-ms1)/(3f), F = ms1 - S*f
  const f = r.ink; // fragments ~ ink px at N1 (both engines rasterize ~the shape)
  const sS = (r.slug[1] - r.slug[0]) / (3 * f),
    sF = r.slug[0] - sS * f;
  const lS = (r.lb[1] - r.lb[0]) / (3 * f),
    lF = r.lb[0] - lS * f;
  const bf = r.band / Math.max(1, r.ink);
  const ns = (ms) => (ms * 1e6).toFixed(1);
  console.log(
    `${r.name.padEnd(28)} ${(bf * 100).toFixed(1).padStart(6)}% | ${sF.toFixed(3).padStart(9)}ms ${ns(sS).padStart(6)} | ${lF.toFixed(3).padStart(8)}ms ${ns(lS).padStart(6)} | ${(r.lb[0] / r.slug[0]).toFixed(2)}x`,
  );
}
console.log('\n--- predicted INVERSION (LB interior + Slug band) at N=' + N1 + ' ---');
console.log('case                          LB now   inversion   verdict');
for (const r of o) {
  const f = r.ink;
  const sS = (r.slug[1] - r.slug[0]) / (3 * f),
    sF = r.slug[0] - sS * f;
  const lS = (r.lb[1] - r.lb[0]) / (3 * f),
    lF = r.lb[0] - lS * f;
  // inversion still pays LB's fixed cost (same mesh, same draw) + Slug's fixed cost (band pass
  // needs the band/curve buffers bound) + LB slope on interior + Slug slope on band.
  const inv = lF + sF + lS * (r.ink - r.band) + sS * r.band;
  const win = inv < r.lb[0];
  console.log(
    `${r.name.padEnd(28)} ${r.lb[0].toFixed(3)}ms ${inv.toFixed(3)}ms   ${win ? 'INVERSION WINS' : 'lb wins by ' + ((inv / r.lb[0] - 1) * 100).toFixed(0) + '%'}`,
  );
}
console.log(
  '\n(LB fixed cost is per-DRAW; a negative fixed cost means the fragment model does not',
);
console.log(' fit — that engine is not fragment-bound at this size, which is itself the answer.)');

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _gwnSampledAaQuality — would SAMPLED winding AA (Li 2016 style) be good enough?
//
// probes/_gwnAaCeiling.mjs measured the prize: GWN's AA machinery (the two nearest
// candidates, their ranking, the ramp) is 21-26% of GWN fill cost. A sampled-winding
// AA would delete all of it. The CERTAIN cost is accuracy — sampled coverage is
// quantized to K+1 levels where the ramp is continuous.
//
// Test the accuracy WITHOUT writing the kernel: K-sample winding AA is exactly
// K-times supersampling of the winding-only kernel. So render MANTLE_HARD_TREE
// (binary winding, no ramp) at SxS and box-downsample -> that IS S^2-sample winding
// AA. Score it, and the shipping SDF AA, against an 8x AAC reference.
//
// RESULT (error /255 vs 8x AAC, mean). S=1 is the no-AA control; `arms differ`
// guards against a fixture whose route ignores the forced defines, where both arms
// are the same program and every number on the row means nothing:
//
//              SDF AA   NO AA   4-samp   9-samp   16-samp   arms differ
//   petals      0.047   0.900    0.317    0.174     0.118   yes
//   loop        0.094   0.559    0.209    0.136     0.119   yes
//   cusp        0.070   0.662    0.218    0.136     0.095   yes
//   fatcubic    0.038   0.503    0.181    0.105     0.069   yes
//   circle      0.052   0.052    0.017    0.009     0.005   NO - VACUOUS
//
// THE CIRCLE ROW IS NOT A RESULT. A <circle> takes a primitive route that ignores
// MANTLE_HARD/MANTLE_HARD_TREE, so rSdf and rWind render byte-identically there and
// the "4-sample beats the ramp" reading is just "supersampling any kernel 4x beats
// it at 1x". Keep the arm-difference column: without it this fixture produced a
// confident, wrong conclusion about the ramp having a systematic curve bias.
//
// Sampling converges monotonically and beats no-AA everywhere the arms are real,
// which is the sanity check that says the harness works.
//
// SAMPLED WINDING: NO. It beats the ramp on smooth curves (circle) and loses
// everywhere corners or self-crossings appear — including the cusp/loop class it
// would need to rescue. Combined with probes/_gwnAaCeiling.mjs (the AA machinery is
// only 21-26% of GWN fill), there is no version of this that pays.
//
// WHAT IT DOES SHOW — the type-6 penalty is real. A cusp/loop cubic winds exactly
// (hardCrossCubic) but takes its COVERAGE FROM THE CHORD, and that costs ~2x the
// AA error of smooth content: loop 0.094 and cusp 0.070 against circle 0.052.
//
// METHODOLOGY TRAP, which hides the penalty: scoring the SDF
// kernel against ITSELF at 8x hides the bias, because the reference inherits the
// same chord coverage. Self-referenced, loop reads 0.043 and cusp 0.027 — roughly
// HALF the true error — and the unbiased sampled arm is scored against a biased
// truth. The reference must be a different engine. (probes/_gwnSdfAA.mjs uses Slug
// at 8x and is correct on this point, but its content is quad-only, so the
// cusp/loop class is not in its fixture set.)
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PETALS = (() => {
  const K = 10,
    c = 200,
    r = 150,
    P = (j) => [c + r * Math.cos((2 * Math.PI * j) / K), c + r * Math.sin((2 * Math.PI * j) / K)];
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let j = 1; j <= K; j++) {
    const m = [
      c + r * 1.7 * Math.cos((2 * Math.PI * (j - 0.5)) / K),
      c + r * 1.7 * Math.sin((2 * Math.PI * (j - 0.5)) / K),
    ];
    d += `Q ${m[0].toFixed(3)} ${m[1].toFixed(3)} ${P(j % K)[0].toFixed(3)} ${P(j % K)[1].toFixed(3)} `;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="${d}Z" fill="#000"/></svg>`;
})();
const CIRCLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><circle cx="200" cy="200" r="150" fill="#000"/></svg>`;
// TYPE-6 CLASS. A cusp/loop cubic (or any with no single-branch implicit) winds
// exactly via hardCrossCubic but takes its COVERAGE FROM THE CHORD. That is fine
// for the near-straight cubics the comment justifies it with, and wrong for a
// curve that bulges far from its chord — the AA has nothing to do with the real
// boundary there. These fixtures are deliberately fat and reversing.
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="${d}" fill="#000"/></svg>`;
const LOOP = svg('M 120 260 C 380 80, 20 80, 280 260 Z'); // control polygon crosses: loop
const CUSP = svg('M 120 280 C 340 60, 120 60, 200 300 Z'); // near-cusp, sharp reversal
const FATC = svg('M 80 300 C 80 40, 320 40, 320 300 Z'); // fat convex cubic, big sagitta

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="2048" height="2048"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
// EVERY ARM CARRIES ITS DEFINES. With createRenderer(gl,shaders,{}) and Loop-Blinn left on
// 'auto', the column headed "SDF AA (shipping)" would be SLUG or LB, and every type-6 conclusion
// drawn from it would be about a shader this probe never compiled. The armDiff control below
// cannot catch that: it asks whether the two arms differ, and Slug differs from winding-only just as GWN
// would. An arm is named by what it COMPILES, so the arms pin the engine and __run reports the
// variant each one actually DREW.
const rSdf =createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF']}); rSdf.setLoopBlinnFill('off');
const rWind=createRenderer(gl,shaders,{fillDefines:['MANTLE_HARD','MANTLE_HARD_TREE','MANTLE_GWN']}); rWind.setLoopBlinnFill('off');
// INDEPENDENT reference. Using the SDF kernel as its own 8x yardstick is wrong for
// the type-6 question: a cusp/loop cubic takes its COVERAGE FROM THE CHORD, and an
// 8x render of the same kernel inherits that bias — so the gap is invisible and the
// unbiased sampled arm is scored against a biased truth. AAC integrates true signed
// area for lines, quads, cubics and arcs natively, so it is the neutral yardstick.
const rRef =createRenderer(gl,shaders,{aacFill:true}); rRef.setLoopBlinnFill('off');
// The define each arm's DRAWN program must carry — reported per row, so a row whose arm compiled
// something else can never be read as a measurement of the kernel it names.
const WANT={sdf:['MANTLE_GWN','MANTLE_GWN_SDF'], wind:['MANTLE_GWN','MANTLE_HARD_TREE'], ref:['MANTLE_AAC']};
const drew=(r,tag)=>{const k=(r.debugStats.drawnFillVariantKey||'').split('|'); return WANT[tag].every(d=>k.includes(d));};

// Render at n*S and box-downsample to n. S=1 is a plain render.
function shot(r, sec, n, S){
  const N=n*S;
  const b=createBundle(gl,sec); r.prepareBundle&&r.prepareBundle(b);
  r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const px=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px);
  b.dispose();
  const out=new Float64Array(n*n);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    let s=0;
    for(let j=0;j<S;j++)for(let i=0;i<S;i++) s+=255-px[(((y*S+j)*N)+(x*S+i))*4];  // ink = 255 - luminance
    out[y*n+x]=s/(S*S)/255;
  }
  return out;
}
function score(a,ref){
  let sum=0,max=0,n=0;
  for(let i=0;i<a.length;i++){ const d=Math.abs(a[i]-ref[i]); sum+=d; if(d>max)max=d; n++; }
  return {mean:+(255*sum/n).toFixed(3), max:+(255*max).toFixed(1)};
}
window.__run=async(cases,n)=>{
  const out=[];
  for(const cs of cases){
    const sec=await importSvg(cs.svg,{gwnTree:true});
    const ref=shot(rRef,sec,n,8);                 // 8x AAC: independent of both arms
    const row={name:cs.name, sdf:score(shot(rSdf,sec,n,1),ref)};
    // THE DRAW PROOF, read AFTER the arms have drawn: armDiff says the arms differ, which Slug and
    // winding-only also do — only the drawn variant key says WHICH kernel each column is about.
    row.proved=drew(rRef,'ref')&&drew(rSdf,'sdf')&&drew(rWind,'wind');
    row.keys=[rSdf,rWind,rRef].map(r=>r.debugStats.drawnFillVariantKey||'(none)').join('  |  ');
    // CONTROL: S=1 is the winding-only kernel with no supersampling — binary
    // coverage, no AA whatsoever. Sampled arms must beat it and improve
    // monotonically in S; if they do not, the harness is wrong, not the idea.
    row.s1=score(shot(rWind,sec,n,1),ref);
    // Are the two arms actually DIFFERENT programs? If the forced defines do not
    // change this shape's route, both arms render the same image and every
    // comparison on this fixture is vacuous.
    row.armDiff=score(shot(rSdf,sec,n,1), shot(rWind,sec,n,1)).max;
    for(const S of [2,3,4]) row['s'+(S*S)]=score(shot(rWind,sec,n,S),ref);
    out.push(row);
  }
  return out;
};
window.__ready=true;
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': mime(pp) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
pg.on('console', (m) => {
  if (m.type() !== 'log') console.log('[' + m.type() + ']', m.text());
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
const rows = await pg.evaluate(
  (p, c, l, u, f) =>
    window.__run(
      [
        { name: 'petals', svg: p },
        { name: 'circle', svg: c },
        { name: 'loop', svg: l },
        { name: 'cusp', svg: u },
        { name: 'fatcubic', svg: f },
      ],
      256,
    ),
  PETALS,
  CIRCLE,
  LOOP,
  CUSP,
  FATC,
);
console.log('vs 8x supersampled reference — error in /255 (mean, max)\n');
console.log(
  'asset     SDF AA (shipping)   NO AA (S=1)    4-sample     9-sample    16-sample   arms differ?',
);
for (const r of rows)
  console.log(
    `${r.name.padEnd(9)} ${(r.sdf.mean + ' / ' + r.sdf.max).padStart(17)} ${(r.s1.mean + ' / ' + r.s1.max).padStart(14)} ${(r.s4.mean + ' / ' + r.s4.max).padStart(12)} ${(r.s9.mean + ' / ' + r.s9.max).padStart(12)} ${(r.s16.mean + ' / ' + r.s16.max).padStart(12)}   ${r.armDiff > 0 ? 'yes (' + r.armDiff + ')' : 'NO - VACUOUS'}   ${r.proved ? 'arms proved' : 'ARMS UNPROVED'}`,
  );
if (!rows.every((r) => r.proved))
  console.log(
    '\nDO NOT READ THE TABLE: an arm did not draw the kernel its column names.\n  sdf | wind | ref drew: ' +
      rows[0].keys,
  );
await br.close();
server.close();

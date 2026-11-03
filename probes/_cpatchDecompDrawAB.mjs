// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchDecompDrawAB — does a DIFFERENT DECOMPOSITION of the same art cost anything to draw?
//
// Every search shortcut in cpatchConvert buys build time with patches, and the file rejects them
// on that ground alone: "patches are draw cost every frame". That is an assumption, not a
// measurement. This prices it: two bundles of the same asset, converted under different converter
// options, drawn by ONE renderer on ONE context, interleaved.
//
// The rig follows the timing rules the other probes here use:
//   * ONE renderer and one GL context. Three renderers on one context are not interchangeable --
//     an A/A across them can read 1.75x.
//   * Samples INTERLEAVE and the arm order ROTATES, so block drift and position cannot decide it.
//   * An A/A control (arm A against itself) runs alongside; a difference smaller than the A/A
//     spread is not a difference.
//   * Ink is counted BEFORE timing, so an arm that paints less cannot post the better time -- the
//     two decompositions must agree on what they paint or the comparison is meaningless.
//   * gpu (timer query), cpu (submit) and wall are all reported: a GPU timer cannot see the CPU
//     work, and the CPU clock cannot see the GPU.
//   * Throttled by default (THROTTLE_MS between batches), because unthrottled GPU loops here have
//     taken the whole machine down.
//
//   SVGFILE=examples/tiger.svg ARMB='{"search":"fast"}' node probes/_cpatchDecompDrawAB.mjs
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.SVGFILE || 'examples/tiger.svg';
const SVG = readFileSync(path.resolve(ROOT, FILE), 'utf8');
const ARMB = process.env.ARMB || '{"candOrder":"index","leakScore":"full"}';
const SIZE = +(process.env.SIZE || 512),
  DRAWS = +(process.env.DRAWS || 8);
const SAMPLES = +(process.env.SAMPLES || 15),
  BATCH = +(process.env.BATCH || 20);
const THROTTLE = +(process.env.THROTTLE_MS || 60);
const PAGE = `<!doctype html><body><canvas id=c width=${SIZE} height=${SIZE}></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
// POOL OFF. The override below is a page global and the pooled build converts inside WORKERS,
// which have their own globalThis -- with pooling on, both arms silently convert under the
// defaults and the rig compares a decomposition with itself (verts identical to the digit).
const r=createRenderer(gl,shaders,{cpatchFill:true,cpatchOpts:{pool:false}});
await r.ready; r.setViewport(${SIZE},${SIZE}); r.setFillEngine({route:'cpatch'});
const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
const sleep=(ms)=>new Promise(q=>setTimeout(q,ms));
const sections=await importSvg(${JSON.stringify(SVG)});
const CLEAR=[1,1,1,1];

// Build one bundle under a given set of converter options. The options are read at BUILD time
// (unifiedFillDraw hands R.opts.cpatchOpts to buildCPatchBundle), so setting them around the
// build is what gives one renderer two different decompositions.
// __CP_OPTS is the two-bundles-on-one-renderer override the converter documents, same convention
// as __CP_GRID: cpatchOpts is a renderer option and one renderer per arm cannot be measured.
async function build(opts){
  globalThis.__MANTLE_DEBUG__ = true; globalThis.__CP_OPTS = opts;
  const b = createBundle(gl, sections);
  r.prepareBundle(b);
  try { await r.awaitEngine(b,'cpatch',120000); } catch {}
  r.prepareBundle(b);
  const ms=b._lbMeshes||[];
  let verts=0; for(const m of ms) if(m&&m.cpatch) verts+=(m.vertexCount|0);
  return { b, cpatch: ms.filter(m=>m&&m.cpatch).length, verts };
}
const A = await build({});
const B = await build(JSON.parse(${JSON.stringify(ARMB)}));

function frame(b){ r.beginFrame(CLEAR); for(let i=0;i<${DRAWS};i++) r.drawBundle(b,{}); r.endFrame(); }
function ink(){ const px=new Uint8Array(${SIZE}*${SIZE}*4); gl.readPixels(0,0,${SIZE},${SIZE},gl.RGBA,gl.UNSIGNED_BYTE,px);
  let n=0; for(let p=0;p<px.length;p+=4) if(px[p]<250||px[p+1]<250||px[p+2]<250) n++; return n; }
// INK FIRST, so an arm that paints less cannot win on time.
frame(A.b); gl.finish(); const inkA=ink();
frame(B.b); gl.finish(); const inkB=ink();
// Warm both: first draws compile and upload.
for(let i=0;i<3;i++){ frame(A.b); frame(B.b); } gl.finish();

async function timed(b){
  let q=null;
  if(timer){ q=gl.createQuery(); gl.beginQuery(timer.TIME_ELAPSED_EXT,q); }
  const c0=performance.now();
  for(let i=0;i<${BATCH};i++) frame(b);
  const cpu=performance.now()-c0;
  if(timer) gl.endQuery(timer.TIME_ELAPSED_EXT);
  gl.finish();
  const wall=performance.now()-c0;
  let gpu=null;
  if(q){ for(let i=0;i<200;i++){ if(gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)) break; await sleep(1); }
    if(gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)&&!gl.getParameter(timer.GPU_DISJOINT_EXT)) gpu=gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6;
    gl.deleteQuery(q); }
  return { gpu, cpu, wall };
}
const arms={ A:[], B:[], AA:[] };
for(let s=0;s<${SAMPLES};s++){
  // rotate the order so position in the sample cannot favour an arm
  const order = s%3===0 ? ['A','B','AA'] : s%3===1 ? ['B','AA','A'] : ['AA','A','B'];
  for(const k of order){ arms[k].push(await timed(k==='B'?B.b:A.b)); await sleep(${THROTTLE}); }
}
// The first sample of each arm is dropped: it pays for whatever the previous arm left in flight.
const stat=(rows,f)=>{ const v=rows.slice(1).map(f).filter(x=>x!=null).sort((a,b)=>a-b); return v.length?{min:+v[0].toFixed(3),med:+v[(v.length/2)|0].toFixed(3)}:null; };
window.__out={ size:${SIZE}, draws:${DRAWS}, batch:${BATCH}, samples:${SAMPLES},
  A:{ patches:A.cpatch, verts:A.verts, ink:inkA }, B:{ patches:B.cpatch, verts:B.verts, ink:inkB },
  gpu:{ A:stat(arms.A,r=>r.gpu), B:stat(arms.B,r=>r.gpu), AA:stat(arms.AA,r=>r.gpu) },
  cpu:{ A:stat(arms.A,r=>r.cpu), B:stat(arms.B,r=>r.cpu), AA:stat(arms.AA,r=>r.cpu) },
  wall:{ A:stat(arms.A,r=>r.wall), B:stat(arms.B,r=>r.wall), AA:stat(arms.AA,r=>r.wall) } };
window.__ready=true;
</script></body>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const p = q.url.split('?')[0];
    if (p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    res.writeHead(200, { 'content-type': mime(p) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(p))));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=metal'],
  protocolTimeout: 600000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 120000 });
let out = null;
try {
  await pg.waitForFunction(() => window.__ready === true, { timeout: 600000, polling: 200 });
  out = await pg.evaluate(() => window.__out);
} catch (e) {
  console.log('  DID NOT FINISH');
}
await br.close();
server.close();
if (out) console.log('  ' + JSON.stringify(out));

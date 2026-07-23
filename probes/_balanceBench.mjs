// Real-GPU fill-engine balance benchmark.
//
// Accuracy is checked against Slug after expanding its visible color edges by
// two pixels. Differences in that AA band are scored, but allowed; differences
// in stable interiors are structural failures. Hard fill is only measured when
// the shipping no-AA selector proves an opaque stroke covers the fill edge.
//
//   GPU=1 PROFILE=calibration node probes/_balanceBench.mjs
//   GPU=1 PROFILE=full REAL=1 CORPUS_ROOT=/path/to/svg/corpus REPS=7 node probes/_balanceBench.mjs
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const HERE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = process.env.MANTLE_ROOT
  ? path.resolve(process.env.MANTLE_ROOT)
  : HERE_ROOT;
const CORPUS_ROOT = process.env.CORPUS_ROOT
  ? path.resolve(process.env.CORPUS_ROOT)
  : null;
const PROFILE = process.env.PROFILE || 'calibration';
const FULL = PROFILE === 'full';
const QUICK = PROFILE === 'quick';
const SIZES = (process.env.SIZES || (FULL ? '128,256,512,1024' : QUICK ? '256,512' : '256,512,1024'))
  .split(',').map(Number).filter(Boolean);
const DRAWS = (process.env.DRAWS || '1,8,32').split(',').map(Number).filter(Boolean);
const REPS = +(process.env.REPS || (FULL ? 7 : QUICK ? 7 : 11));
const REAL_N = +(process.env.REAL_N || (FULL ? 48 : QUICK ? 12 : 24));
const CASE_LIMIT = +(process.env.CASE_LIMIT || 0);
const AXES = process.env.AXIS ? new Set(process.env.AXIS.split(',')) : null;
const LB_PART_CHAIN = process.env.LB_PART_CHAIN == null ? null : process.env.LB_PART_CHAIN !== '0';
const DISABLE_WORKERS = process.env.DISABLE_WORKERS === '1';
const LB_CHAIN_AB = process.env.LB_CHAIN_AB === '1';
const REAL = process.env.REAL === '1' && CORPUS_ROOT && existsSync(CORPUS_ROOT);
const OUT = process.env.OUT || path.join(ROOT, 'probes', '_balanceBenchOut-v2.json');
const REPORT = process.env.REPORT || path.join(ROOT, 'probes', '_balanceBenchReport-v2.md');

const fmt = (n) => Number.isFinite(n) ? +n.toFixed(6) : null;
const polar = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
function pathFor(family, cx, cy, r, segments, subtype) {
  if (subtype) {
    const P = {
      convex: [[0, .8], [.2, -.2], [.8, -.2], [1, .8]],
      serpentine: [[0, .5], [-.27, .3], [.78, .92], [1, .5]],
      loop: [[0, .5], [-.01, 1.01], [-.12, -.49], [1, .5]],
      cusp: [[0, .5], [.6403966051, -.4145369838], [-.3806749970, -.4661355019], [1, .5]],
    }[subtype];
    const q = P.map(([x, y]) => [cx + (x - .5) * r * 1.6, cy + (y - .5) * r * 1.6]);
    return `M${q[0][0]} ${q[0][1]} C${q[1][0]} ${q[1][1]} ${q[2][0]} ${q[2][1]} ${q[3][0]} ${q[3][1]} L${cx + r * .7} ${cy + r} L${cx - r * .7} ${cy + r} Z`;
  }
  const n = Math.max(family === 'line' ? 3 : 4, segments | 0);
  const pts = Array.from({ length: n }, (_, i) => polar(cx, cy, r, -Math.PI / 2 + i * Math.PI * 2 / n));
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + i * Math.PI * 2 / n;
    const b = a + Math.PI * 2 / n;
    const p = pts[(i + 1) % n];
    if (family === 'line') d += ` L${p[0]} ${p[1]}`;
    else if (family === 'arc') d += ` A${r} ${r} 0 0 1 ${p[0]} ${p[1]}`;
    else if (family === 'quad') {
      const cr = r / Math.cos((b - a) / 2), c = polar(cx, cy, cr, (a + b) / 2);
      d += ` Q${c[0]} ${c[1]} ${p[0]} ${p[1]}`;
    } else {
      const k = 4 / 3 * Math.tan((b - a) / 4) * r;
      const p0 = pts[i], c1 = [p0[0] - Math.sin(a) * k, p0[1] + Math.cos(a) * k];
      const c2 = [p[0] + Math.sin(b) * k, p[1] - Math.cos(b) * k];
      d += ` C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p[0]} ${p[1]}`;
    }
  }
  return d + ' Z';
}

function syntheticSvg({ family, shapes, segments, subtype, hardSafe, strokeFrac = .08 }) {
  const side = Math.ceil(Math.sqrt(shapes)), cell = 120 / side;
  let body = '';
  for (let i = 0; i < shapes; i++) {
    const cx = (i % side + .5) * cell + 4, cy = ((i / side | 0) + .5) * cell + 4;
    const r = cell * .38;
    const stroke = hardSafe ? ` stroke="#265b9b" stroke-width="${Math.max(.05, cell * strokeFrac)}" stroke-linejoin="round"` : '';
    body += `<path d="${pathFor(family, cx, cy, r, segments, subtype)}" fill="#265b9b"${stroke}/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
}

function syntheticCases() {
  const out = [], families = ['line', 'quad', 'cubic', 'arc'];
  const add = (axis, spec) => {
    const coverage = spec.coverage == null ? .72 : spec.coverage;
    const name = [axis, spec.family, spec.subtype || '', 'n' + spec.shapes,
      's' + spec.segments, 'c' + coverage, spec.hardSafe ? 'w' + spec.strokeFrac : ''].filter(Boolean).join('_');
    out.push({ name, axis, coverage, real: false, ...spec, svg: syntheticSvg(spec) });
  };
  for (const family of families) for (const shapes of (QUICK ? [1, 32] : [1, 16, 128]))
    add('count', { family, shapes, segments: 16, coverage: .72 });
  for (const family of families) for (const segments of (QUICK ? [4, 32] : [4, 16, 64, 192]))
    add('segments', { family, shapes: 1, segments, coverage: .72 });
  for (const family of families) for (const coverage of (QUICK ? [.12, .8] : [.08, .28, .58, .9]))
    add('coverage', { family, shapes: 16, segments: 16, coverage });
  for (const subtype of ['convex', 'serpentine', 'loop', 'cusp']) for (const shapes of (QUICK ? [1] : [1, 32]))
    add('cubic-subtype', { family: 'cubic', subtype, shapes, segments: 1, coverage: .72 });
  for (const family of families) for (const strokeFrac of (QUICK ? [.08] : [.02, .06, .16]))
    add('hard-gate', { family, shapes: 16, segments: 16, coverage: .82, hardSafe: true, strokeFrac });
  for (const runs of (QUICK ? [2, 8] : [1, 2, 4, 8, 12])) {
    let body = '';
    for (let i = 0; i < runs * 2; i++) {
      const dx = Math.sin(i * 1.7) * 8, dy = Math.cos(i * 1.3) * 8;
      // Alternate a clean analytic square with the audited concave C-shape from
      // lbConcaveCubicParitySmoke. The latter is a known Slug sentinel because one
      // cubic piece paints air, so this axis measures genuine mixed-route runs.
      const d = (i & 1)
        ? 'M150 50 C80 20 40 60 40 100 C40 140 80 180 150 150 L150 120 C100 145 70 130 70 100 C70 70 100 55 150 80 Z'
        : 'M45 45 L155 45 L155 155 L45 155 Z';
      body += `<path d="${d}" transform="translate(${dx} ${dy})" fill="${(i & 1) ? '#9b3151' : '#265b9b'}"/>`;
    }
    out.push({ name: 'sentinel_runs_' + runs, axis: 'sentinel-runs', family: 'mixed',
      shapes: runs * 2, segments: 2, coverage: .82, real: false, occlusionCull: false,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${body}</svg>` });
  }
  return out;
}

function allSvgFiles(root) {
  const out = [], stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith('.svg')) out.push(p);
    }
  }
  return out;
}

function realCases(limit) {
  if (!REAL) return [];
  const groups = new Map();
  for (const file of allSvgFiles(CORPUS_ROOT)) {
    let size; try { size = statSync(file).size; } catch { continue; }
    if (size < 80 || size > 600000) continue;
    const rel = path.relative(CORPUS_ROOT, file), parts = rel.split(path.sep);
    const group = parts.slice(0, Math.min(parts[0] === 'packages' ? 3 : 2, parts.length - 1)).join('/');
    let svg; try { svg = readFileSync(file, 'utf8'); } catch { continue; }
    const curves = (svg.match(/[CQASTLHVcqastlhv](?=[\s,\-+.0-9])/g) || []).length;
    const paths = (svg.match(/<(path|circle|ellipse|rect|polygon|polyline)\b/gi) || []).length;
    const item = { file, rel, svg, score: curves + paths * 3 + Math.log2(size + 1) };
    let g = groups.get(group); if (!g) groups.set(group, g = []); g.push(item);
  }
  for (const g of groups.values()) g.sort((a, b) => a.score - b.score || a.rel.localeCompare(b.rel));
  const keys = [...groups.keys()].sort(), picked = [];
  let round = 0;
  while (picked.length < limit && keys.length) {
    let progress = false;
    for (const key of keys) {
      const g = groups.get(key); if (!g.length || picked.length >= limit) continue;
      const q = [0, .5, 1, .25, .75][round % 5];
      const idx = Math.min(g.length - 1, Math.round((g.length - 1) * q));
      const [item] = g.splice(idx, 1); picked.push(item); progress = true;
    }
    if (!progress) break;
    round++;
  }
  return picked.map((x, i) => ({ name: 'real_' + i + '_' + path.basename(x.file, '.svg').slice(0, 36),
    family: 'real', axis: 'real', shapes: 0, segments: 0, coverage: .82,
    real: true, source: x.rel, svg: x.svg }));
}

const ALL_CASES = [...syntheticCases(), ...realCases(REAL_N)].filter((c) => !AXES || AXES.has(c.axis));
const CASES = CASE_LIMIT > 0 ? ALL_CASES.slice(0, CASE_LIMIT) : ALL_CASES;
const CONFIG = { profile: PROFILE, sizes: SIZES, draws: DRAWS, reps: REPS, real: REAL, realN: REAL_N,
  lbPartChain: LB_PART_CHAIN, disableWorkers: DISABLE_WORKERS, lbChainAB: LB_CHAIN_AB };

const PAGE = (N) => `<!doctype html><html><head><style>
html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#232c36}
canvas{position:absolute;inset:0;width:100%;height:100%;display:none}
</style></head><body><div id="root"></div><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
if (${DISABLE_WORKERS || LB_CHAIN_AB}) globalThis.Worker = undefined;
if (${LB_PART_CHAIN == null ? 'false' : 'true'}) globalThis.__LB_PART_CHAIN = ${!!LB_PART_CHAIN};
const N=${N}, REPS=${REPS}, DRAWS=${JSON.stringify(DRAWS)}, CHAIN_AB=${LB_CHAIN_AB};
const CLEAR=[.137,.173,.211,1], CLEAR8=[35,44,54,255];
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const SPECS={
  slug:[{},'off'], aac:[{aacFill:true},'off'], lb:[{},'on'],
  gate:[{aacFill:'auto'},'off'], auto:[{aacFill:'auto'},'auto'],
  hardBand:[{fillDefines:['MANTLE_HARD','MANTLE_GWN']},'off'],
  hardTree:[{fillDefines:['MANTLE_HARD','MANTLE_GWN','MANTLE_HARD_TREE']},'off'],
};
if(CHAIN_AB){SPECS.lbNoConic=[{},'on'];SPECS.lbNoChain=[{},'on'];}
const states={};
for(const [name,[opts,mode]] of Object.entries(SPECS)){
  const c=document.createElement('canvas'); c.width=N; c.height=N; document.getElementById('root').appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
  if(!gl) throw new Error('WebGL2 unavailable for '+name);
  const r=createRenderer(gl,shaders,{...opts,precompileFillsBudgetMs:5000}); await r.ready; r.setViewport(N,N); r.setLoopBlinnFill(mode);
  states[name]={name,c,gl,r,mode,timer:gl.getExtension('EXT_disjoint_timer_query_webgl2')};
}
function gpuInfo(gl){const d=gl.getExtension('WEBGL_debug_renderer_info');return {vendor:d?gl.getParameter(d.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),renderer:d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),version:gl.getParameter(gl.VERSION),timer:!!gl.getExtension('EXT_disjoint_timer_query_webgl2')};}
const GPU=gpuInfo(states.slug.gl);
const sleep=(ms)=>new Promise(q=>setTimeout(q,ms));
function configure(active){for(const s of Object.values(states)){s.r.setLoopBlinnFill('off');s.c.style.display=s.name===active?'block':'none';}states[active].r.setLoopBlinnFill(states[active].mode);}
// uWorldM operates on normalized clip coordinates, not asset coordinates. A zero-
// translation uniform scale therefore stays centered; sqrt maps requested area
// coverage to the matrix's linear scale.
function drawOpts(b,cov){const s=Math.sqrt(Math.max(0,Math.min(1,cov)));return {worldMatrix:[s,0,0,0,s,0,0,0,1]};}
function frame(s,b,o,D){s.r.beginFrame(CLEAR);for(let i=0;i<D;i++)s.r.drawBundle(b,o);s.r.endFrame();}
function read(gl){const p=new Uint8Array(N*N*4);gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);return p;}
function inkPixels(px){let n=0;for(let p=0;p<px.length;p+=4)if(Math.max(Math.abs(px[p]-CLEAR8[0]),Math.abs(px[p+1]-CLEAR8[1]),Math.abs(px[p+2]-CLEAR8[2]),Math.abs(px[p+3]-CLEAR8[3]))>2)n++;return n;}
function median(a){a.sort((x,y)=>x-y);return a[(a.length/2)|0];}
async function waitBackground(b,timeout=60000){const t=performance.now();while(b._occupancyBuildPending||b._occlusionCullPending){if(performance.now()-t>timeout)return false;await sleep(4);}return true;}
function hasRealLb(b){return Array.isArray(b._lbMeshes)&&b._lbMeshes.some(m=>m&&!m.slug&&(m.vertexCount|0)>0);}
function memory(b,s){const seen=new Set();let cpu=0;const add=v=>{if(!v||!ArrayBuffer.isView(v)||seen.has(v.buffer))return;seen.add(v.buffer);cpu+=v.buffer.byteLength;};for(const v of Object.values(b))add(v);for(const m of b._lbMeshes||[])if(m&&m.verts)add(m.verts);return {cpu,gpu:s.r.gpuMemoryEstimate()+(b._lbMemBytes||0),lb:b._lbMemBytes||0};}
async function firstPaint(s,b,o){configure(s.name);const before=hasRealLb(b),c0=s.r.debugStats.loopBlinnRouteCount,t0=performance.now();frame(s,b,o,1);s.gl.finish();return {wall:performance.now()-t0,lbReadyBefore:before,lbRoute:s.r.debugStats.loopBlinnRouteCount-c0,pick:s.r.debugStats.autoEngine||null};}
async function setup(name,sections,cov,chainOverride=null,conicOverride=null){const s=states[name];if(chainOverride!==null)globalThis.__LB_PART_CHAIN=chainOverride;if(conicOverride!==null)globalThis.__LB_CONIC=conicOverride;configure(name);const b=createBundle(s.gl,sections);const o=drawOpts(b,cov);const first=await firstPaint(s,b,o);s.r.prewarmBundle(b);const tw=performance.now();let lbReady=false;if(name==='lb'||name==='lbNoConic'||name==='lbNoChain'||name==='auto')lbReady=await s.r.awaitLbReady(b,60000);await waitBackground(b);s.r.precompileFills();configure(name);for(let i=0;i<10;i++)frame(s,b,o,1);for(let i=0;i<2;i++)frame(s,b,o,DRAWS[DRAWS.length-1]);s.gl.finish();const c0=s.r.debugStats.loopBlinnRouteCount;frame(s,b,o,1);s.gl.finish();const route=s.r.debugStats.loopBlinnRouteCount-c0,px=read(s.gl),ds=s.r.debugStats,lbm=b._lbMeshes||[];let lbVerts=0,lbChainVerts=0,lbConicVerts=0,lbFull=false;for(const m of lbm){if(!m||m.slug||!m.verts)continue;lbVerts+=m.vertexCount|0;lbFull=lbFull||!!m.hasBezout;for(let v=0;v<(m.vertexCount|0);v++){const p=v*24;if(m.verts[p+5]<0.5&&m.verts[p+2]>1.5){lbChainVerts++;if(m.verts[p+2]>2.5)lbConicVerts++;}}}if(chainOverride!==null)globalThis.__LB_PART_CHAIN=true;if(conicOverride!==null)globalThis.__LB_CONIC=true;return {s,b,o,px,ink:inkPixels(px),first,route,lbReady,lbReal:lbm.filter(m=>m&&!m.slug&&(m.vertexCount|0)>0).length,lbSentinel:lbm.filter(m=>m&&m.slug).length,lbVerts,lbChainVerts,lbConicVerts,lbFull,buildWait:performance.now()-tw,pick:ds.autoEngine||null,px2:ds.autoMeanShapePx2||0,px2seg:ds.lbAutoPx2PerSeg||ds.autoPx2PerSeg||0,bytesPerSeg:ds.lbAutoBytesPerSeg||0,segTypeMask:b.segTypeMask|0,occ:!!b.hasOccupancy,mem:memory(b,s),shapes:b.numShapes|0,segs:b.meanSegsPerShape||0,noAaFill:!!b.noAaFill,noAaTree:!!b.noAaTree};}
async function timed(x,D){const {s,b,o}=x,gl=s.gl,ext=s.timer,wall=[],gpu=[];configure(s.name);let t0=performance.now();frame(s,b,o,D);gl.finish();const probe=Math.max(.02,performance.now()-t0),batch=Math.max(1,Math.min(4,Math.ceil(1/probe)));for(let k=0;k<REPS;k++){let q=null;if(ext){q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);}const t=performance.now();for(let f=0;f<batch;f++)frame(s,b,o,D);if(ext)gl.endQuery(ext.TIME_ELAPSED_EXT);gl.finish();if(q){for(let p=0;p<1000&&!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE);p++)await sleep(0);const ns=gl.getQueryParameter(q,gl.QUERY_RESULT);if(!gl.getParameter(ext.GPU_DISJOINT_EXT))gpu.push(ns/1e6/batch);gl.deleteQuery(q);}wall.push((performance.now()-t)/batch);}wall.sort((a,b)=>a-b);gpu.sort((a,b)=>a-b);return {wall:median(wall),gpu:gpu.length?median(gpu):null,p10:wall[Math.floor(wall.length*.1)],p90:wall[Math.min(wall.length-1,Math.floor(wall.length*.9))],batch};}
function edgeMask(ref){const m=new Uint8Array(N*N),out=new Uint8Array(N*N);const delta=(a,b)=>Math.max(Math.abs(ref[a]-ref[b]),Math.abs(ref[a+1]-ref[b+1]),Math.abs(ref[a+2]-ref[b+2]),Math.abs(ref[a+3]-ref[b+3]));for(let y=0;y<N;y++)for(let x=0;x<N;x++){const i=y*N+x,p=i*4;if(x+1<N&&delta(p,p+4)>6)m[i]=1;if(y+1<N&&delta(p,p+N*4)>6)m[i]=1;}for(let y=0;y<N;y++)for(let x=0;x<N;x++)if(m[y*N+x])for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&yy>=0&&xx<N&&yy<N)out[yy*N+xx]=1;}return out;}
function accuracy(ref,got,edge){let structural=0,edgeSum=0,edgeN=0,edgeMax=0,diff=0;for(let i=0;i<N*N;i++){const p=i*4,d=Math.max(Math.abs(ref[p]-got[p]),Math.abs(ref[p+1]-got[p+1]),Math.abs(ref[p+2]-got[p+2]),Math.abs(ref[p+3]-got[p+3]));if(d>0)diff++;if(edge[i]){edgeSum+=d;edgeN++;if(d>edgeMax)edgeMax=d;}else if(d>24)structural++;}return {structural,edgeMean:edgeN?edgeSum/edgeN:0,edgeMax,diff};}
window.__bench=async(svg,meta,index)=>{let sections;try{sections=await importSvg(svg,{occupancyGrid:true,gwnTree:true,occlusionCull:meta.occlusionCull!==false});}catch(e){return {err:'import: '+e.message};}const built={};for(const name of ['slug','aac'])built[name]=await setup(name,sections,meta.coverage);built.lb=await setup('lb',sections,meta.coverage,CHAIN_AB?true:null,CHAIN_AB?true:null);if(CHAIN_AB){built.lbNoConic=await setup('lbNoConic',sections,meta.coverage,true,false);built.lbNoChain=await setup('lbNoChain',sections,meta.coverage,false,false);}built.gate=await setup('gate',sections,meta.coverage);const hardPick=(built.gate.pick==='noaa-tree')?'hardTree':(built.gate.pick==='noaa-band')?'hardBand':null;if(hardPick)built.hard=await setup(hardPick,sections,meta.coverage);built.auto=await setup('auto',sections,meta.coverage);if(!meta.real&&built.slug.ink===0){for(const x of Object.values(built))x.b.dispose();return {err:'blank synthetic render'};}const order=['slug','aac','lb',...(built.lbNoConic?['lbNoConic']:[]),...(built.lbNoChain?['lbNoChain']:[]),...(built.hard?['hard']:[]),'gate','auto'];const rot=index%order.length,run=order.slice(rot).concat(order.slice(0,rot));for(const name of run){built[name].ms={};for(const D of DRAWS)built[name].ms[D]=await timed(built[name],D);}const edge=edgeMask(built.slug.px),out={gpu:GPU,hardPick};for(const [name,x] of Object.entries(built)){out[name]={ink:x.ink,first:x.first,route:x.route,lbReady:x.lbReady,lbReal:x.lbReal,lbSentinel:x.lbSentinel,lbVerts:x.lbVerts,lbChainVerts:x.lbChainVerts,lbConicVerts:x.lbConicVerts,lbFull:x.lbFull,buildWait:x.buildWait,pick:x.pick,px2:x.px2,px2seg:x.px2seg,bytesPerSeg:x.bytesPerSeg,segTypeMask:x.segTypeMask,occ:x.occ,mem:x.mem,shapes:x.shapes,segs:x.segs,noAaFill:x.noAaFill,noAaTree:x.noAaTree,ms:x.ms,acc:accuracy(built.slug.px,x.px,edge)};x.b.dispose();}return out;};window.__ready=true;window.__gpu=GPU;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/') { const n = +(new URL(req.url, 'http://x').searchParams.get('N') || 512); res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE(n)); return; }
    const file = path.resolve(ROOT, '.' + u);
    if (!file.startsWith(ROOT + path.sep)) throw new Error('bad path');
    res.writeHead(200, { 'content-type': u.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(file));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const windowN = Math.max(...SIZES);
const launchBrowser = () => puppeteer.launch(process.env.GPU === '1'
  ? { headless: false, protocolTimeout: 900000, defaultViewport: { width: windowN, height: windowN, deviceScaleFactor: 1 },
      args: ['--no-sandbox', '--use-angle=metal', '--use-gl=angle', '--enable-gpu', `--window-size=${windowN + 32},${windowN + 120}`] }
  : { headless: 'new', protocolTimeout: 900000, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'] });
let browser = await launchBrowser();

async function freshPage(N) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.setViewport({ width: N, height: N, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:' + port + '/?N=' + N, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__ready===true', { timeout: 120000 });
  return page;
}

const rows = []; let gpu = null, index = 0;
for (const N of SIZES) {
  let page = await freshPage(N);
  gpu = await page.evaluate(() => window.__gpu);
  if (process.env.GPU === '1' && /swiftshader|llvmpipe|software/i.test(gpu.renderer || ''))
    throw new Error('GPU=1 requested but browser reports ' + gpu.renderer);
  for (const c of CASES) {
    if (c.real && N !== SIZES[SIZES.length - 1] && N !== SIZES[Math.max(0, SIZES.length - 2)]) continue;
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await page.evaluate((svg, meta, i) => window.__bench(svg, meta, i), c.svg, c, index);
        break;
      } catch (e) {
        result = { err: 'page: ' + e.message };
        try { await page.close(); } catch {}
        const connected = typeof browser.isConnected === 'function' ? browser.isConnected() : browser.connected;
        if (!connected) browser = await launchBrowser();
        page = await freshPage(N);
      }
    }
    rows.push({ ...c, svg: undefined, N, result }); index++;
    writeFileSync(OUT, JSON.stringify({ config: CONFIG, gpu, rows }));
    process.stderr.write(result && result.err ? 'x' : '.');
  }
  process.stderr.write(' N=' + N + '\n');
  try { await page.close(); } catch {}
}
try { await browser.close(); } catch {}
server.close();

const PRIMARY_DRAWS = DRAWS[DRAWS.length - 1], validRows = rows.filter((r) => r.result && !r.result.err);
const score = (x) => x.ms[PRIMARY_DRAWS].gpu ?? x.ms[PRIMARY_DRAWS].wall;
const winnerOf = (row) => {
  const r = row.result, cand = [];
  for (const name of ['slug', 'aac', 'lb', 'hard']) {
    const x = r[name]; if (!x || x.acc.structural || (!row.real && !x.ink)
      || (name === 'lb' && !(x.lbReady && x.route))) continue;
    cand.push([name, score(x)]);
  }
  cand.sort((a, b) => a[1] - b[1]); return cand;
};
const tally = new Map(), misses = [], lbBins = new Map(), aacBins = new Map();
const bins = [0, 50, 100, 150, 300, 600, 1200, Infinity];
const binOf = (v) => { for (let i = 1; i < bins.length; i++) if (v < bins[i]) return bins[i - 1] + '-' + (bins[i] === Infinity ? 'inf' : bins[i]); return 'inf'; };
for (const row of validRows) {
  const cand = winnerOf(row); if (!cand.length) continue;
  const win = cand[0][0], key = row.real ? 'real' : row.family;
  const t = tally.get(key) || {}; t[win] = (t[win] || 0) + 1; tally.set(key, t);
  const lbk = binOf(row.result.auto.px2seg || 0), lbt = lbBins.get(lbk) || {}; lbt[win] = (lbt[win] || 0) + 1; lbBins.set(lbk, lbt);
  const ack = row.family + ':' + binOf(row.result.gate.px2 || 0), act = aacBins.get(ack) || {}; act[win] = (act[win] || 0) + 1; aacBins.set(ack, act);
  const auto = row.result.auto, autoPick = auto.lbReady && auto.route ? 'lb' : auto.pick;
  if (auto.acc.structural || (autoPick !== win && score(auto) > cand[0][1] * 1.15))
    misses.push({ case: row.name, N: row.N, win, winMs: cand[0][1], auto: autoPick, autoMs: score(auto), structural: auto.acc.structural });
}
const table = (m) => [...m].map(([k, v]) => '| ' + k + ' | ' + Object.entries(v).sort((a, b) => b[1] - a[1]).map(([e, n]) => e + ':' + n).join(' ') + ' |').join('\n');
const hardRows = validRows.filter((r) => r.result.hard);
const hardWins = hardRows.filter((r) => winnerOf(r)[0] && winnerOf(r)[0][0] === 'hard').length;
const med = (a) => { a = a.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
const memRows = ['slug', 'aac', 'lb', 'gate', 'auto'].map((name) => {
  const x = validRows.map((r) => r.result[name]).filter(Boolean);
  return `| ${name} | ${Math.round(med(x.map(v => v.mem.cpu)))} | ${Math.max(0,...x.map(v => v.mem.cpu))} | ${Math.round(med(x.map(v => v.mem.gpu)))} | ${Math.max(0,...x.map(v => v.mem.gpu))} | ${Math.max(0,...x.map(v => v.mem.lb))} | ${fmt(med(x.map(v => v.first.wall)))} |`;
}).join('\n');
const realAssets = new Set(validRows.filter((r) => r.real).map((r) => r.source)).size;
const md = `# Mantle fill-engine balance (${new Date().toISOString()})

- GPU: ${gpu.vendor} / ${gpu.renderer}
- WebGL: ${gpu.version}; timer query: ${gpu.timer}
- Profile: ${PROFILE}; sizes: ${SIZES.join(', ')}; draws/frame: ${DRAWS.join(', ')}; samples: ${REPS}
- Cases: ${validRows.length} completed, ${rows.length - validRows.length} failed; unique external assets: ${realAssets}
- Primary ranking: median GPU timer at ${PRIMARY_DRAWS} draws/frame (completion-wall medians are retained separately).
- Accuracy: non-edge differences over 24/255 are structural and disqualify; two-pixel edge-band differences are AA-only and retained as quality metrics.

## Winners

| Regime | Accuracy-gated fastest |
|---|---|
${table(tally)}

## LB px2/segment bins

| px2/segment | Winners |
|---|---|
${table(lbBins)}

## AAC area bins

| Family: mean shape px2 | Winners |
|---|---|
${table(aacBins)}

## Hard gate

The shipping no-AA gate admitted ${hardRows.length} rows; hard was fastest in ${hardWins}. It was not executed outside that gate.

## Memory and first paint

Bytes are per measured bundle. GPU estimates include renderer-owned resources; LB is the bundle's analytic mesh bytes. First paint is completion-wall time before worker/prewarm readiness.

| Engine | median CPU | max CPU | median GPU | max GPU | max LB | median first ms |
|---|---:|---:|---:|---:|---:|---:|
${memRows}

## Shipping gate misses (>15% or structural)

${misses.length ? misses.slice(0, 80).map(m => `- ${m.case}@${m.N}: auto=${m.auto} ${fmt(m.autoMs)} ms, best=${m.win} ${fmt(m.winMs)} ms, structural=${m.structural}`).join('\n') : 'None.'}

Raw per-case accuracy, CPU/GPU memory, first-paint route, worker wait, wall timing, and GPU timing: ${path.basename(OUT)}
`;
writeFileSync(REPORT, md);
console.log(md);
console.log('Wrote ' + OUT + ' and ' + REPORT);

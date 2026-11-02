// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchBuildTime — how long does CPatch take to BUILD a real asset?
//
// A real illustration made the timing rig hang: the cpatch arm never produced a line. Drawing is
// not where that time goes — this separates the build from the draw and puts a number on it, with
// the engine that actually ended up owning the meshes.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.SVGFILE,
  MS = +(process.env.CAP || 120000);
const SVG = readFileSync(path.resolve(ROOT, FILE), 'utf8');
const PAGE = `<!doctype html><body><canvas id=c width=256 height=256></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{psoWarmIdle:()=>true,cpatchFill:true,
  cpatchOpts:${JSON.stringify({ ...(process.env.NOGRAPH === '1' ? { graph: false } : {}), ...(process.env.SEARCH ? { search: process.env.SEARCH } : {}), ...(process.env.BATCH ? { batch: process.env.BATCH } : {}) })}});
r.setViewport(256,256); r.setFillEngine({route:'cpatch'});
window.__stage='start';
globalThis.__MANTLE_DEBUG__ = true;   // BUDGET / DEPTH / SLICE / COST / POOLN below are test hooks, read only under it
globalThis.__CP_STATS = []; globalThis.__CP_CALLS = 0;
if (${JSON.stringify(process.env.NOGRAPH === '1')}) globalThis.__CP_NO_GRAPH = true;
if (${JSON.stringify(process.env.CALLCAP || '')}) globalThis.__CP_CALL_CAP = +${JSON.stringify(process.env.CALLCAP || '0')};
if (${JSON.stringify(process.env.BUDGET || '')}) globalThis.__CP_NODE_BUDGET = +${JSON.stringify(process.env.BUDGET || '0')};
// (There is no pool-split knob: a large contour converts as its count-first pieces on every
// route, the pool's included -- cpatchConvert's contourSplit.)
globalThis.__CP_POOL_TAP = [];   // pool utilization rows, summarized into the output
if (${JSON.stringify(process.env.DEPTH || '')}) globalThis.__CP_POOL_DEPTH = +${JSON.stringify(process.env.DEPTH || '0')};   // jobs in flight per worker
if (${JSON.stringify(process.env.SLICE || '')}) globalThis.__CP_COLLECT_SLICE = +${JSON.stringify(process.env.SLICE || '0')};   // collect-pass slice ms (0 = one shot)
if (${JSON.stringify(process.env.COST || '')}) globalThis.__CP_POOL_COST = +${JSON.stringify(process.env.COST || '0')};   // in-flight work floor per worker (curves; 0 = count only)
if (${JSON.stringify(process.env.POOLN || '')}) globalThis.__CP_POOL_N = +${JSON.stringify(process.env.POOLN || '0')};
if (${JSON.stringify(process.env.WARM === '1')}) { const { warmCpatchPool } = await import('/src/renderer/cpatchWorkerPool.js'); const tw = performance.now(); await warmCpatchPool(); window.__warmMs = performance.now() - tw; }
const t0=performance.now();
const b=createBundle(gl,await importSvg(${JSON.stringify(SVG)}));
const tImport=performance.now()-t0; window.__stage='imported '+tImport.toFixed(0)+'ms';
const t1=performance.now(); r.prepareBundle(b); const tPrep=performance.now()-t1;
window.__stage='prepared '+tPrep.toFixed(0)+'ms shapes='+(b.numShapes|0);
const t2=performance.now();
if(r.awaitEngine){try{await r.awaitEngine(b,'cpatch',${MS});}catch(e){}}
const tAwait=performance.now()-t2; window.__stage='awaited '+tAwait.toFixed(0)+'ms';
const t3=performance.now(); r.beginFrame([1,1,1,1]); r.drawBundle(b,{}); r.endFrame(); const tDraw=performance.now()-t3;
const ms=b._lbMeshes||[];
const _tap=(globalThis.__CP_POOL_TAP||[]).filter(r=>r.t0>t1);   // the build's posts only (from prepare on), not the warm-up's
// WORKER-SIDE VIEW: each row carries the epoch time the job actually ran; the gaps between one job's end and the next's
// start on a worker are dispatch latency (the main thread has to handle a reply before it can send the next job).
const _ep=performance.timeOrigin; let _wbusy=0,_wfirst=Infinity,_wlast=0,_prepBusy=0; const _byW=new Map();
for(const r of _tap){ if(r.wt0==null||r.w===-1) continue; const a=r.wt0-_ep,b=r.wt1-_ep; _wbusy+=b-a; _wfirst=Math.min(_wfirst,a); _wlast=Math.max(_wlast,b); _prepBusy+=Math.max(0,Math.min(b,t2)-Math.max(a,t1)); if(!_byW.has(r.w)) _byW.set(r.w,[]); _byW.get(r.w).push([a,b]); }
let _gap=0,_gapN=0,_gapIn=0; const _cEnd=b._cpatchCollectEnd||t2; for(const rows of _byW.values()){ rows.sort((x,y)=>x[0]-y[0]); for(let k=1;k<rows.length;k++){ const gg=Math.max(0,rows[k][0]-rows[k-1][1]); _gap+=gg; _gapN++; if(rows[k-1][1]<_cEnd) _gapIn+=gg; } }
let _hN=0,_hBusy=0,_hCurves=0; for(const r of _tap){ if(r.w!==-1) continue; _hN++; _hBusy+=r.t1-r.t0; _hCurves+=r.n; }
const _wview={helper:{posts:_hN,busy:+_hBusy.toFixed(0),curves:_hCurves},wall:+(_wlast-_wfirst).toFixed(0),util:_byW.size?+(_wbusy/(_byW.size*(_wlast-_wfirst))).toFixed(2):0,prepUtil:_byW.size?+(_prepBusy/(_byW.size*(t2-t1))).toFixed(2):0,gapAvg:_gapN?+(_gap/_gapN).toFixed(1):0,gapTotal:+_gap.toFixed(0),gapInCollect:+_gapIn.toFixed(0),collectMs:+(_cEnd-t1).toFixed(0),rows:_tap.length};
let _busy=0,_first=Infinity,_last=0,_max=0,_maxN=0,_nw=new Set();
for(const r of _tap){_busy+=r.t1-r.t0;_first=Math.min(_first,r.t0);_last=Math.max(_last,r.t1);if(r.t1-r.t0>_max){_max=r.t1-r.t0;_maxN=r.n;}_nw.add(r.w);}
const _ends=_tap.map(r=>r.t1).sort((a,b)=>a-b);
const _pool={posts:_tap.length,workers:_nw.size,wall:+(_last-_first).toFixed(0),util:_tap.length?+(_busy/(_nw.size*(_last-_first))).toFixed(2):0,largest:+_max.toFixed(0),largestCurves:_maxN,tail:_ends.length>1?+(_ends[_ends.length-1]-_ends[_ends.length-2]).toFixed(0):0,tail5:_ends.length>5?+(_ends[_ends.length-1]-_ends[_ends.length-6]).toFixed(0):0,
  startGap:+(_first-t2).toFixed(0),postPool:+((t2+tAwait)-_last).toFixed(0)};   // from awaitEngine's start to the first dispatch; from the last answer to the build landing
window.__out={ shapes:(b.numShapes|0), warm:+((window.__warmMs||0).toFixed(1)), import:+tImport.toFixed(1), prepare:+tPrep.toFixed(1), pool:_pool, wview:_wview,
  await:+tAwait.toFixed(1), firstDraw:+tDraw.toFixed(1),
  drew:(function(){const e=(r.debugStats.engines&&r.debugStats.engines.draws)||{};return Object.keys(e).filter(k=>e[k]>0).map(k=>k+':'+e[k]).join('+')||'none';})(),
  via:(function(){const v=(r.debugStats.engines&&r.debugStats.engines.viaRoute)||{};return Object.keys(v).map(k=>k+':'+v[k]).join(' ')||'-';})(),
  uni:(r.debugStats.unifiedFillDraws|0), rows:(function(){
    const m=b.metaFloats, st=b.metaFloatsPerShape|0, n=b.numShapes|0; if(!m||!st) return '-';
    const ms=b._lbMeshes||[]; let stroke=0, coverFill=0;
    for(let s=0;s<n;s++){ const isStroke = m[s*st+11]>0 && m[s*st+12]>0;
      if (isStroke) { stroke++; continue; }
      const me=ms[s]; if(!me||me.slug||!(me.vertexCount|0)) coverFill++; }
    return 'strokeRows='+stroke+' coverFillRows='+coverFill;})(),
  meshes:ms.length, cpatch:ms.filter(m=>m&&m.cpatch).length, prim:ms.filter(m=>m&&m.prim).length,
  slug:ms.filter(m=>m&&m.slug).length, built:(b._cpatchBuilt|0), bail:(b._cpatchBail||null),
  blown:(globalThis.__CP_STATS||[]).length, calls:(globalThis.__CP_CALLS|0),
  worst:(globalThis.__CP_STATS||[]).slice().sort((x,y)=>(y.nodes|0)-(x.nodes|0))[0]||null };
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
// A HEADLESS PAGE IS A BACKGROUND TAB: Chrome lowers a hidden renderer's thread priorities, main
// thread included, and on Apple Silicon that confines them to the efficiency cores. A real app
// converts in a FOREGROUND tab. FG=0 keeps the backgrounded launch for comparison.
const fgArgs =
  process.env.FG === '0'
    ? []
    : [
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
      ];
const br = await launchBrowser({
  headless: process.env.HEADFUL === '1' ? false : 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', ...fgArgs],
  protocolTimeout: MS + 60000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
let out = null;
try {
  await pg.waitForFunction(() => window.__ready === true, { timeout: MS + 30000, polling: 200 });
  out = await pg.evaluate(() => window.__out);
} catch (e) {
  const st = await pg.evaluate(() => window.__stage).catch(() => '?');
  console.log('  DID NOT FINISH — last stage reached: ' + st);
}
await br.close();
server.close();
if (out) console.log('  ' + JSON.stringify(out));

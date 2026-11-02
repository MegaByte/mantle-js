// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// memoryBudgetRenderSmoke -- on a real GL context: (1) getMemoryStats() is byte-exact against a page-level spy on the real
// texImage2D / texImage3D / bufferData / renderbufferStorage calls, through a full scene (filter, group, mask, gradient, curves) and back to
// zero after dispose; (2) a scene drawn under a memory budget that refuses the group atlas and evicts the filter results, scratch targets and
// point lists renders the same pixels as the unbudgeted scene (and as groupAtlas:false, the path the refusal takes), while every frame end
// stays inside the budget.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 256;
const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}"><defs>
<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3"/></filter>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e33"/><stop offset="1" stop-color="#33e"/></linearGradient>
<mask id="m"><circle cx="190" cy="70" r="42" fill="#fff"/><circle cx="215" cy="85" r="30" fill="#555"/></mask></defs>
<rect width="${W}" height="${W}" fill="#f4f4f0"/>
<path d="M20 120 C 40 30 110 30 130 120 S 60 220 20 120Z" fill="url(#g)" stroke="#222" stroke-width="3"/>
<circle cx="80" cy="190" r="26" fill="#2a6" filter="url(#f)"/>
<g opacity="0.55"><rect x="110" y="110" width="90" height="90" fill="#f80"/><circle cx="190" cy="190" r="40" fill="#08f"/></g>
<g opacity="0.7"><rect x="150" y="20" width="80" height="60" fill="#0a0"/><circle cx="170" cy="60" r="25" fill="#a0a"/></g>
<rect x="140" y="20" width="110" height="100" fill="#fa0" mask="url(#m)"/>
</svg>`;
const OTHER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}"><rect width="${W}" height="${W}" fill="#fff"/><path d="M30 30 C 100 -10 160 90 230 40 L 220 220 C 150 170 90 250 30 220Z" fill="#c63" stroke="#000" stroke-width="2"/></svg>`;
const STATIC_CP = (() => {
  const points = Array.from({ length: 96 }, (_, i) => {
    const angle = (2 * Math.PI * i) / 96,
      radius = i % 2 ? 240 : 300;
    return [450 + radius * Math.cos(angle), 450 + radius * Math.sin(angle)];
  });
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 900 900"><path fill="#2166b4" fill-opacity=".47" d="M' +
    points.map((p) => p.join(',')).join('L') +
    'Z"/></svg>'
  );
})();
const HTML = `<!DOCTYPE html><html><body><script type="module">
const P = WebGL2RenderingContext.prototype;
// The oracle: bytes per object from the allocating calls alone, tracked on the PROTOTYPE so it sees every renderer's context.
const FMT = { 0x8C43: 4, 0x8058: 4, 0x8229: 1, 0x8814: 16, 0x8235: 4, 0x881A: 8, 0x88F0: 4, 0x822E: 4, 0x8D48: 1, 0x8CAC: 4 };   // SRGB8_ALPHA8 RGBA8 R8 RGBA32F R32I RGBA16F D24S8 R32F STENCIL8 D32F
const live = new Map(); let unit = 0; const tb = new Map(), bb = new Map(); let rb = null;
const wrap = (n, f) => { const o = P[n]; P[n] = function (...a) { const r = o.apply(this, a); f.call(this, a); return r; }; };
wrap('activeTexture', (a) => { unit = a[0]; });
wrap('bindTexture', (a) => { tb.set(a[0] + ':' + unit, a[1]); });
wrap('bindBuffer', (a) => { bb.set(a[0], a[1]); });
wrap('bindRenderbuffer', (a) => { rb = a[1]; });
const bpt = (internal, format, type) => { if (FMT[internal]) return FMT[internal]; throw new Error('oracle: unknown internal format 0x' + internal.toString(16)); };
wrap('texImage2D', (a) => { if (a.length >= 9) { const o = tb.get(a[0] + ':' + unit); if (o) { const r = live.get(o) || { l: new Map() }; r.l.set(a[1], a[3] * a[4] * bpt(a[2])); live.set(o, r); } } else if (a.length === 6) throw new Error('oracle: DOM-source texImage2D'); });
wrap('texImage3D', (a) => { const o = tb.get(a[0] + ':' + unit); if (o) { const r = live.get(o) || { l: new Map() }; r.l.set(a[1], a[3] * a[4] * a[5] * bpt(a[2])); live.set(o, r); } });
wrap('bufferData', (a) => { const o = bb.get(a[0]); if (o) live.set(o, { l: new Map([[0, typeof a[1] === 'number' ? a[1] : a[1].byteLength]]) }); });
wrap('renderbufferStorage', (a) => { if (rb) live.set(rb, { l: new Map([[0, a[2] * a[3] * bpt(a[1])]]) }); });
for (const n of ['deleteTexture', 'deleteBuffer', 'deleteRenderbuffer']) wrap(n, (a) => { live.delete(a[0]); });
const oracle = () => { let s = 0; for (const r of live.values()) for (const v of r.l.values()) s += v; return s; };
const { importSvg, createBundle, createRenderer, createShapeMorph, loadShaders, setDiagnostics } = await import('/src/index.js');
const {peekLedger} = await import('/src/renderer/memoryLedger.js');
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const wait = (ms) => new Promise((x) => setTimeout(x, ms));
// Hold actual LB replies only during the staged-publication control below.
const NativeWorker = Worker, heldLb = [];
let holdLb = false, heldLbId = null, heldLbDone = false;
globalThis.Worker = class extends NativeWorker {
  constructor(url, opts) {
    super(url, opts); this.lb = String(url).includes('lbBuild.worker.js');
    this.addEventListener('message', e => {
      if (holdLb && this.lb && e.data?.id === heldLbId) {
        heldLb.push({worker: this, data: e.data});
        if (e.data.kind !== 'lbPartial') heldLbDone = true;
      } else this.callback?.(e);
    });
  }
  postMessage(data, ...rest) {
    if (holdLb && this.lb && data?.id) heldLbId = data.id;
    return super.postMessage(data, ...rest);
  }
  set onmessage(fn) { this.callback = fn; }
  get onmessage() { return this.callback; }
};
const out = {};
async function session(label, opts, budgetOf) {
  const c = document.createElement('canvas'); c.width = ${W}; c.height = ${W}; document.body.appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const before = oracle();
  const r = createRenderer(gl, shaders, opts);
  r.setViewport(${W}, ${W});
  r.setFillEngine({ route: 'lb', kernel: 'slug' });   // the unified route
  const a = createBundle(gl, await importSvg(${JSON.stringify(SCENE)})), b = createBundle(gl, await importSvg(${JSON.stringify(OTHER)}));
  const px = new Uint8Array(${W} * ${W} * 4);
  const frame = async (list) => { r.beginFrame([1, 1, 1, 1]); for (const x of list) r.drawBundle(x, {}); r.endFrame(); await wait(8); };
  const warm = await r.warmScene([
    { name: 'filtered', bundle: a, engine: 'lb', draw: () => frame([a]) },
    { name: 'plain', bundle: b, engine: 'lb', draw: () => frame([b]) },
  ], { maxPasses: 64, readyTimeoutMs: 60000, fenceTimeoutMs: 60000 });
  if (!warm.complete) throw new Error('Memory scene preparation incomplete: ' + JSON.stringify(warm));
  for (let i = 0; i < 6; i++) { await frame([a]); await frame([b]); }
  const o = { label };
  o.statsTotal = r.getMemoryStats().gpu.totalBytes; o.oracleTotal = oracle() - before;
  if (budgetOf) {
    const s = r.getMemoryStats();
    const c = (n) => (s.gpu.byCategory[n] ? s.gpu.byCategory[n].bytes : 0);
    const droppable = c('filterCache') + c('pool') + c('atlas') + c('points') + c('staticCache');
    o.warmTotal = s.gpu.totalBytes; o.droppable = droppable; o.cats = Object.fromEntries(Object.entries(s.gpu.byCategory).map(([k, v]) => [k, v.bytes]));
    o.budget = s.gpu.totalBytes - Math.floor(droppable / 2);   // below the working set of the filtered frames: they must exceed it, honestly
    r.setMemoryBudget(o.budget);
  }
  o.frameEnds = []; o.overs = [];
  const sample = () => { const m = r.getMemoryStats(); o.frameEnds.push(m.gpu.totalBytes); o.overs.push(m.policy.overBudgetBytes); };
  for (let i = 0; i < 12; i++) { await frame([a]); sample(); await frame([b]); sample(); }
  await frame([a]); gl.readPixels(0, 0, ${W}, ${W}, gl.RGBA, gl.UNSIGNED_BYTE, px); o.pxA = Array.from(px);
  await frame([b]); gl.readPixels(0, 0, ${W}, ${W}, gl.RGBA, gl.UNSIGNED_BYTE, px); o.pxB = Array.from(px);
  const s = r.getMemoryStats();
  o.cat = Object.fromEntries(Object.entries(s.gpu.byCategory).map(([k, v]) => [k, v.bytes]));
  o.policy = s.policy; o.statsTotal2 = s.gpu.totalBytes; o.oracleTotal2 = oracle() - before;
  o.bundleRows = s.bundles.length; o.cpu = s.cpu.bundleBytes;
  a.dispose(); b.dispose(); r.dispose();
  o.afterDispose = r.getMemoryStats().gpu.totalBytes; o.oracleAfter = oracle() - before;
  c.remove();
  return o;
}
out.free = await session('free', {});
out.noAtlas = await session('noAtlas', { groupAtlas: false });
out.budget = await session('budget', {}, true);
out.pinned = [];
for (const route of ['lb', 'cpatch']) {
  const c = document.createElement('canvas'); c.width = c.height = ${W};
  const gl = c.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  const device = gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
  const r = createRenderer(gl, shaders, { groupAtlas: false }); await r.ready;
  r.setViewport(${W}, ${W}); r.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(${JSON.stringify(readFileSync(path.join(ROOT, 'examples/smoke/memoryBudget__BLOBS.svg'), 'utf8'))}, { preserveViewport: true }));
  r.setMemoryBudget(r.getMemoryStats().gpu.totalBytes + 1);
  const warnings = []; setDiagnostics({ onWarn: (...a) => warnings.push(a.join(' ')) });
  const resource = route === 'lb' ? 'loopBlinn mesh' : 'CPatch plane';
  for (let i = 0; i < 1500 && !r.getMemoryStats().policy.refusals[resource]; i++) { r.prepareBundle(b); await wait(40); }
  const draw = () => { r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); const p = new Uint8Array(${W} * ${W} * 4); gl.readPixels(0,0,${W},${W},gl.RGBA,gl.UNSIGNED_BYTE,p); return Array.from(p); };
  for (let i = 0; i < 8; i++) { draw(); await wait(20); }
  for (let i = 0; i < 1500 && b._lbWorkerPendingGen !== undefined; i++) await wait(40);
  const image = draw(), policy = r.getMemoryStats().policy, engines = r.debugStats.engines;
  r.setFillEngine({ route: 'none', kernel: 'slug' });
  for (let i = 0; i < 8; i++) { draw(); await wait(20); }
  const reference = draw();
  out.pinned.push({ route, warnings, policy, image, reference, device, engines, workerPending: b._lbWorkerPendingGen !== undefined });
  setDiagnostics({ onWarn: null }); b.dispose(); r.dispose();
}
{
  holdLb = true;
  const c = document.createElement('canvas'); c.width = c.height = ${W};
  const gl = c.getContext('webgl2', {antialias: false, preserveDrawingBuffer: true});
  const r = createRenderer(gl, shaders, {lbAdoptShapes: 4, lbAdoptMs: 0, groupAtlas: false});
  await r.ready; r.setViewport(${W}, ${W}); r.setFillEngine({route: 'lb', kernel: 'slug', primitives: 'off'});
  const b = createBundle(gl, await importSvg(${JSON.stringify(readFileSync(path.join(ROOT, 'examples/smoke/memoryBudget__BLOBS.svg'), 'utf8'))}, {preserveViewport: true}));
  r.awaitLbReady(b, 60000).catch(() => false);
  const deadline = performance.now() + 60000;
  while (!heldLbDone) { if (performance.now() > deadline) throw Error('Staged LB worker did not finish'); await wait(20); }
  const batches = heldLb.filter(x => x.data.kind === 'lbPartial');
  const sizes = batches.map(x => (x.data.meshes || []).reduce((sum, m) => sum + (m?.verts?.byteLength || 0), 0));
  const room = Math.max(...sizes) + 1, total = sizes.reduce((a,b) => a+b, 0);
  if (batches.length < 2 || !(total > 2 * room)) throw Error('Staged control needs multiple real worker batches');
  const before = r.getMemoryStats().gpu.totalBytes, warnings = [];
  setDiagnostics({onWarn: (...a) => warnings.push(a.join(' '))}); r.setMemoryBudget(before + room);
  holdLb = false;
  for (const {worker, data} of heldLb) worker.callback({data});
  const afterReplay = r.getMemoryStats().gpu.totalBytes, denied = !!b._lbMemDenied;
  const draw = () => { r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); };
  const warm = await r.warmScene([{name: 'staged budget', draw}], {maxPasses: 128, readyTimeoutMs: 60000, fenceTimeoutMs: 60000});
  if (!warm.complete) throw Error('Staged budget warming incomplete');
  const read = () => { draw(); const p = new Uint8Array(${W} * ${W} * 4); gl.readPixels(0,0,${W},${W},gl.RGBA,gl.UNSIGNED_BYTE,p); return Array.from(p); };
  const image = read(), engines = r.debugStats.engines, policy = r.getMemoryStats().policy;
  r.setFillEngine({route: 'none', kernel: 'slug'});
  for (let i=0; i<8; i++) { draw(); await wait(20); }
  out.staged = {batches: batches.length, room, total, before, afterReplay, denied, warnings, engines, policy, image, reference: read(), error: gl.getError()};
  setDiagnostics({onWarn: null}); b.dispose(); r.dispose();
}
{
  heldLb.length = 0; heldLbId = null; heldLbDone = false;
  const c = document.createElement('canvas'); c.width = c.height = ${W};
  const gl = c.getContext('webgl2', {antialias: false, preserveDrawingBuffer: true});
  const r = createRenderer(gl, shaders, {groupAtlas: false}); await r.ready; r.setViewport(${W}, ${W});
  const doc = x => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path id="a" d="M'+x+' 4h12v12h-12Z" fill="#3366cc" fill-opacity=".5"/></svg>';
  const a = createBundle(gl, await importSvg(doc(3), {preserveViewport: true}));
  const b = createBundle(gl, await importSvg(doc(15), {preserveViewport: true}));
  const m = createShapeMorph(gl, a, b); m.setT(.5);
  const draw = () => { r.beginFrame([1,1,1,1]); r.drawBundle(m); r.endFrame(); };
  r.setFillEngine({route:'none',kernel:'slug',primitives:'off'});
  await r.warmScene([{draw}],{maxPasses:128,readyTimeoutMs:60000,fenceTimeoutMs:60000});
  holdLb = true; r.setFillEngine({route:'lb',kernel:'slug',primitives:'off'}); r.awaitLbReady(m,60000).catch(()=>false);
  const deadline = performance.now()+60000;
  while (!heldLbDone) { if(performance.now()>deadline)throw Error('Morph worker did not finish');await wait(20); }
  const reply = heldLb.find(x=>x.data.kind==='morph');
  const packedBytes = (reply?.data.meshes||[]).reduce((n,p)=>n+(p?.vbo?.byteLength||0)+(p?.segments||[]).reduce((z,v)=>z+(v?.vbo?.byteLength||0),0),0);
  if(!packedBytes)throw Error('No actual pair mesh in held morph reply');
  const before = r.getMemoryStats().gpu.totalBytes, warnings = [];
  setDiagnostics({onWarn:(...a)=>warnings.push(a.join(' '))});r.setMemoryBudget(before+1);holdLb=false;
  for(const {worker,data}of heldLb)worker.callback({data});
  const warm = await r.warmScene([{draw}],{maxPasses:128,readyTimeoutMs:60000,fenceTimeoutMs:60000});
  if(!warm.complete)throw Error('Morph budget fallback warming incomplete');
  const read=()=>{draw();const p=new Uint8Array(${W}*${W}*4);gl.readPixels(0,0,${W},${W},gl.RGBA,gl.UNSIGNED_BYTE,p);return Array.from(p);};
  const image=read(),engines=JSON.parse(JSON.stringify(r.debugStats.engines));
  const denied=!!m.bundle._lbMemDenied, meshes=!!m.bundle._morphMeshes,policy=r.getMemoryStats().policy;
  r.setFillEngine({route:'none',kernel:'slug'});for(let i=0;i<4;i++)draw();
  out.morph={packedBytes,before,denied,meshes,warnings,engines,policy,image,reference:read(),error:gl.getError()};
  setDiagnostics({onWarn:null});r.setMemoryBudget(Infinity);r.setFillEngine({route:'lb',kernel:'slug',primitives:'off'});
  const baselineUse=r.getLoopBlinnMemoryUse(), admitted=createShapeMorph(gl,a,b);admitted.setT(.5);
  const admitDraw=()=>{r.beginFrame([1,1,1,1]);r.drawBundle(admitted);r.endFrame();};
  await r.awaitLbReady(admitted,60000);
  const admittedWarm=await r.warmScene([{draw:admitDraw}],{maxPasses:128,readyTimeoutMs:60000,fenceTimeoutMs:60000});
  if(!admittedWarm.complete)throw Error('Unlimited morph warming incomplete');admitDraw();
  out.morph.admittedUse=r.getLoopBlinnMemoryUse();out.morph.baselineUse=baselineUse;
  out.morph.admittedMeshes=!!admitted.bundle._morphMeshes;
  out.morph.admittedDraws=r.debugStats.engines.draws.lb||0;
  admitted.dispose();out.morph.disposedUse=r.getLoopBlinnMemoryUse();
  m.dispose();a.dispose();b.dispose();r.dispose();
}
{
  const c = document.createElement('canvas'); c.width = c.height = ${W};
  const gl = c.getContext('webgl2', {antialias: false, preserveDrawingBuffer: true});
  const r = createRenderer(gl, shaders, {cpatchFill: true, cpatchOpts: {gpuBlend: true}, groupAtlas: false});
  await r.ready; r.setViewport(${W}, ${W}); r.setFillEngine({route: 'none', kernel: 'slug'});
  const doc = x => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M'+x+' 4h12v12h-12Z" fill="#3366cc" fill-opacity=".5"/></svg>';
  const a = createBundle(gl, await importSvg(doc(3))), b = createBundle(gl, await importSvg(doc(15)));
  const m = createShapeMorph(gl, a, b), bundle = m.bundle || m; m.setT(.37);
  const draw = () => {r.beginFrame([1,1,1,1]);r.drawBundle(m);r.endFrame();};
  const warm = async name => {
    const result = await r.warmScene([{name, draw}], {maxPasses:128, readyTimeoutMs:60000, fenceTimeoutMs:60000});
    if (!result.complete) throw Error(name + ' warming incomplete');
  };
  const read = () => {draw();const px=new Uint8Array(${W}*${W}*4);gl.readPixels(0,0,${W},${W},gl.RGBA,gl.UNSIGNED_BYTE,px);return Array.from(px);};
  await warm('raw CPatch-budget reference');
  const reference = read(), before = r.getMemoryStats().gpu.totalBytes, warnings = [];
  r.setMemoryBudget(before+1); setDiagnostics({onWarn:(...a)=>warnings.push(a.join(' '))});
  r.setFillEngine({route:'cpatch',kernel:'slug'});
  const deadline = performance.now()+60000;
  while (!r.getMemoryStats().policy.refusals['CPatch plane']?.count) {
    if (performance.now()>deadline) throw Error('CPatch morph did not report its budget refusal');
    r.prepareBundle(bundle); draw(); await wait(20);
  }
  await warm('refused CPatch morph');
  const image=read(), refused=r.getMemoryStats(), refusedBlend=!!bundle._cpatchBlend,
    refusedBuilt=bundle._cpatchBuilt||0, refusedDraws=r.debugStats.engines.draws.cpatch||0;
  r.setMemoryBudget(Infinity);
  r.prepareBundle(bundle); await warm('admitted CPatch morph');
  const admittedImage=read(), admitted=r.getMemoryStats(), admittedBlend=!!bundle._cpatchBlend,
    admittedDraws=r.debugStats.engines.draws.cpatch||0;
  out.cpatchMorph={before, reference, image, warnings, refused, refusedBlend, refusedBuilt, refusedDraws,
    admittedImage, admitted, admittedBlend, admittedDraws, error:gl.getError()};
  setDiagnostics({onWarn:null}); m.dispose();a.dispose();b.dispose();r.dispose();
}
out.cpatchStatic = [];
for (const wide of [false, true]) {
  const c = document.createElement('canvas'); c.width = c.height = ${W};
  const gl = c.getContext('webgl2', {antialias:false, preserveDrawingBuffer:true});
  const r = createRenderer(gl, shaders, {cpatchOpts:{pool:false}, unifiedFillCurveTex:!wide, groupAtlas:false, aacPoints:false});
  await r.ready; r.setViewport(${W},${W});
  r.setFillEngine({route:'none',kernel:'aac',primitives:'off'});
  const b = createBundle(gl, await importSvg(${JSON.stringify(STATIC_CP)}, {preserveViewport:true}));
  const draw = () => {r.beginFrame([1,1,1,1]);r.drawBundle(b);r.endFrame();};
  const warm = async () => {
    const result = await r.warmScene([{draw}], {maxPasses:64,fenceTimeoutMs:60000});
    if (!result.complete) throw Error('Static CPatch budget warming incomplete');
  };
  const read = () => {const px=new Uint8Array(${W}*${W}*4);gl.readPixels(0,0,${W},${W},gl.RGBA,gl.UNSIGNED_BYTE,px);return Array.from(px);};
  await warm(); draw();
  const reference=read(), before=r.getMemoryStats().gpu.totalBytes, warnings=[];
  const curveBytes=peekLedger(gl).bytesOf(b.curveTex);
  r.setMemoryBudget(before+1);setDiagnostics({onWarn:(...a)=>warnings.push(a.join(' '))});
  r.setFillEngine({route:'cpatch',kernel:'aac',primitives:'off'});r.prepareBundle(b);
  await warm();draw();
  const refused=r.getMemoryStats(),image=read(),refusedDraws=r.debugStats.engines.draws.cpatch||0;
  const refusedCurveBytes=peekLedger(gl).bytesOf(b.curveTex);
  r.setMemoryBudget(Infinity);r.prepareBundle(b);await warm();draw();
  out.cpatchStatic.push({wide,before,curveBytes,refusedCurveBytes,refused,image,reference,warnings,
    refusedDraws,admitted:r.getMemoryStats(),admittedDraws:r.debugStats.engines.draws.cpatch||0,error:gl.getError()});
  setDiagnostics({onWarn:null});b.dispose();r.dispose();
}
globalThis.Worker = NativeWorker;
window.__out = out; window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--no-sandbox', '--enable-unsafe-swiftshader']
      : ['--no-sandbox', '--use-gl=angle', '--use-angle=metal'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text());
});
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 60000,
});
await page.waitForFunction(() => window.__ready === true, {
  timeout: pageTimeoutFor(180000),
  polling: 100,
});
const o = await page.evaluate(() => window.__out);
await browser.close();
server.close();
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
for (const k of ['free', 'noAtlas', 'budget']) {
  const s = o[k];
  ok(
    s.statsTotal === s.oracleTotal && s.statsTotal > 0,
    `${k}: after warm-up the memory ledger (${s.statsTotal}) equals the page-level spy (${s.oracleTotal})`,
  );
  ok(
    s.statsTotal2 === s.oracleTotal2,
    `${k}: and after the measured frames (${s.statsTotal2} == ${s.oracleTotal2})`,
  );
  ok(
    s.afterDispose === 0 && s.oracleAfter === 0,
    `${k}: both read zero after the bundles and the renderer are disposed (${s.afterDispose} / ${s.oracleAfter})`,
  );
  ok(
    s.bundleRows >= 2 && s.cpu > 0,
    `${k}: per-bundle rows (${s.bundleRows}) and CPU bytes (${s.cpu})`,
  );
}
const same = (a, b) => {
  let n = 0,
    mx = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d) {
      n++;
      if (d > mx) mx = d;
    }
  }
  return { n, mx };
};
for (const s of o.pinned) {
  if (process.env.MANTLE_TEST_GL === 'metal')
    ok(
      /Metal/.test(s.device) && !/SwiftShader/i.test(s.device),
      s.route + ': physical device ' + s.device,
    );
  const resource = s.route === 'lb' ? 'loopBlinn mesh' : 'CPatch plane';
  ok(s.policy.refusals[resource]?.count > 0, s.route + ': pinned engine refusal is observable');
  ok(
    !s.workerPending && !(s.engines.draws.lb > 0) && !(s.engines.draws.cpatch > 0),
    s.route + ': late worker completion cannot publish a refused engine',
  );
  ok(
    s.warnings.filter(
      (w) =>
        w.includes(resource) &&
        w.includes('cover/Slug fallback') &&
        w.includes('explicitly pinned'),
    ).length === 1,
    s.route + ': exactly one diagnostic explains the fallback',
  );
  const delta = same(s.image, s.reference),
    ink = s.image.filter((v, i) => i % 4 === 1 && v < 200).length;
  ok(
    delta.mx <= 1 && ink > 0,
    s.route +
      ': budget fallback matches nonblank cover/Slug within shader rounding (' +
      JSON.stringify({ delta, ink }) +
      ')',
  );
}
const st = o.staged;
ok(st.before === st.afterReplay, 'worker publication did not upload GPU meshes');
ok(
  st.denied && !(st.engines.draws.lb > 0) && st.policy.refusals['loopBlinn mesh']?.count > 0,
  'accumulated CPU-staged mesh set is refused, even when each worker batch fits',
);
ok(
  st.warnings.filter((w) => w.includes('loopBlinn mesh') && w.includes('cover/Slug fallback'))
    .length === 1,
  'staged refusal explains the fallback once',
);
const stagedDelta = same(st.image, st.reference);
ok(
  stagedDelta.mx === 0 && st.image.some((v, i) => i % 4 === 1 && v < 200) && st.error === 0,
  'staged refusal draws the exact nonblank Slug reference without GL errors',
);
const mo = o.morph,
  md = same(mo.image, mo.reference);
ok(
  mo.packedBytes > 1 && mo.denied && !mo.meshes && !(mo.engines.draws.lb > 0),
  'late morph publication refuses the complete pair mesh and submits no LB draws',
);
ok(
  mo.policy.refusals['loopBlinn mesh']?.count > 0 &&
    mo.warnings.filter((w) => w.includes('loopBlinn mesh') && w.includes('cover/Slug fallback'))
      .length === 1,
  'morph refusal is accounted and explains pinned fallback once',
);
ok(
  md.mx === 0 && mo.image.some((v, i) => i % 4 === 1 && v < 200) && mo.error === 0,
  'refused morph matches its exact nonblank Slug pose without GL errors',
);
ok(
  mo.admittedMeshes &&
    mo.admittedDraws > 0 &&
    mo.admittedUse > mo.baselineUse &&
    mo.disposedUse === mo.baselineUse,
  'unlimited morph still draws LB and releases its accounted mesh bytes on disposal',
);
const cp = o.cpatchMorph,
  cpd = same(cp.image, cp.reference),
  cpa = same(cp.admittedImage, cp.reference);
ok(
  cp.refused.policy.refusals['CPatch plane']?.count > 0 &&
    !cp.refusedBlend &&
    !cp.refusedBuilt &&
    !cp.refusedDraws,
  'pinned CPatch morph refuses its live and blend planes before publishing analytic geometry',
);
ok(
  cp.refused.gpu.totalBytes === cp.before && cp.refused.policy.overBudgetBytes === 0,
  'refused CPatch morph allocates no optional GPU bytes',
);
ok(
  cp.warnings.filter(
    (w) =>
      w.includes('CPatch plane') &&
      w.includes('cover/Slug fallback') &&
      w.includes('explicitly pinned'),
  ).length === 1,
  'the CPatch morph budget refusal explains the pinned fallback once',
);
ok(
  cpd.mx === 0 && cp.image.some((v, i) => i % 4 === 1 && v < 200),
  'refused CPatch morph preserves its exact nonblank raw pose',
);
ok(
  cp.admittedBlend &&
    cp.admittedDraws > 0 &&
    cp.admitted.gpu.totalBytes > cp.before &&
    cpa.mx <= 1 &&
    cp.error === 0,
  'raising the budget restores actual CPatch blending and nonblank matching pixels without GL errors',
);
for (const s of o.cpatchStatic) {
  const delta = same(s.image, s.reference);
  ok(
    s.curveBytes === 65536 && s.refusedCurveBytes === s.curveBytes,
    'static CPatch ' + (s.wide ? 'wide' : 'narrow') + ': existing coefficient plane has no growth',
  );
  ok(
    s.refused.gpu.totalBytes === s.before &&
      !s.refusedDraws &&
      s.refused.policy.refusals['CPatch plane']?.count === 1,
    'static CPatch: optional stream refuses before allocation and is not repacked by later draws',
  );
  ok(
    s.warnings.filter((w) => w.includes('CPatch plane') && w.includes('explicitly pinned'))
      .length === 1,
    'static CPatch: one diagnostic explains the pinned fallback',
  );
  ok(
    delta.mx === 0 && s.image.some((v, i) => i % 4 === 1 && v < 200),
    'static CPatch: refused stream preserves the exact nonblank raw AAC image',
  );
  ok(
    s.admittedDraws > 0 && s.admitted.gpu.totalBytes > s.before && s.error === 0,
    'static CPatch: raising the budget restores actual analytic drawing',
  );
}
const bd = o.budget,
  fr = o.free,
  na = o.noAtlas;

// Scene B has no filter: after its frame everything scene A used is idle, so the endFrame safe point brings the total inside the budget.
// Scene A's frame holds its own filter result and scratch targets in use (never evicted), so its frame end may stand above the budget, and the
// report says by exactly how much.
ok(
  bd.frameEnds.filter((_, i) => i % 2 === 1).every((t) => t <= bd.budget),
  `after every unfiltered frame the total is inside the ${bd.budget}-byte budget (max ${Math.max(...bd.frameEnds.filter((_, i) => i % 2 === 1))}; warm total ${bd.warmTotal}, droppable ${bd.droppable})`,
);
ok(
  bd.frameEnds.every((t, i) => bd.overs[i] === Math.max(0, t - bd.budget)),
  'overBudgetBytes equals the excess at every frame end (nothing is hidden)',
);
ok(
  bd.frameEnds.filter((_, i) => i % 2 === 0).every((t) => t - bd.budget < bd.droppable),
  'and even the filtered frame stays below the budget plus what that frame uses',
);
ok(
  Object.keys(bd.policy.evictions).length > 0,
  `the budget evicted: ${JSON.stringify(bd.policy.evictions)}`,
);
for (const [nm, d] of [
  ['A', same(bd.pxA, na.pxA)],
  ['B', same(bd.pxB, na.pxB)],
])
  ok(
    d.n === 0,
    `scene ${nm}: the budgeted render is pixel-identical to groupAtlas:false (${d.n} differ, max ${d.mx})`,
  );
for (const [nm, d] of [
  ['A', same(bd.pxA, fr.pxA)],
  ['B', same(bd.pxB, fr.pxB)],
])
  ok(
    d.n <= 40 && d.mx <= 4,
    `scene ${nm}: and within rounding of the unbudgeted render (${d.n} pixels differ, max ${d.mx})`,
  );
let ink = 0;
for (let i = 0; i < bd.pxA.length; i += 4) if (bd.pxA[i] < 240 || bd.pxA[i + 1] < 240) ink++;
ok(ink > 5000, `the budgeted scene is not blank (${ink} inked pixels)`);
if (fail)
  console.log(
    'DIAG',
    JSON.stringify({ free: { ...fr, pxA: 0, pxB: 0 }, budget: { ...bd, pxA: 0, pxB: 0 } }),
  );
process.exit(fail ? 1 : 0);

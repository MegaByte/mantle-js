// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphFilterGraphRouteSmoke — verifies the offscreen filter pipeline: a morph
// with an offscreen filter (feGaussianBlur = single-kind; and a multi-primitive
// graph) composes with the LB route. The morphed shape is rendered into an
// isolated RT (the composed draw), then the filter machinery (blurShapeFbo /
// evaluateGraph) runs and composites over the backdrop.
// Checks per filter: route + composed engage; the result ≈ Slug (so the blur
// actually applied — a dropped blur would be a sharp shape, diverging hugely);
// and a soft halo exists beyond the sharp silhouette (blur bled out). Metal headful.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
function ell(cx, cy, rx, ry) {
  const k = 0.5522847498;
  return (
    `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} ` +
    `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} ` +
    `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} ` +
    `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`
  );
}
// Filter b is a single blur. Filter g adds tint and offset to retain a graph.
const defs =
  `<defs>` +
  `<filter id="b" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3"/></filter>` +
  `<filter id="g" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2.5" result="bl"/>` +
  `<feColorMatrix in="bl" type="matrix" values="0 0 0 0 0.8  0 0 0 0 0.2  0 0 0 0 0.2  0 0 0 1 0"/><feOffset dx="3" dy="2"/></filter></defs>`;
const svg = (d, fid) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${defs}` +
  `<path d="${d}" fill="#3366cc" filter="url(#${fid})"/></svg>`;

const HTML = (fid) => `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders, createFilterParams } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const sourceSections=await importSvg(${JSON.stringify(svg(ell(100, 100, 60, 60), '__F__'))});
const bSrc=createBundle(gl,sourceSections), bDst=createBundle(gl,await importSvg(${JSON.stringify(svg(ell(100, 100, 80, 42), '__F__'))}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function px(u,x,y){const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
// soft halo: pixels that are partially inked (not white, not full-saturation) — blur produces many.
const soft=u=>{let n=0;for(let i=0;i<u.length;i+=4){const r=u[i],g=u[i+1],b=u[i+2];if((r<240||g<240||b<240)&&(r>180&&g>180))n++;}return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto');
  // Wait for asynchronous morph preparation before comparing routes.
  for (let w9 = 0; w9 < 40; w9++) {
    if (draw(0.5).routed > 0) break;
    await new Promise(r9 => setTimeout(r9, 25));
  }
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,inkSlug:ink(a),inkGpu:ink(b),softGpu:soft(b),softSlug:soft(a),mx,dpx}); }
  if (${JSON.stringify(fid)} === 'b') {
    let draws=0;const nativeDraw=gl.drawArrays.bind(gl);gl.drawArrays=(...args)=>{draws++;return nativeDraw(...args);};
    const render=()=>{clr();renderer.drawBundle(morph);return read();};
    const fp=createFilterParams(morph.bundle),initial=render();
    const firstMoved=fp.set('f1',{sigmaX:.1});let n=draws;const first=render(),firstDraws=draws-n;
    const generation=fp.generation,secondMoved=fp.set('f1',{sigmaX:.1});n=draws;const second=render(),secondDraws=draws-n;
    const afterGeneration=fp.generation;fp.reset();const reset=render();
    out.parameterNoop={firstMoved,secondMoved,generation,afterGeneration,firstDraws,secondDraws,
      same:first.every((v,i)=>v===second[i]),reset:initial.every((v,i)=>v===reset[i])};
    gl.drawArrays=nativeDraw;
  }
  if (${JSON.stringify(fid)} === 'g') {
    const shared=createBundle(gl,sourceSections);
    const delta=(a,b)=>{let max=0,changed=0;for(let k=0;k<a.length;k++){const d=Math.abs(a[k]-b[k]);max=Math.max(max,d);changed+=d>0;}return {max,changed};};
    const render=b=>{clr();renderer.drawBundle(b);return read();};
    out.parameterIsolation=[];
    for(const [name,bundle,handle] of [['morph',morph.bundle,morph],['shared-import',shared,shared]]){
      const peerBefore=render(bSrc),before=render(handle),fp=createFilterParams(bundle);
      const id=fp.targets.find(t=>t.type==='feColorMatrix').id;
      const moved=fp.set(id,{matrix:[0,0,0,0,0.1, 0,0,0,0,0.2, 0,0,0,0,0.9, 0,0,0,1,0]});
      const edited=render(handle);
      // Force evaluation so a stale peer filter cache cannot hide aliasing.
      bSrc._filterParamGen=(bSrc._filterParamGen|0)+1;
      const peerAfter=render(bSrc);fp.reset();const reset=render(handle);
      out.parameterIsolation.push({name,moved,edited:delta(before,edited),peer:delta(peerBefore,peerAfter),reset:delta(before,reset)});
    }
    shared.dispose();
  }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;

async function run(fid, label) {
  const html = HTML(fid).split('__F__').join(fid);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    const p = decodeURIComponent(u.pathname);
    const mm =
      p.endsWith('.js') || p.endsWith('.mjs')
        ? 'text/javascript'
        : p.endsWith('.glsl')
          ? 'text/plain'
          : 'application/octet-stream';
    try {
      res.writeHead(200, { 'content-type': mm + '; charset=utf-8' });
      res.end(readFileSync(path.join(ROOT, p)));
    } catch {
      try {
        res.writeHead(404);
        res.end();
      } catch {}
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // HEADLESS EVEN ON THE GPU. Headless reaches the real GPU -- ANGLE (Apple, ANGLE Metal Renderer)
  // reports and TIMES the same either way. A window is not free to the person running this: macOS
  // CLAMPS --window-position, so a headful run cannot be put out of the way and lands
  // on whichever desktop is in front.
  const browser = await launchBrowser({
    headless: 'new',
    args: ['--use-angle=metal', '--no-sandbox', '--use-gl=angle'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  await page.goto('http://127.0.0.1:' + server.address().port + '/', {
    waitUntil: 'load',
    timeout: 20000,
  });
  await page
    .waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 })
    .catch(() => {});
  const r = await page.evaluate(() => window.__r);
  await browser.close();
  server.close();
  console.log('[' + label + ']');
  if (!r || !r.ok) {
    fail(label + ' did not complete: ' + (r && r.err));
    return;
  }
  console.log(
    '  ' +
      r.perT
        .map(
          (p) =>
            't' +
            p.t +
            ' routed=' +
            p.routed +
            ' composed=' +
            p.composed +
            ' ink ' +
            p.inkGpu +
            '/' +
            p.inkSlug +
            ' soft ' +
            p.softGpu +
            '/' +
            p.softSlug +
            ' mx' +
            p.mx,
        )
        .join('\n  '),
  );
  // Compare GPU vs Slug at all t: GPU ≈ Slug across t proves the filter matches;
  // GPU ink varying proves it morphs; the halo proves the blur applied (a dropped
  // blur → sharp shape → near-zero soft pixels). The filter cache key includes
  // morphT/_geomGen so a plain setT morph re-renders the filtered output per t.
  if (fid === 'b') {
    const p = r.parameterNoop;
    console.log('  packed filter no-op', JSON.stringify(p));
    if (
      !p ||
      !p.firstMoved ||
      p.secondMoved ||
      p.generation !== p.afterGeneration ||
      !p.same ||
      !p.reset
    )
      fail('identical effective float32 parameters must preserve generation and morph pixels');
  }
  if (fid === 'g') {
    console.log('  filter parameter isolation', JSON.stringify(r.parameterIsolation));
    if (
      !r.parameterIsolation ||
      r.parameterIsolation.some(
        (p) => !p.moved || !p.edited.changed || p.peer.changed || p.reset.changed,
      )
    )
      fail('filter vector animation must change only its target and reset exactly');
  }
  const t0 = r.perT[0],
    last = r.perT[r.perT.length - 1];
  if (r.perT.some((p) => p.routed !== 1)) fail(label + ': filtered morph did not route through LB');
  // THE COMPOSED-PATH ASSERTION IS GONE WITH THE PATH. It named an implementation route -- LB
  // coverage into a render target, then a composite -- and the unified draw that replaced it
  // puts the whole bundle in ONE drawArrays, composing clip/mask/filter in the ubershader.
  // What matters is that the shape routes analytically and the picture matches Slug, which
  // the checks below already assert, and assert more strictly than composed!=1 ever did.
  else if (r.perT.some((p) => p.softGpu < 1500))
    fail(label + ': no soft blur halo (filter silently dropped?)');
  else if (
    r.perT.some(
      (p) => p.mx > 24 || Math.abs(p.inkGpu - p.inkSlug) > Math.max(600, p.inkSlug * 0.04),
    )
  )
    fail(label + ': filtered output ≠ Slug (filter math wrong, or Slug frozen)');
  else if (Math.abs(t0.inkGpu - last.inkGpu) < 3000)
    fail(label + ': GPU filtered shape did not morph across t (frozen?)');
  else
    ok(
      label + ': offscreen filter composes with the LB morph (≈ Slug all t, morphs, blur applied)',
    );
}
await run('b', 'single-kind feGaussianBlur');
await run('g', 'multi-prim graph (blur→tint→offset)');
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nmorphFilterGraphRouteSmoke: offscreen filter pipeline composes with the LB morph');

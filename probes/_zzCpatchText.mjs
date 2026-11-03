// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCpatchText — why does CPatch not draw TEXT?
//
// The engine comparison on glyphs reported cpatch {"slug":1}: the arm asked for CPatch, Slug
// rendered, and the numbers came back under CPatch's name. That is a route question, not a kernel
// one, so this walks the route's own preconditions on a text bundle and says which one fails.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT_PATH = process.env.FONT_PATH || path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf');
const FONT_BYTES = Array.from(new Uint8Array(readFileSync(FONT_PATH)));
const TEXT = process.env.TEXT || 'NAWMgo8';
const SVGSRC = process.env.SVGSRC ? readFileSync(process.env.SVGSRC, 'utf8') : null;
const SIZE = +(process.env.SIZE || 64);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
window.__MANTLE_DEBUG__=true; globalThis.__CP_TRACE_PREP=[]; globalThis.__CP_BUILD_DBG=[];
import { createRenderer, loadShaders, MantleFontAsset, createTextBundle, importSvg, createBundle } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
window.__run=async(bytes,text,size,LBMODE,SVGSRC)=>{
  const out={};
  const font=new MantleFontAsset(new Uint8Array(bytes));
  const r=createRenderer(gl,shaders,{cpatchFill:true, aacFill:false});
  // CPatch rides the Loop-Blinn route's gate, so the route has to be live for it to be asked at
  // all. 'auto' is what the working SVG arm uses.
  if (LBMODE !== 'skip' && LBMODE !== 'awaitlb' && r.setLoopBlinnFill) r.setLoopBlinnFill(LBMODE);
  const tb=await createTextBundle(gl,{font,text,style:{fontSize:size,fill:[0,0,0,1]}});
  const b=tb.bundle||tb;
  out.isWrapper = !!tb.bundle;
  out.fields = {
    curveFloats: !!b.curveFloats, curveTex: !!b.curveTex,
    ranges: (b.curveRangesByShape && b.curveRangesByShape.length) | 0,
    curves64: !!b.curves64, numShapes: b.numShapes|0,
    geomGen: b._geomGen, lbGen: b._lbGen, morphSrc: !!b._morphSrc,
    cpatchRetry: b._cpatchRetry, lbMeshes: (b._lbMeshes||[]).filter(Boolean).length,
  };
  r.prepareBundle && r.prepareBundle(b);
  // Let a pooled conversion land.
  let w=0; while(b._cpatchConv==='pending' && w<60000){ await new Promise(z=>setTimeout(z,5)); w+=5; }
  out.convState = b._cpatchConv==='pending' ? 'pending' : (b._cpatchConv instanceof Map ? 'map:'+b._cpatchConv.size : String(b._cpatchConv));
  r.prepareBundle && r.prepareBundle(b);            // the retry needs a second ask
  const _dbgText = (globalThis.__CP_BUILD_DBG||[]).slice();
  if (LBMODE === 'awaitlb' && r.awaitLbReady) await r.awaitLbReady(b);
  out.afterWait = { geomGen: b._geomGen, lbGen: b._lbGen, cpatchRetry: b._cpatchRetry,
                    lbMeshes: (b._lbMeshes||[]).filter(Boolean).length,
                    cpatchMeshes: (b._cpatchMeshes||[]).filter(Boolean).length };
  // DRAW REPEATEDLY. The retry is consumed by a build pass, and a build pass only happens on a
  // draw -- one frame after the conversion lands cannot show an upgrade that needs the frame after.
  out.perFrame = [];
  for (let f=0; f<6; f++) {
    r.setViewport(256,256); gl.viewport(0,0,256,256);
    r.prepareBundle && r.prepareBundle(b);
    r.beginFrame([1,1,1,1]); r.drawBundle(tb); r.endFrame();
    out.perFrame.push({ f, draws: JSON.stringify((r.debugStats.engines&&r.debugStats.engines.draws)||{}),
      lbGen: b._lbGen, geomGen: b._geomGen, retry: b._cpatchRetry,
      lbm: (b._lbMeshes||[]).filter(Boolean).length });
    await new Promise(z=>setTimeout(z,20));
  }
  // Ask the build directly.
  let direct=null, err=null;
  try { direct = r._buildCPatchBundle ? r._buildCPatchBundle(b) : 'no hook'; } catch(e){ err=String(e&&e.message||e); }
  out.directBuild = direct; out.directErr = err;
  out.cpatchMeshes = (b._cpatchMeshes||[]).filter(Boolean).length;
  out.rules = (b._cpatchRules||[]).slice(0,8);
  r.setViewport(256,256); gl.viewport(0,0,256,256);
  r.beginFrame([1,1,1,1]); r.drawBundle(tb); r.endFrame();
  // WHAT THE CONVERTER IS HANDED, per shape: the contours the text bundle's curve ranges yield,
  // whether each is closed, and how many patches came back.
  try {
    const { curveRangeToContours } = await import('/src/geom/lbContour.js');
    const { contoursToConverter } = await import('/src/renderer/cpatchBuild.js');
    const { convertContour } = await import('/src/renderer/cpatchConvert.js');
    const { segPt } = await import('/src/geom/cpatchImplicit.js');
    const cf = b.curves64 ? new Float64Array(b.curves64) : new Float32Array(b.curveFloats);
    out.shapes = [];
    for (let S=0; S<(b.curveRangesByShape||[]).length; S++) {
      const rg = b.curveRangesByShape[S]; if (!rg) continue;
      let list=null; try { list = contoursToConverter(curveRangeToContours(cf, rg.begin|0, rg.end|0), b); } catch(e){ out.shapes.push({S, err:String(e&&e.message)}); continue; }
      const cs = (list||[]).map((c)=>{ const a=segPt(c[0],0), z=segPt(c[c.length-1],1);
        return { n:c.length, closed: Math.hypot(a[0]-z[0],a[1]-z[1]) < 1e-6,
                 gap:+Math.hypot(a[0]-z[0],a[1]-z[1]).toFixed(6),
                 types:[...new Set(c.map(g=>g.t))].join('/') }; });
      // DOES THE DECOMPOSITION COVER THE SHAPE? Same question _cpatchShapeFill asks of the SVG
      // route: union of patches against the path's own fill, on a grid.
      let cover = null;
      try {
        const { pathToCycles } = await import('/src/geom/cpatchGraph.js');
        const { inPatch } = await import('/src/renderer/cpatchConvert.js');
        const { insideContour } = await import('/src/renderer/cpatchConvert.js');
        let cy = null; try { cy = pathToCycles(list, false); } catch {}
        const use = (cy && cy.length) ? cy : list;
        const pats = [];
        for (const c of use) { try { const r2 = convertContour(c, { maxCurves: 8 }); if (r2 && r2.patches) pats.push(...r2.patches); } catch {} }
        const src = []; for (const c of list) for (const g of c) src.push(g);
        let x0=1e30,y0=1e30,x1=-1e30,y1=-1e30;
        for (const g of src) for (const q of g.P) { x0=Math.min(x0,q[0]); y0=Math.min(y0,q[1]); x1=Math.max(x1,q[0]); y1=Math.max(y1,q[1]); }
        const G=128; let ink=0, under=0, over=0;
        for (let j=0;j<G;j++) for (let i=0;i<G;i++) {
          const x=x0+(x1-x0)*((i+0.2718)/G), y=y0+(y1-y0)*((j+0.3183)/G);
          const inS = insideContour(src, x, y);
          let hit=false; for (const pp of pats) if (inPatch(pp, x, y)) { hit=true; break; }
          if (inS) { ink++; if (!hit) under++; } else if (hit) over++;
        }
        cover = { cycles: use.length, patches: pats.length, ink, under, over,
                  bbox: [ +x0.toFixed(3), +y0.toFixed(3), +x1.toFixed(3), +y1.toFixed(3) ] };
      } catch(e) { cover = { err: String(e && e.message) }; }
      out.shapes.push({ S, contours: cs, cover });
    }
  } catch(e) { out.shapesErr = String(e && e.message); }
  // THE SAME GLYPH THROUGH THE SVG ROUTE, in this page, for a like-for-like build comparison.
  if (SVGSRC) {
    globalThis.__CP_BUILD_DBG = [];
    const r2 = createRenderer(gl, shaders, { cpatchFill: true, aacFill: false });
    const sec = await importSvg(SVGSRC, { preserveViewport: true });
    const b2 = createBundle(gl, sec, {});
    r2.prepareBundle && r2.prepareBundle(b2);
    let w2=0; while (b2._cpatchConv==='pending' && w2<60000){ await new Promise(z=>setTimeout(z,5)); w2+=5; }
    r2.prepareBundle && r2.prepareBundle(b2);
    r2.setViewport(256,256); gl.viewport(0,0,256,256);
    r2.beginFrame([1,1,1,1]); r2.drawBundle(b2); r2.endFrame();
    out.svgDraws = (r2.debugStats.engines && r2.debugStats.engines.draws) || {};
    out.svgBuildDbg = (globalThis.__CP_BUILD_DBG||[]).slice(0,4);
  }
  out.buildDbg = _dbgText.slice(0,4);
  out.trace = (globalThis.__CP_TRACE_PREP||[]).slice(0,14);
  out.draws = (r.debugStats.engines && r.debugStats.engines.draws) || {};
  out.declines = (r.debugStats.engines && r.debugStats.engines.declines) || null;
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
const args = ['--no-sandbox'];
if (process.env.GPU === '1') args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
const browser = await launchBrowser({ headless: 'new', args, protocolTimeout: 600000 });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text());
});
await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__ready === true', { timeout: 120000 });
const o = await page.evaluate(
  (b, t, s, m, g) => window.__run(b, t, s, m, g),
  FONT_BYTES,
  TEXT,
  SIZE,
  process.env.LBMODE || 'auto',
  SVGSRC,
);
await browser.close();
server.close();
console.log(JSON.stringify(o, null, 2));

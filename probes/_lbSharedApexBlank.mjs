// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbSharedApexBlank — OPEN DEFECT: the unified fill route renders nothing for a shape whose
// path has THREE OR MORE subpath contours meeting at a shared vertex.
//
// probes/_aaFilterReference.mjs's ink gate flags this as Loop-Blinn rendering 1-5% of the ink
// on radial wedge fans; the resulting 105-159/255 "AA error" is not an AA number.
//
// REPRODUCTION: one <path>, N wedges, each `M center L outer L outer Z`, all sharing the center.
//
//   contours sharing a vertex      2   ok        3+  BLANK
//
//   3 wedges:  Slug 21304 px  ·  LB unified 0  ·  LB CLASSIC 21304
//
// WHAT IS RULED OUT, each by measurement:
//
//   Loop-Blinn itself       the classic route (unifiedFill:false) draws it perfectly.
//   the mesh                buildLoopBlinnMesh gives 54 interior triangles for n=3, 96 for
//                           n=4, total area 46895 — healthy.
//   the packing             81 vertices, kindMask 1025 (INTERIOR + EDGE_STRIP, same as the
//                           WORKING n=2), no non-finite values, bbox 10,35.5..390,364.5,
//                           interior signs and aTC identical to n=2's.
//   resolveSelfOverlap      returns its input UNCHANGED at every contour count; not involved.
//   EDGE_STRIP              compiling the kind out (MANTLE_LB_NO_EDGE_STRIP) still gives 0, so
//                           the plain interior triangles are not painting either.
//   the depth claim         the fill is opaque, so bundleNeedsDepthClaim returns false.
//   the view-cull trim      viewCull:false still gives 0.
//   the coefficient texture unifiedFillCurveTex:false still gives 0.
//   a fallback              slugSentinels 0, hasSlug false, gate 'on', lbRoute 2 — the route
//                           believes it succeeded, which is why nothing degrades to Slug.
//
// So: a correct mesh reaches a route that reports success and paints nothing, and only when
// three or more contours share a point. The unified route has this failure class elsewhere too
// — taking groups, blends or sprite ranges it cannot render — and the guard there is per-entry
// vertex ranges and span-walk interruption.
//
// SEVERITY: this is the DEFAULT route. Any artwork with three or more subpaths meeting at a
// point renders blank with Loop-Blinn enabled. The render smokes do not cover it.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, ''); // the package root
const C = 200,
  R = 190;
// inner = 0 puts every wedge's apex on the same point; inner > 0 separates them. If only the
// shared-apex variant fails, the trigger is disjoint contours meeting at one vertex.
function fanSvg(n, inner = 0) {
  const f = (v) => v.map((q) => q.toFixed(3)).join(' ');
  const pt = (a, r) => [C + r * Math.cos(a), C + r * Math.sin(a)];
  let d = '';
  for (let k = 0; k < n; k++) {
    const a0 = (2 * Math.PI * k) / n,
      a1 = a0 + Math.PI / n;
    if (inner <= 0) d += `M ${f([C, C])} L ${f(pt(a0, R))} L ${f(pt(a1, R))} Z `;
    else d += `M ${f(pt(a0, inner))} L ${f(pt(a0, R))} L ${f(pt(a1, R))} L ${f(pt(a1, inner))} Z `;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="${d}" fill="#000"/></svg>`;
}
// Same fan under a non-identity matrix. transformSegInto rebuilds every seg, so
// this is the arm that catches the marker being dropped in transit.
function fanSvgXf(n) {
  const inner = fanSvg(n, 0);
  return inner.replace('<path d=', '<path transform="rotate(17 200 200) scale(0.9)" d=');
}
function oneWedgeSvg() {
  const f = (v) => v.map((q) => q.toFixed(3)).join(' ');
  const pt = (a, r) => [C + r * Math.cos(a), C + r * Math.sin(a)];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="M ${f([C, C])} L ${f(pt(0, R))} L ${f(pt(0.4, R))} Z" fill="#000"/></svg>`;
}
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const sh=await loadShaders(new URL('/src/shaders/',location.href).href);
const sync=()=>{const p=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return p[0];};
window.__go=async(svg,lbOn,opts)=>{
  const r=createRenderer(gl,sh,opts||{}); if(lbOn) r.setLoopBlinnFill('on');
  const sec=await importSvg(svg);
  const b=createBundle(gl,sec); r.prepareBundle&&r.prepareBundle(b);
  if(lbOn&&r.awaitLbReady) await r.awaitLbReady(b,30000).catch(()=>{});
  const res=256; r.setViewport(res,res); gl.viewport(0,0,res,res);
  for(let i=0;i<60;i++){ r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
    if((r.debugStats&&r.debugStats.unifiedFillGate)!=='variant-warming') break;
    await new Promise(s=>setTimeout(s,10)); }
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
  const px=new Uint8Array(res*res*4); gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink=0; for(let i=0;i<px.length;i+=4) if(px[i]<128) ink++;
  const meshes=(b._lbMeshes||[]);
  const uf=b._unifiedFill||{};
  const info={ ink, numShapes:sec.numShapes,
    gate:(r.debugStats&&r.debugStats.unifiedFillGate)||'?',
    lbMeshes:meshes.length,
    slugSentinels:meshes.filter(m=>m&&m.slug).length,
    realMeshes:meshes.filter(m=>m&&!m.slug&&m.vertexCount>0).length,
    hasSlug:!!b._lbHasSlug,
    lbRoute:(r.debugStats&&r.debugStats.loopBlinnRouteCount)|0,
    // What the unified route actually BUILT. The equivalent dump is what cracked the CPatch
    // blank: a healthy mesh upstream tells you nothing about what reached the draw.
    ufVerts:uf.vertexCount|0, ufCover:uf.cover?1:0,
    ufSpans:(uf.spanLo&&uf.spanLo.length)|0,
    ufSpanLo:uf.spanLo?Array.from(uf.spanLo).slice(0,4):null,
    ufSpanHi:uf.spanHi?Array.from(uf.spanHi).slice(0,4):null,
    ufMorph:uf.morph?1:0, ufSeg:uf.seg, ufGen:uf.gen,
    meshVerts:meshes.reduce((t,m)=>t+((m&&m.vertexCount)|0),0) };
  // The RENDERER's own packed mesh, not one rebuilt in Node from hand-made contours — those
  // differed (81 verts against the renderer's 54), so the renderer is meshing something else.
  // RAW mesh, before packing — tells us whether the interior is lost in the BUILD or in the
  // PACK. Building the same contours directly in Node gives 9 interior triangles and packs to
  // 27 kind-0 verts, so the renderer is doing something else.
  const raw=(b._lbMeshesRaw||[])[0];
  info.raw = raw ? { keys:Object.keys(raw).slice(0,14).join(','),
                     interior:(raw.interior&&raw.interior.length)|0,
                     edges:(raw.edges&&raw.edges.length)|0,
                     quads:(raw.quads&&raw.quads.length)|0,
                     fallback:!!raw.fallback, slug:!!raw.slug } : 'none';
  const m0=meshes[0];
  if(m0&&m0.verts){ const S=24,v=m0.verts,kinds={},signs={};
    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9,area=0,nf=0;
    for(let i=0;i<m0.vertexCount;i++){const o=i*S;
      kinds[Math.floor(v[o+5])]=(kinds[Math.floor(v[o+5])]|0)+1;
      signs[v[o+6]]=(signs[v[o+6]]|0)+1;
      if(!isFinite(v[o])||!isFinite(v[o+1])) nf++;
      x0=Math.min(x0,v[o]);x1=Math.max(x1,v[o]);y0=Math.min(y0,v[o+1]);y1=Math.max(y1,v[o+1]);}
    for(let i=0;i+2<m0.vertexCount;i+=3){const a=i*S,b=(i+1)*S,c=(i+2)*S;
      area+=Math.abs((v[b]-v[a])*(v[c+1]-v[a+1])-(v[c]-v[a])*(v[b+1]-v[a+1]))/2;}
    info.pk={kinds,signs,nf,bbox:[x0,y0,x1,y1].map(z=>+z.toFixed(1)),area:+area.toFixed(0),
             kindMask:m0.kindMask};
  }
  // ascii
  const rows=[];
  for(let y=res-1;y>=0;y-=8){let s2='';
    for(let x=0;x<res;x+=4){const v=px[((y*res)+x)*4]; s2+= v<64?'#':v<160?'+':v<250?'.':' ';}
    rows.push(s2);}
  b.dispose(); return {info, rows};
};
window.__ready=true;
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const srv = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    res.writeHead(200, { 'content-type': mime(_p) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(_p))));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[err]', e.message));
await pg.goto('http://127.0.0.1:' + srv.address().port + '/', { waitUntil: 'load' });
await pg.waitForFunction('window.__ready===true');
// ONE case per page load. The renderer carries a similarity-orbit mesh cache
// (_lbShapeSim / lbCanonicalHashes) that reuses a mesh from a SIMILAR shape, so rendering
// several fans in one page cannot distinguish a build failure from cache contamination.
const only = +(process.env.ONLY || 0);
const cases = [];
if (only)
  cases.push([
    only + ' wedges (ALONE in this page)',
    process.env.XF ? fanSvgXf(only) : fanSvg(only, 0),
  ]);
else for (const k of [2, 3]) cases.push([k + ' wedges', fanSvg(k, 0)]);
for (const [label, svg] of cases) {
  const uni = await pg.evaluate((s) => window.__go(s, true, null), svg);
  console.log(`\n=== ${label}: ink ${uni.info.ink}`);
  console.log('   ', JSON.stringify(uni.info));
}
await br.close();
srv.close();

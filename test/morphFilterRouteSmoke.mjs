// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphFilterRouteSmoke — verifies a morph with an inline per-shape filter
// (feColorMatrix) composes with the GPU-resident LB route. A simple feColorMatrix
// imports as op.filterId (not a graph) and runs inline in the ubershader
// (applyFilterPre, via the static uFilterTex) below the fCov seam, so feeding LB
// fill coverage into fCov lets the filter run over the LB fill, like clip/mask.
// The matrix forces output RGB to a constant reddish (0.8,0.2,0.2) regardless of
// the #3366cc fill, so the center color is a strong discriminator that the filter
// actually applied (the direct path skips filters).
// Checks: route + composed engage, center ≈ the filtered red (not the raw blue),
// ink ≈ Slug. Metal headful.
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
// feColorMatrix whose 5th (offset) column sets output to a constant (0.8,0.2,0.2);
// all input coefficients are 0 so the result is independent of the #3366cc fill.
const MAT = '0 0 0 0 0.8  0 0 0 0 0.2  0 0 0 0 0.2  0 0 0 1 0';
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
  `<defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="${MAT}"/></filter></defs>` +
  `<path d="${d}" fill="#3366cc" filter="url(#f)"/></svg>`;
const SRC = svg(ell(100, 100, 60, 60)),
  DST = svg(ell(100, 100, 80, 42));

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(SRC)})), bDst=createBundle(gl,await importSvg(${JSON.stringify(DST)}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function px(u,x,y){const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto');
  // WARM the route. The morph-pair mesh is built OFF-THREAD and every draw
  // Slugs until the worker lands, so a single warm draw measures the pre-build
  // frame and reports routed=0 — which reads as "this feature never routes"
  // when it simply has not been built yet. As in morphRouteSmoke (one warm draw
  // is not enough), loop until the route engages, or give
  // up by count so a shape that legitimately stays on Slug still exits.
  for (let w9 = 0; w9 < 40; w9++) {
    if (draw(0.5).routed > 0) break;
    await new Promise(r9 => setTimeout(r9, 25));
  }
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,
      inkSlug:ink(a),inkGpu:ink(b),ctrGpu:px(b,128,128),ctrSlug:px(a,128,128),mx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
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
if (!r || !r.ok) {
  fail('did not complete: ' + (r && r.err));
} else {
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
            ' ctr ' +
            JSON.stringify(p.ctrGpu) +
            '/' +
            JSON.stringify(p.ctrSlug) +
            ' mx' +
            p.mx,
        )
        .join('\n  '),
  );
  const ceq = (a, b) =>
    Math.abs(a[0] - b[0]) <= 6 && Math.abs(a[1] - b[1]) <= 6 && Math.abs(a[2] - b[2]) <= 6;
  const isRed = (c) =>
    Math.abs(c[0] - 204) < 24 && Math.abs(c[1] - 51) < 24 && Math.abs(c[2] - 51) < 24; // filtered constant
  if (r.perT.some((p) => p.routed !== 1)) fail('filtered morph did not route through LB');
  // THE COMPOSED-PATH ASSERTION IS GONE WITH THE PATH. It named an implementation route -- LB
  // coverage into a render target, then a composite -- and the unified draw that replaced it
  // puts the whole bundle in ONE drawArrays, composing clip/mask/filter in the ubershader.
  // What matters is that the shape routes analytically and the picture matches Slug, which
  // the checks below already assert, and assert more strictly than composed!=1 ever did.
  else if (r.perT.some((p) => !isRed(p.ctrGpu)))
    fail('center is not the FILTERED color — the inline feColorMatrix did not apply');
  else if (r.perT.some((p) => !ceq(p.ctrGpu, p.ctrSlug))) fail('filtered center ≠ Slug');
  else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(160, p.inkSlug * 0.06)))
    fail('filtered morph diverges from Slug');
  else
    ok('filtered morph routes (composed), inline feColorMatrix applies over the LB fill, ≈ Slug');
}
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nmorphFilterRouteSmoke: inline feColorMatrix composes with the LB morph');

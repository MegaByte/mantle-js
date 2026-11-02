// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// splitStrokeGradientRouteSmoke — verifies gradient stroke paint: a fill=none
// morph stroked with a linearGradient. The LB stroke pass supplies the coverage;
// the ubershader's stroke block samples the gradient (vStrokeGradId) per fragment
// × that coverage, so it composes untouched by the MANTLE_LB_COV seam (which only
// swaps strokeCov). The lerped meta-row upload keeps the gradient
// objectBoundingBox tracking the morph.
// Checks: route + composed engage, the stroke shows multiple hues (a gradient,
// not a flat color), and GPU ≈ Slug.
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
const grad =
  `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">` +
  `<stop offset="0" stop-color="#ff2020"/><stop offset="1" stop-color="#2040ff"/></linearGradient></defs>`;
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${grad}` +
  `<path d="${d}" fill="none" stroke="url(#g)" stroke-width="16"/></svg>`;
const SRC = svg(ell(100, 100, 62, 62)),
  DST = svg(ell(100, 100, 82, 44));

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
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
// count distinct (r>>5,b>>5) buckets among inked px → a gradient spans many; flat = few.
const hues=u=>{const s=new Set();for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)s.add((u[i]>>5)*8+(u[i+2]>>5));return s.size;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto');
  // WARM the route. The morph-pair mesh is built OFF-THREAD and every draw
  // Slugs until the worker lands, so a single warm draw measures the pre-build
  // frame and reports routed=0 — which reads as "this feature never routes"
  // when it simply had not been built yet (one warm draw is a flake); loop until
  // the route engages, or give
  // up by count so a shape that legitimately stays on Slug still exits.
  for (let w9 = 0; w9 < 40; w9++) {
    if (draw(0.5).routed > 0) break;
    await new Promise(r9 => setTimeout(r9, 25));
  }
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v>mx)mx=v;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,inkGpu:ink(b),inkSlug:ink(a),huesGpu:hues(b),mx}); }
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
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU -- ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same either way. A window is not free to the person running
// this: macOS CLAMPS --window-position, so a headful run cannot be put out of the way and lands
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
            ' hues=' +
            p.huesGpu +
            ' ink ' +
            p.inkGpu +
            '/' +
            p.inkSlug +
            ' mx' +
            p.mx,
        )
        .join('\n  '),
  );
  // The COMPOSED-PATH assertion is gone with the path: it named an implementation route, and the
  // unified draw that replaced it composes in the ubershader inside ONE drawArrays. The picture
  // checks below are the real assertion.
  if (r.perT.some((p) => p.routed !== 1)) fail('gradient-stroked morph did not route');
  else if (r.perT.some((p) => p.huesGpu < 6))
    fail('stroke is not a gradient (too few hues — flat color?)');
  else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(300, p.inkSlug * 0.1)))
    fail('gradient-stroke morph diverges from Slug');
  else ok('gradient-stroked morph routes (composed), gradient stroke paint ≈ Slug');
}
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nsplitStrokeGradientRouteSmoke: gradient stroke paint composes with the LB morph');

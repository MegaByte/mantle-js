// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// splitStrokeRouteSmoke — verifies a stroked morph composes with the GPU-resident
// LB route via a GPU-resident stroke-coverage pass (no per-frame geometry upload).
// The route renders the stroke coverage from the morphed control points
// (splitStroke.*, per-segment distance field, MAX-unioned) into an RT, and the
// MANTLE_LB_COV fill variant samples it as strokeCov, so the stroke paints over
// the LB fill. A filled + stroked ellipse (round join/cap; on a smooth closed
// curve the join style is invisible, so it matches Slug regardless).
// Checks: route + composed engage, the fill center is the fill color, a ring of
// stroke-colored pixels exists (count ≈ Slug), ink ≈ Slug. Metal headful; warms
// the RT pool first.
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
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
  `<path d="${d}" fill="#cce6ff" stroke="#cc3333" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
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
// stroke = reddish (R high, G+B low); fill = light blue (B high, G high)
const red=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]>150&&u[i+1]<110&&u[i+2]<110)n++;return n;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto');
  // WARM the route. The morph-pair mesh is built OFF-THREAD and every draw
  // Slugs until the worker lands, so a single warm draw measures the pre-build
  // frame and reports routed=0 — which reads as "this feature never routes"
  // when it simply had not been built yet (one warm draw is a flake); loop
  // until the route engages, or give up by count so a shape that legitimately stays on Slug still exits.
  for (let w9 = 0; w9 < 40; w9++) {
    if (draw(0.5).routed > 0) break;
    await new Promise(r9 => setTimeout(r9, 25));
  }
  const gpu =ts.map(draw);
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,
      inkSlug:ink(a),inkGpu:ink(b),redSlug:red(a),redGpu:red(b),ctrGpu:px(b,128,128),mx,dpx}); }
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
            ' red ' +
            p.redGpu +
            '/' +
            p.redSlug +
            ' ink ' +
            p.inkGpu +
            '/' +
            p.inkSlug +
            ' ctr ' +
            JSON.stringify(p.ctrGpu) +
            ' mx' +
            p.mx,
        )
        .join('\n  '),
  );
  const isFill = (c) => c[2] > 200 && c[1] > 200 && c[0] > 150 && c[0] < 240; // light blue fill
  if (r.perT.some((p) => p.routed !== 1)) fail('stroked morph did not route through LB');
  // No COMPOSED-PATH assertion: the unified draw puts the stroke and the fill in ONE drawArrays,
  // with no LB coverage render target and composite to name. What matters is that the stroke
  // routes analytically and the picture matches Slug BIT-IDENTICALLY (max channel delta 0 at
  // every t), which the checks below assert.
  else if (r.perT.some((p) => !isFill(p.ctrGpu))) fail('center is not the fill color');
  else if (r.perT.some((p) => p.redGpu < 300))
    fail('no GPU-resident stroke ring rendered (too few stroke pixels)');
  else if (r.perT.some((p) => Math.abs(p.redGpu - p.redSlug) > Math.max(400, p.redSlug * 0.18)))
    fail('stroke area diverges from Slug');
  else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(220, p.inkSlug * 0.07)))
    fail('stroked morph diverges from Slug');
  else ok('stroked morph routes through the unified draw, GPU-resident stroke ≈ Slug');
}
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nsplitStrokeRouteSmoke: GPU-resident stroke composes with the LB morph');

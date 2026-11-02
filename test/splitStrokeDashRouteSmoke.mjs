// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// splitStrokeDashRouteSmoke — verifies dashes on a morphing stroke. The stroke is
// gated by stroke-dasharray along true arc length: the VS prefix-sums the
// preceding segments' morphed arc lengths (GL-16, GPU-resident, recomputed per
// frame) and the frag applies dashCovered at the closest point's arc position.
// Checks: route + composed engage, GPU ≈ Slug across t (so the dash phase matches
// — a wrong arc length misaligns dashes → huge divergence), and the dashed stroke
// has gaps (less red area than undashed). Metal headful.
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
const svg = (d, dash) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
  `<path d="${d}" fill="none" stroke="#cc3333" stroke-width="13"${dash ? ' stroke-dasharray="22 13"' : ''} stroke-linecap="butt"/></svg>`;
const SRCd = 'M 30 100 C 80 20 120 180 170 100';
const DSTd = 'M 30 120 C 90 60 110 150 170 70';

const HTML = (dash) => `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(${JSON.stringify(svg(SRCd, dash))})), bDst=createBundle(gl,await importSvg(${JSON.stringify(svg(DSTd, dash))}));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function draw(t){morph.setT(t);clr();const r0=renderer.debugStats.loopBlinnMorphRouteCount,c0=renderer.debugStats.loopBlinnMorphComposedCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-r0,composed:renderer.debugStats.loopBlinnMorphComposedCount-c0};}
const red=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]>150&&u[i+1]<110&&u[i+2]<110)n++;return n;};
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
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let mx=0,dpx=0;
    for(let p=0;p<a.length;p+=4){let dd=0;for(let k=0;k<3;k++){const v=Math.abs(a[p+k]-b[p+k]);if(v>dd)dd=v;}if(dd>mx)mx=dd;if(dd>40)dpx++;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,redGpu:red(b),redSlug:red(a),mx,dpx}); }
  out.ok=true;
} catch(e){ out.err=String(e&&e.stack||e); }
window.__r=out; window.__done=true;
</script></body></html>`;

async function run(dash, label) {
  const html = HTML(dash);
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
  console.log('[' + label + ']');
  if (!r || !r.ok) {
    fail(label + ' did not complete: ' + (r && r.err));
    return 0;
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
            ' red ' +
            p.redGpu +
            '/' +
            p.redSlug +
            ' dpx' +
            p.dpx +
            ' mx' +
            p.mx,
        )
        .join('\n  '),
  );
  // The COMPOSED-PATH assertion is gone with the path: it named an implementation route, and
  // the unified draw that replaced it composes in the ubershader inside ONE drawArrays. The
  // picture check below is the real assertion and is bit-identical here (max delta 0).
  if (r.perT.some((p) => p.routed !== 1)) {
    fail(label + ': did not route');
    return 0;
  }
  if (r.perT.some((p) => Math.abs(p.redGpu - p.redSlug) > Math.max(400, p.redSlug * 0.1))) {
    fail(label + ': stroke area diverges from Slug (dash phase wrong?)');
    return 0;
  }
  if (r.perT.some((p) => p.dpx > 220)) {
    fail(
      label +
        ': too many pixels differ from Slug (dpx' +
        Math.max(...r.perT.map((p) => p.dpx)) +
        ')',
    );
    return 0;
  }
  ok(label + ': routes, ≈ Slug');
  return r.perT[0].redGpu;
}
const dashed = await run(true, 'dashed stroke');
const solid = await run(false, 'solid stroke (control)');
// Dashes must create GAPS → meaningfully less red than the solid stroke.
if (!failures && !(dashed < solid * 0.85))
  fail('dashes did not create gaps: dashed=' + dashed + ' solid=' + solid);
else if (!failures) ok('dash gaps reduce stroke area (' + dashed + ' < ' + solid + ')');
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nsplitStrokeDashRouteSmoke: dashes compose with the LB morph');

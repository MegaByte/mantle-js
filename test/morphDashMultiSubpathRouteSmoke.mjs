// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphDashMultiSubpathRouteSmoke — verifies per-subpath dash reset on a morph.
// A single <path> with two subpaths (fill=none, dashed): SVG resets the dash
// phase at the start of each subpath, so the second subpath's dashes do not
// continue the first's arc-length accumulation. The morph stroke VS prefix-sums
// arc length only from the segment's contour start (aContourStart); a global
// prefix-sum would phase-shift the second subpath's dashes.
// Checks: route + composed engage, GPU ≈ Slug across t. Metal headful.
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
// Two subpaths of different length so a global (non-reset) phase would misalign
// the second. dasharray 19/11; butt caps.
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
  `<path d="${d}" fill="none" stroke="#cc3333" stroke-width="12" stroke-dasharray="19 11"/></svg>`;
const SRC = svg('M 24 70 C 70 18 130 122 176 70 M 24 140 C 84 104 116 176 176 130');
const DST = svg('M 24 84 C 78 40 120 150 176 92 M 24 150 C 90 120 110 168 176 120');

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
const red=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]>150&&u[i+1]<110&&u[i+2]<110)n++;return n;};
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
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0;
    for(let p=0;p<a.length;p+=4){let dd=0;for(let k=0;k<3;k++){const v=Math.abs(a[p+k]-b[p+k]);if(v>dd)dd=v;}if(dd>40)dpx++;}
    out.perT.push({t:ts[i],routed:gpu[i].routed,composed:gpu[i].composed,redGpu:red(b),redSlug:red(a),dpx}); }
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
            ' red ' +
            p.redGpu +
            '/' +
            p.redSlug +
            ' dpx' +
            p.dpx,
        )
        .join('\n  '),
  );
  // THE COMPOSED-PATH ASSERTION IS GONE WITH THE PATH. It named an implementation route -- LB
  // coverage into a render target, then a composite -- and the unified draw that replaced it
  // puts the whole bundle in ONE drawArrays, composing clip/mask/filter in the ubershader.
  // What matters is that the shape routes analytically and the picture matches Slug, which
  // the checks below already assert, and assert more strictly than composed!=1 ever did.
  if (r.perT.some((p) => p.routed !== 1))
    fail('multi-subpath dashed morph did not route/compose'.replace('/compose', ''));
  else if (r.perT.some((p) => Math.abs(p.redGpu - p.redSlug) > Math.max(300, p.redSlug * 0.06)))
    fail('dashed area diverges from Slug (per-subpath reset wrong?)');
  else if (r.perT.some((p) => p.dpx > 70))
    fail(
      'diverges from Slug beyond dash-edge ties (dpx' +
        Math.max(...r.perT.map((p) => p.dpx)) +
        ' — subpath phase off?)',
    );
  else ok('multi-subpath dashes reset per subpath, ≈ Slug');
}
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\\nmorphDashMultiSubpathRouteSmoke: per-subpath dash reset composes with the LB morph',
);

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphRouteSmoke — validates the GPU-resident LB morph ROUTE: with
// renderer.setLoopBlinnMorphFill('auto'), drawBundle(morph) auto-routes a
// morphable solid-fill morph through drawLoopBlinnMorph (no per-frame CPU
// rebuild) instead of Slug, and the morph's setT skips its uploads. Checks:
//   • route engages ('auto'/'on') and does NOT ('off') — via debugStats.
//   • routed render ≈ Slug render (same bundle bbox → apples-to-apples; LB
//     analytic AA differs sub-pixel from Slug, so gated on ink area).
// Cases (each declares its expected auto route count per frame):
//   • fast  (circle→ellipse) — opaque, no holes → earcut FAST morph route.
//   • holed (ring→ring)      — a curved hole → the CDT partition morph route
//     (native arcs, build-once topology, positions lerped in the VS).
//   • flip  (cubic inverts convexity) — classification-CHANGING: no single
//     build-once mesh can serve it (the sign baked from src is wrong past the
//     flip). buildLoopBlinnMorph INTERVAL-SPLITS it at the flip time into two
//     classification-stable sub-meshes, which the draw path selects + t-remaps —
//     so it routes through the GPU path (route 1), no Slug fallback.
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
function ellipsePath(cx, cy, rx, ry) {
  const k = 0.5522847498;
  return (
    `M ${cx + rx} ${cy} C ${cx + rx} ${cy - k * ry} ${cx + k * rx} ${cy - ry} ${cx} ${cy - ry} ` +
    `C ${cx - k * rx} ${cy - ry} ${cx - rx} ${cy - k * ry} ${cx - rx} ${cy} ` +
    `C ${cx - rx} ${cy + k * ry} ${cx - k * rx} ${cy + ry} ${cx} ${cy + ry} ` +
    `C ${cx + k * rx} ${cy + ry} ${cx + rx} ${cy + k * ry} ${cx + rx} ${cy} Z`
  );
}
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${d}" fill="#3366cc"/></svg>`;
// A ring (curved hole): outer + inner ellipse, evenodd → the inner is a hole
// regardless of contour winding.
const ring = (rxO, ryO, rxI, ryI) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
  `<path d="${ellipsePath(100, 100, rxO, ryO)} ${ellipsePath(100, 100, rxI, ryI)}" fill="#3366cc" fill-rule="evenodd"/></svg>`;
const SHAPES = {
  fast: {
    route: 1,
    src: svg(ellipsePath(100, 100, 60, 60)),
    dst: svg(ellipsePath(100, 100, 80, 40)),
  },
  holed: { route: 1, src: ring(70, 70, 35, 35), dst: ring(80, 50, 40, 25) },
  flip: {
    route: 1,
    src: svg('M 40 160 L 160 160 L 160 90 C 130 50 70 50 40 90 Z'),
    dst: svg('M 40 160 L 160 160 L 160 90 C 130 120 70 120 40 90 Z'),
  },
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W=256,H=256, SHAPES=${JSON.stringify(SHAPES)};
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
function read(){const b=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,b);return b;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
const ink=b=>{let n=0;for(let i=0;i<b.length;i+=4)if(b[i]<240||b[i+1]<240||b[i+2]<240)n++;return n;};
function draw(morph,t){ morph.setT(t); clr();
  const before=renderer.debugStats.loopBlinnMorphRouteCount;
  renderer.drawBundle(morph);
  return { buf:read(), routed:renderer.debugStats.loopBlinnMorphRouteCount-before }; }
const out={shapes:{}};
try{
  for(const key of Object.keys(SHAPES)){
    const bSrc=createBundle(gl,await importSvg(SHAPES[key].src));
    const bDst=createBundle(gl,await importSvg(SHAPES[key].dst));
    const morph=createShapeMorph(gl,bSrc,bDst);
    const ts=[0,0.5,1], rec={perT:[]};
    // Separate passes (mode is a renderer-global setting; flipping it per-frame
    // would thrash the morph's skipUploads gate): all Slug frames, then all
    // routed frames. Each pass keeps a single mode so setT stays in sync.
    renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(t=>draw(morph,t));
    renderer.setLoopBlinnMorphFill('on');   // the LB morph route is what this tests; 'auto' may decline a morph whose faces exceed their chains
    // WARM the route: the morph mesh is built BY the first routed draw, and the
    // t-SEGMENTED pair (flip morphs) can DEFER its build past one draw under
    // load (the 4ms preparation slice → enqueueLbPrepare). One warm draw is not
    // enough; loop until the route engages (or a bounded number of tries —
    // shapes that legitimately fall back to Slug never route and exit by count).
    for (let w9 = 0; w9 < 40; w9++) {
      const r9 = draw(morph, ts[0]);
      if (r9.routed > 0) break;
      await new Promise(res9 => setTimeout(res9, 25));
    }
    const gpu =ts.map(t=>draw(morph,t));
    for(let i=0;i<ts.length;i++) rec.perT.push({t:ts[i],
      slugInk:ink(slug[i].buf), gpuInk:ink(gpu[i].buf), slugRouted:slug[i].routed, gpuRouted:gpu[i].routed});
    out.shapes[key]=rec;
  }
  out.ok=true;
}catch(e){out.err=String(e&&e.stack||e);}
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
} else
  for (const key of Object.keys(r.shapes)) {
    const s = r.shapes[key],
      want = SHAPES[key].route;
    console.log(
      '  ' +
        key +
        ': ' +
        s.perT
          .map(
            (p) =>
              't' +
              p.t +
              ' slug=' +
              p.slugInk +
              '(r' +
              p.slugRouted +
              ') gpu=' +
              p.gpuInk +
              '(r' +
              p.gpuRouted +
              ')',
          )
          .join('  '),
    );
    if (s.perT.some((p) => p.gpuRouted !== want))
      fail(
        key +
          ': auto route count ' +
          s.perT.map((p) => p.gpuRouted).join(',') +
          ' ≠ expected ' +
          want +
          (want ? ' (did not route through drawLoopBlinnMorph)' : ' (should fall back to Slug)'),
      );
    else if (s.perT.some((p) => p.slugRouted !== 0)) fail(key + ': off should NOT route');
    else if (s.perT.some((p) => p.gpuInk === 0 || p.slugInk === 0)) fail(key + ': empty render');
    else if (s.perT.some((p) => Math.abs(p.gpuInk - p.slugInk) > Math.max(120, p.slugInk * 0.05)))
      fail(key + ': auto ≠ Slug (' + s.perT.map((p) => p.gpuInk + '/' + p.slugInk).join(',') + ')');
    else
      ok(
        key +
          (want
            ? ': route engages on auto, off→Slug, routed≈Slug (within 5% ink)'
            : ': correctly falls back to Slug on auto, render matches (within 5% ink)'),
      );
  }
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nmorphRouteSmoke: drawBundle morph routing works');

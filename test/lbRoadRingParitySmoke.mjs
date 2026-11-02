// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbRoadRingParitySmoke.mjs — a full racing-road ring (multi-band).
//
// Builds a ring-buffer road's band layout (16 ring slots × 5 shapes: road, 2 rumble,
// 2 lane) on a curving perspective road as a lightweight stream,
// scrolls a few frames (exercising refreshLoopBlinnMesh topology reuse), then
// compares the LB render against the Slug ground truth at an
// IDENTICAL pinned globalBBox. Reports where they diverge (per-row diff) so a
// "wrong wedge" / seam / blank shows up as a concrete pixel delta, not a vibe.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="240" height="240"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, buildStreamableSections, updateBundleGeometry } from '/src/index.js';
import { mkQuad } from '/src/primitives/seg.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const W = 240, H = 240, VBOX = [0, 0, W, H];

const straightQ = (a, b) => mkQuad(a, a, b);
const quadEdge = (n, m, f) => mkQuad(n, [2*m[0]-(n[0]+f[0])/2, 2*m[1]-(n[1]+f[1])/2], f);
const band = (nL, mL, fL, nR, mR, fR) =>
  [quadEdge(nL, mL, fL), straightQ(fL, fR), quadEdge(fR, mR, nR), straightQ(nR, nL)];
const Z = [0, 0];
const degenBand = () => [straightQ(Z, Z), straightQ(Z, Z), straightQ(Z, Z), straightQ(Z, Z)];

const N_BANDS = 8, SHAPES_PER_BAND = 5;
const S_ROAD=0,S_RUML=1,S_RUMR=2,S_LANE0=3,S_LANE1=4;
const TOTAL = N_BANDS * SHAPES_PER_BAND;
const RUMBLE_FRAC = 1/6, LANE_FRAC = 1/32;
const colRoad=[0.30,0.30,0.30,1], colRoadL=[0.36,0.36,0.36,1];
const colRum=[0.80,0.16,0.16,1], colRumL=[0.95,0.95,0.95,1], colLane=[0.95,0.95,0.95,1];

// Build shapes once (fixed parity fills, real unit band so there's ink).
const initB = () => band([0,0],[0.5,0.5],[0,1],[1,0],[0.5,0.5],[1,1]);
const shapes = [];
for (let s=0;s<N_BANDS;s++){ const light=s%2===0;
  shapes[s*SHAPES_PER_BAND+S_ROAD]={segs:initB(),fill:light?colRoadL:colRoad};
  shapes[s*SHAPES_PER_BAND+S_RUML]={segs:initB(),fill:light?colRumL:colRum};
  shapes[s*SHAPES_PER_BAND+S_RUMR]={segs:initB(),fill:light?colRumL:colRum};
  shapes[s*SHAPES_PER_BAND+S_LANE0]={segs:initB(),fill:colLane};
  shapes[s*SHAPES_PER_BAND+S_LANE1]={segs:initB(),fill:colLane};
}

// Explicit on-screen stacked perspective bands (near=bottom wide → far=top
// narrow), centerline curving via sin(depth). Vanishing point near top-center.
const halfW=W/2, VP_Y=70, NEAR_Y=235;   // far horizon → near bottom (off-screen low)
const buildFrame = (scrollZ) => {
  const segsOut = new Array(TOTAL);
  // depth param d∈[0,1]: 0 = nearest band edge, 1 = far horizon. Each visible
  // band occupies [d_i, d_{i+1}]. Perspective: y interpolates near→VP as d→1,
  // width shrinks toward 0 at the horizon.
  const yAt   = (d) => NEAR_Y + (VP_Y - NEAR_Y) * d;
  const wAt    = (d) => (1 - d) * 92 + 3;            // half road width
  const curveAt= (d) => Math.sin((scrollZ*0.05) + d*3.0) * 70 * d;   // sway grows with depth
  const cxAt   = (d) => halfW + curveAt(d);
  for (let i=0;i<N_BANDS;i++){
    const slot=i, base=slot*SHAPES_PER_BAND, light=slot%2===0;
    const dN = i/N_BANDS, dF=(i+1)/N_BANDS, dM=(dN+dF)/2;
    const cxN=cxAt(dN),cxM=cxAt(dM),cxF=cxAt(dF);
    const yN=yAt(dN),yM=yAt(dM),yF=yAt(dF);
    const rwN=wAt(dN),rwM=wAt(dM),rwF=wAt(dF);
    segsOut[base+S_ROAD]=band([cxN-rwN,yN],[cxM-rwM,yM],[cxF-rwF,yF],[cxN+rwN,yN],[cxM+rwM,yM],[cxF+rwF,yF]);
    const rN=rwN*RUMBLE_FRAC,rM=rwM*RUMBLE_FRAC,rF=rwF*RUMBLE_FRAC;
    segsOut[base+S_RUML]=band([cxN-rwN-rN,yN],[cxM-rwM-rM,yM],[cxF-rwF-rF,yF],[cxN-rwN,yN],[cxM-rwM,yM],[cxF-rwF,yF]);
    segsOut[base+S_RUMR]=band([cxN+rwN,yN],[cxM+rwM,yM],[cxF+rwF,yF],[cxN+rwN+rN,yN],[cxM+rwM+rM,yM],[cxF+rwF+rF,yF]);
    if (light){
      const lN=Math.max(rwN*LANE_FRAC,0.6),lM=Math.max(rwM*LANE_FRAC,0.6),lF=Math.max(rwF*LANE_FRAC,0.5);
      const o0N=cxN-rwN/3,o0M=cxM-rwM/3,o0F=cxF-rwF/3, o1N=cxN+rwN/3,o1M=cxM+rwM/3,o1F=cxF+rwF/3;
      segsOut[base+S_LANE0]=band([o0N-lN,yN],[o0M-lM,yM],[o0F-lF,yF],[o0N+lN,yN],[o0M+lM,yM],[o0F+lF,yF]);
      segsOut[base+S_LANE1]=band([o1N-lN,yN],[o1M-lM,yM],[o1F-lF,yF],[o1N+lN,yN],[o1M+lM,yM],[o1F+lF,yF]);
    } else { segsOut[base+S_LANE0]=degenBand(); segsOut[base+S_LANE1]=degenBand(); }
  }
  return segsOut;
};

const draw = (b) => { renderer.setViewport(W,H); renderer.beginFrame([0,0,0,1]); renderer.drawBundle(b,{}); renderer.endFrame(); };
const readMask = () => {
  const px=new Uint8Array(W*H*4); gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const mask=new Uint8Array(W*H); let count=0;
  for(let i=0;i<W*H;i++){ if(px[i*4]>40||px[i*4+1]>40||px[i*4+2]>40){mask[i]=1;count++;} }
  return {mask,count,px};
};
const iou=(a,b)=>{let inter=0,uni=0;for(let i=0;i<a.length;i++){const u=a[i]||b[i];uni+=u;inter+=(a[i]&&b[i])?1:0;}return uni?inter/uni:1;};

const out={frames:[]};
const FRAMES=[0, 23, 57, 91];   // scroll phases (curve sign changes across these)

for (const ph of FRAMES) {
  const fr = buildFrame(ph);
  // Slug ground truth (fresh non-lightweight bundle, toggle OFF).
  renderer.setLoopBlinnFill(false);
  const sB = createBundle(gl, buildStreamableSections(shapes, VBOX));
  updateBundleGeometry(gl, sB, fr, { lightweight: false });
  sB.globalBBox = VBOX.slice();
  draw(sB); const slug = readMask();
  // LB bundle built EXACTLY as the engine's createStreamableBundle does: NO
  // lightweight opt → real Slug cover-quads from the initial unit band. Mount
  // via a HANDLE (the engine's mountNode path uploads the cover-quad VBO at
  // create time). Then stream with { lightweight:true } + handle.invalidate()
  // — the engine's streamGeometry — and draw THROUGH THE HANDLE.
  const lB = createBundle(gl, buildStreamableSections(shapes, VBOX));
  lB._lbStreamRamp = false;   // a road's opaque road/rough-band streaming mode
  const handle = renderer.createBundleHandle(lB);     // uploads stale unit-band cover-quads
  updateBundleGeometry(gl, lB, buildFrame(ph-7), { lightweight: true });   // prior frame
  updateBundleGeometry(gl, lB, fr, { lightweight: true });                 // refresh to target
  lB.globalBBox = VBOX.slice();
  if (handle.invalidate) handle.invalidate();
  const r0 = renderer.debugStats.loopBlinnRouteCount;
  renderer.setViewport(W,H); renderer.beginFrame([0,0,0,1]); handle.draw({}); renderer.endFrame();
  const lb = readMask();
  out.frames.push({
    ph, slugCount: slug.count, lbCount: lb.count, lbStream: !!lB._lbStream,
    routed: renderer.debugStats.loopBlinnRouteCount > r0,
    iou: iou(slug.mask, lb.mask), delta: lb.count - slug.count,
  });
}
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
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
for (const f of o.frames) console.log('   frame', JSON.stringify(f));

for (const f of o.frames) {
  if (!f.lbStream || !f.routed) {
    fail('phase ' + f.ph + ' did not LB-stream/route: ' + JSON.stringify(f));
    continue;
  }
  if (f.iou > 0.96) ok('phase ' + f.ph + ' road matches Slug (IoU ' + f.iou.toFixed(4) + ')');
  else
    fail(
      'phase ' +
        f.ph +
        ' road DIVERGES from Slug (IoU ' +
        f.iou.toFixed(4) +
        ', delta ' +
        f.delta +
        'px)',
    );
}

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\\nlbRoadRingParitySmoke: multi-band scrolling road matches Slug through the combined route',
);

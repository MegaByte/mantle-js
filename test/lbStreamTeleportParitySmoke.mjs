// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbStreamTeleportParitySmoke.mjs — refreshLoopBlinnMesh must stay correct when
// a streamed shape's geometry TELEPORTS, not just when it deforms smoothly.
//
// A ring-buffer road reuses a fixed set of shape slots: when
// scroll crosses a group boundary, a slot is reassigned to a DIFFERENT depth
// band, so its geometry jumps discontinuously. The streaming refresh reuses the
// cached earcut triangulation across that jump; if the new polygon's
// convex/reflex structure differs from the cached one, the stale triangulation
// does not tile it → under-fill gaps / "wrong wedges" (and it slips past a
// rim-LENGTH-only validity check because the jumped-to band can have the same
// rim length).
//
// This streams a sequence of structurally-varied curved road bands through ONE
// bundle and asserts each streamed frame matches a FRESH build of the same
// geometry (the always-correct ground truth). A stale-triangulation reuse
// shows up as a low IoU on the frame after a structural jump.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { createRenderer, loadShaders, createBundle, buildStreamableSections, updateBundleGeometry } from '/src/index.js';
import { mkQuad } from '/src/primitives/seg.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setLoopBlinnFill(false);
const W=200,H=200,VBOX=[0,0,W,H];

const straightQ=(a,b)=>mkQuad(a,a,b);
const quadEdge=(n,m,f)=>mkQuad(n,[2*m[0]-(n[0]+f[0])/2,2*m[1]-(n[1]+f[1])/2],f);
const band=(nL,mL,fL,nR,mR,fR)=>[quadEdge(nL,mL,fL),straightQ(fL,fR),quadEdge(fR,mR,nR),straightQ(nR,nL)];
// A perspective band: near y, far y, half-widths, centerline sway at mid.
const mk=(yN,yF,rwN,rwF,sway)=>{
  const yM=(yN+yF)/2, rwM=(rwN+rwF)/2, cx=100;
  return band([cx-rwN,yN],[cx+sway-rwM,yM],[cx-rwF,yF],[cx+rwN,yN],[cx+sway+rwM,yM],[cx+rwF,yF]);
};
// A teleporting sequence that ALTERNATES curve direction while keeping the rim
// LENGTH constant (every band is curved → 5-point rim), plus depth/size jumps.
// Each curve-right↔curve-left transition moves the concave edge (and its reflex
// control point) to the other side at constant rim length — the case a
// rim-length-only validity check misses. This mirrors a ring slot being
// reassigned to a band that curves the opposite way as scroll advances.
const SEQ=[
  mk(180,60,70,12,40),    // curve right (left edge concave), near-wide
  mk(180,60,70,12,-40),   // FLIP: curve left (right edge concave), same rim length
  mk(120,55,30,10,45),    // teleport: far-narrow, curve right
  mk(120,55,30,10,-45),   // FLIP: far-narrow, curve left
  mk(190,40,80,6,55),     // teleport: deep band, hard curve right
  mk(190,40,80,6,-55),    // FLIP: deep band, hard curve left
  mk(175,150,64,40,30),   // teleport: shallow near band, curve right
];

const draw=b=>{renderer.setViewport(W,H);renderer.beginFrame([0,0,0,1]);renderer.drawBundle(b,{});renderer.endFrame();};
const mask=()=>{const px=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const m=new Uint8Array(W*H);let c=0;for(let i=0;i<W*H;i++){if(px[i*4]>100&&px[i*4+1]>100&&px[i*4+2]>100){m[i]=1;c++;}}return {m,c};};
const iou=(a,b)=>{let it=0,u=0;for(let i=0;i<a.length;i++){const uu=a[i]||b[i];u+=uu;it+=(a[i]&&b[i])?1:0;}return u?it/u:1;};
const fill=[{segs:SEQ[0],fill:[0.85,0.85,0.85,1]}];

// One streamed bundle threaded through the whole sequence (refresh reuse).
const streamB=createBundle(gl,buildStreamableSections([{segs:SEQ[0],fill:[0.85,0.85,0.85,1]}],VBOX,{lightweight:true}));
const out=[];
for(let i=0;i<SEQ.length;i++){
  updateBundleGeometry(gl,streamB,[SEQ[i]]);   // refresh (after i=0, uses cached topo)
  streamB.globalBBox=VBOX.slice(); draw(streamB); const st=mask();
  // Fresh ground truth of the same geometry.
  const freshB=createBundle(gl,buildStreamableSections([{segs:SEQ[i],fill:[0.85,0.85,0.85,1]}],VBOX,{lightweight:true}));
  updateBundleGeometry(gl,freshB,[SEQ[i]]);
  freshB.globalBBox=VBOX.slice(); draw(freshB); const fr=mask();
  out.push({i, streamCount:st.c, freshCount:fr.c, iou:iou(st.m,fr.m)});
}
window.__out=out; window.__ready=true;
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
for (const r of o) {
  if (r.iou > 0.99)
    ok(`teleport step ${r.i} streamed == fresh (IoU ${r.iou.toFixed(4)}, ${r.streamCount}px)`);
  else
    fail(
      `teleport step ${r.i} streamed != fresh (IoU ${r.iou.toFixed(4)}, stream ${r.streamCount} vs fresh ${r.freshCount}) — stale triangulation reused across a structural jump`,
    );
}

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\\nlbStreamTeleportParitySmoke: streaming refresh stays correct across geometry teleports',
);

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphImageRouteSmoke — verifies a top-level <image> fill morph composes with
// the GPU-resident LB route. The direct path samples the image atlas at the em
// position (sampleImageLB) × coverage. The image is generated in-page (canvas →
// data URI) so the test is self-contained.
// Checks: the route engages, the rendered fill is the image (many hues, not the
// white tint), and ink ≈ Slug. Image fills take the 1-pass direct path (no RT).
// Metal headful.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const ic=document.createElement('canvas'); ic.width=32; ic.height=4; const ix=ic.getContext('2d');
const g=ix.createLinearGradient(0,0,32,0); g.addColorStop(0,'#ff2020'); g.addColorStop(1,'#2040ff'); ix.fillStyle=g; ix.fillRect(0,0,32,4);
const uri=ic.toDataURL('image/png');
const svg=(x,y,w,h)=>'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 200"><image xlink:href="'+uri+'" x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'"/></svg>';
const W=256,H=256;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders); renderer.setViewport(W,H);
const bSrc=createBundle(gl,await importSvg(svg(50,60,100,80))), bDst=createBundle(gl,await importSvg(svg(40,50,120,100)));
const morph=createShapeMorph(gl,bSrc,bDst);
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
function draw(t){morph.setT(t);clr();const b0=renderer.debugStats.loopBlinnMorphRouteCount;renderer.drawBundle(morph);return {buf:read(),routed:renderer.debugStats.loopBlinnMorphRouteCount-b0};}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const hues=u=>{const s=new Set();for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)s.add(u[i]>>5);return s.size;};
const out={perT:[]};
try {
  const ts=[0,0.5,1];
  renderer.setLoopBlinnMorphFill('off');  const slug=ts.map(draw);
  renderer.setLoopBlinnMorphFill('auto');
  // WAIT FOR THE ROUTE, not for a count of tries: the morph-pair mesh builds off-thread and its program links in the background, and until both
  // are there a draw goes to Slug and reports routed=0. The deadline is the lane's
  // budget, so a route that never comes still fails here and says so.
  const BUDGET=${pageTimeoutFor(120000, 30000)}, DEADLINE=performance.now()+BUDGET;
  out.meshReady=await renderer.awaitLbReady(morph,BUDGET);
  const routedAt=async(t)=>{ let d=draw(t); while(!d.routed&&performance.now()<DEADLINE){ await new Promise(r9=>setTimeout(r9,25)); d=draw(t); } return d; };
  const gpu=[]; for(const t of ts) gpu.push(await routedAt(t));
  for(let i=0;i<ts.length;i++){ const a=slug[i].buf,b=gpu[i].buf; let dpx=0,mx=0;
    for(let k=0;k<a.length;k++){const v=Math.abs(a[k]-b[k]);if(v){dpx++;if(v>mx)mx=v;}}
    out.perT.push({t:ts[i],routed:gpu[i].routed,inkSlug:ink(a),inkGpu:ink(b),huesGpu:hues(b),mx}); }
  out.gate=renderer.debugStats.unifiedFillGate; out.ok=true;
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
await openReady(page, 'http://127.0.0.1:' + server.address().port + '/', {
  ready: () => window.__done === true,
}).catch((e) => console.error(e.message));
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
  if (!r.meshReady) fail('the morph-pair build never finished');
  else if (r.perT.some((p) => p.routed !== 1))
    fail('image morph did not route through LB (gate ' + r.gate + ')');
  else if (r.perT.some((p) => p.huesGpu < 4))
    fail('fill is not the image (too few hues — rendered solid?)');
  else if (r.perT.some((p) => Math.abs(p.inkGpu - p.inkSlug) > Math.max(120, p.inkSlug * 0.04)))
    fail('image morph diverges from Slug');
  else ok('image morph routes through LB, renders the image ≈ Slug (edge-AA only)');
}
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nmorphImageRouteSmoke: image composes with LB');

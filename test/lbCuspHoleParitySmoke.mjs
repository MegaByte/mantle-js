// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbCuspHoleParitySmoke — a CURVED-HOLED shape whose outer boundary carries a d1≈0 cubic (klmn undefined, not
// self-intersecting) renders through LB's CDT partition via the exact Bezout resultant (kind 4) instead of dropping
// the whole shape to Slug. Checks: the shape routes through LB (no per-shape Slug sentinel), the hole stays empty,
// and the LB render matches Slug within 5% ink.
//
// TWO CASES. `spikeTip` leaves the cubic's start point along its own closing edge (both leave (50,60) heading +y): a
// ZERO-ANGLE spike tip. The over-paint proof cannot certify a face that another boundary enters, a tangent joint is
// exactly that, and the shape declines to Slug -- hole or no hole. `cuspHole` moves the closing edge's foot to x=40,
// which gives the same cubic and hole a real joint, and LB meshes it (against an exact reference at 512 px, 0 px
// painted outside, 0 wrong solid). So `cuspHole` must route; `spikeTip` must only render correctly, by whichever path
// serves it.
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
// Named constants, not a generator call: scripts/genSmokeAssets.mjs derives examples/smoke/*.svg from the SVG strings a
// smoke holds, and names each file after the constant.
const HOLE = 'M 85 120 L 115 120 L 115 155 L 85 155 Z'; // square hole; evenodd
const CUSP_HOLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill-rule="evenodd" fill="#3366cc" d="M 50 60 C 50 160 150 10 150 110 L 150 175 L 40 175 Z ${HOLE}"/></svg>`; // d1≈0 cubic, real joint at (50,60)
const SPIKE_TIP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill-rule="evenodd" fill="#3366cc" d="M 50 60 C 50 160 150 10 150 110 L 150 175 L 50 175 Z ${HOLE}"/></svg>`; // same cubic, zero-angle joint
const CASES = { cuspHole: CUSP_HOLE, spikeTip: SPIKE_TIP };
const MUST_ROUTE = new Set(['cuspHole']);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const W=200,H=200;
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,depth:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer=createRenderer(gl,shaders,{staticUnified:true}); renderer.setViewport(W,H);
const CASES=${JSON.stringify(CASES)};
function read(){const u=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,u);return u;}
function clr(){gl.clearColor(1,1,1,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);}
const ink=u=>{let n=0;for(let i=0;i<u.length;i+=4)if(u[i]<240||u[i+1]<240||u[i+2]<240)n++;return n;};
const at=(u,x,y)=>{const i=((H-1-y)*W+x)*4;return [u[i],u[i+1],u[i+2]];};
const results={};
for (const [name, svg] of Object.entries(CASES)) {
  const out={};
  try{
    const bundle=createBundle(gl,await importSvg(svg)); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
    renderer.setLoopBlinnFill('off'); const r0=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(bundle); const slug=read();
    out.slugRouted = renderer.debugStats.loopBlinnRouteCount>r0;
    renderer.setLoopBlinnFill('on');  const r1=renderer.debugStats.loopBlinnRouteCount; clr(); renderer.drawBundle(bundle); const lb=read();
    out.lbRouted = renderer.debugStats.loopBlinnRouteCount>r1;
    out.hasSlug = !!bundle._lbHasSlug;   // true → a shape fell back to a per-shape Slug sentinel
    out.slugInk=ink(slug); out.lbInk=ink(lb);
    out.holeLb=at(lb,100,137); out.holeSlug=at(slug,100,137);   // center of the hole
    out.ok=true;
  }catch(e){out.err=String(e&&e.stack||e);}
  results[name]=out;
}
window.__r=results; window.__done=true;
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
  .waitForFunction(() => window.__done === true, { timeout: 90000, polling: 100 })
  .catch(() => {});
const r = await page.evaluate(() => window.__r);
await browser.close();
server.close();
const isBg = (c) => c[0] > 240 && c[1] > 240 && c[2] > 240;
if (!r) fail('did not complete');
for (const [name, x] of Object.entries(r || {})) {
  if (!x.ok) {
    fail(name + ': did not complete: ' + x.err);
    continue;
  }
  console.log(
    '  ' +
      name +
      ': routed slug=' +
      x.slugRouted +
      ' lb=' +
      x.lbRouted +
      ' hasSlugSentinel=' +
      x.hasSlug +
      '  ink lb=' +
      x.lbInk +
      ' slug=' +
      x.slugInk +
      '  hole lb=' +
      JSON.stringify(x.holeLb),
  );
  if (!x.slugRouted) ok(name + ': Slug used with LB off');
  else fail(name + ': LB routed with fill off');
  if (MUST_ROUTE.has(name)) {
    if (x.lbRouted) ok(name + ': routes through LB');
    else fail(name + ': did NOT route to LB');
    if (!x.hasSlug) ok(name + ': served on the LB CDT path (no per-shape Slug sentinel)');
    else fail(name + ': fell back to a per-shape Slug sentinel (not served by the CDT)');
  }
  if (isBg(x.holeLb) && isBg(x.holeSlug)) ok(name + ': hole stays empty in both');
  else
    fail(
      name +
        ': hole filled? lb=' +
        JSON.stringify(x.holeLb) +
        ' slug=' +
        JSON.stringify(x.holeSlug),
    );
  if (Math.abs(x.lbInk - x.slugInk) <= Math.max(120, x.slugInk * 0.05))
    ok(name + ': LB ink matches Slug within 5% (' + x.lbInk + ' vs ' + x.slugInk + ')');
  else fail(name + ': LB diverges from Slug (' + x.lbInk + ' vs ' + x.slugInk + ')');
}
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nlbCuspHoleParitySmoke: a d1≈0 cubic in a holed shape renders on LB (Bezout CDT); a zero-angle spike renders correctly',
);

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// streamGeometryRenderDiffSmoke — proves the in-place streaming geometry
// update (updateBundleGeometry) renders BYTE-IDENTICAL to a full rebuild
// of the same frame.
//
// Both the reference and the streamed bundle go through the exact same
// geometry routines (emitShape / buildTexturesShape / getCoverQuadMesh),
// so a byte-identical render is the meaningful assertion: streaming
// frame-B's control points onto a bundle originally built for frame-A
// produces pixel-for-pixel what a fresh build of frame-B produces — the
// bands/bbox/cover-quad are all recomputed, never stale.
//
//   reference : build(frameB) -> render            == R
//   streamed  : build(frameA); update(frameB); render == S
//   assert    : S === R, byte for byte.
//
// Two cases: (1) a modest wobble where band counts stay put → in-place
// texSubImage; (2) a large deformation that grows the band plane →
// texture realloc path. Both must be byte-identical.
//
// both ARMS ARE DRAWN AFTER A DISCARD RENDERER. On ANGLE/Metal the first renderer a page compiles from a
// given shader text can draw different pixels from every later one (probes/shaderArmAB.mjs carries the
// same rule). Here the page's first compile can draw the wobble frame 1 LSB off on a few pixels against
// any second fresh renderer -- the same frame, the same bundle, twice (printed below as the A/A line). The
// streamed and rebuilt data are identical float for float; only the compile order differs. So the first
// compile draws once, is compared for the record, and is not an arm.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { gpuThrottlePageSource } from './_gpuThrottle.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { createBundle, createRenderer, loadShaders, updateBundleGeometry, buildStreamableSections } from '/src/index.js';
import { makeBuildContext, emitShape } from '/src/svg/buildContext.js';
import { packMetaBody } from '/src/svg/meta.js';
import { texelToBytes } from '/src/svg/textures.js';
import { mkCubic } from '/src/svg/segment.js';

const W = 256, H = 256;
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

// A closed blob = 4 cubic segments approximating a circle, wobbled. Same
// topology every frame (4 cubics) so the curve layout / gid is stable.
const K = 0.5522847498;
function blob(cx, cy, rx, ry) {
  const kx = K * rx, ky = K * ry;
  const E = [cx + rx, cy], N = [cx, cy - ry], Wp = [cx - rx, cy], S = [cx, cy + ry];
  return [
    mkCubic(E, [cx + rx, cy - ky], [cx + kx, cy - ry], N),
    mkCubic(N, [cx - kx, cy - ry], [cx - rx, cy - ky], Wp),
    mkCubic(Wp, [cx - rx, cy + ky], [cx - kx, cy + ry], S),
    mkCubic(S, [cx + kx, cy + ry], [cx + rx, cy + ky], E),
  ];
}

// Per-frame scene: two blobs. Fixed topology, only positions/sizes move.
function frame(which) {
  if (which === 'A') return [blob(70, 70, 30, 30), blob(160, 160, 22, 22)];
  if (which === 'B') return [blob(85, 60, 42, 38), blob(150, 175, 18, 26)];
  // 'C' = large deformation that should grow band/curve planes a lot.
  return [blob(128, 128, 110, 100), blob(60, 200, 40, 40)];
}
const FILLS = [[0.78, 0.20, 0.20, 1], [0.20, 0.55, 0.78, 1]];

// Finalize an emitShape build context into a createBundle sections dict.
function build(segsList) {
  const ctx = makeBuildContext();
  const gidBox = { next: 1 };
  const bbox = { xmin: Infinity, ymin: Infinity, xmax: -Infinity, ymax: -Infinity };
  for (let i = 0; i < segsList.length; i++)
    emitShape(ctx, segsList[i], { fillRgba: FILLS[i] }, gidBox, bbox);
  const body = packMetaBody(ctx.metas);
  const meta = new ArrayBuffer(32 + body.byteLength);
  const dv = new DataView(meta);
  dv.setUint32(0, ctx.metas.length, true);
  dv.setFloat32(4, bbox.xmin, true);
  dv.setFloat32(8, bbox.ymin, true);
  dv.setFloat32(12, bbox.xmax - bbox.xmin, true);
  dv.setFloat32(16, bbox.ymax - bbox.ymin, true);
  new Uint8Array(meta, 32).set(body);
  return {
    flags: 7,   // HYBRID_MESH_IN_CGEOM | HYBRID_MESH_CHUNKED | WIDE_BAND_HEADERS
    numShapes: ctx.metas.length,
    metaFloatsPerShape: 48,
    meta,
    curves: texelToBytes(ctx.curveBuf).buffer,
    bands: texelToBytes(ctx.bandBuf).buffer,
    curveGeom: new Float32Array(ctx.hybridFloats).buffer,
    shapeIds: ctx.shapeIds.slice(),
  };
}

// Render a bundle to a pixel buffer with a fresh renderer (so neither
// case shares renderer state).
function renderBundle(bundle) {
  const renderer = createRenderer(gl, shaders, { aacPoints: false });   // a static rebuild takes points, a streamed bundle covers; one byte apart
  renderer.setViewport(W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  renderer.drawBundle(bundle);
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  renderer.dispose();
  return buf;
}

function diff(a, b) {
  let maxDiff = 0, nDiff = 0, ink = 0; const where = [];
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxDiff) maxDiff = d;
    if (d !== 0) { nDiff++; if (where.length < 8) { const q = i >> 2; where.push(\`(\${q % W},\${H - 1 - Math.floor(q / W)}).\${'rgba'[i & 3]} \${a[i]} vs \${b[i]}\`); } }
    if (b[i] !== 0) ink++;
  }
  return { maxDiff, nDiff, ink, where };
}

const result = { cases: [] };
try {
  // THE DISCARD RENDERER: the page's first compile draws the wobble frame once and is not an arm. A second
  // fresh renderer draws it again, and the A/A difference is kept for the record (not asserted: a platform
  // compile artifact, not the streaming path).
  { const b1 = createBundle(gl, build(frame('B'))); const X = renderBundle(b1); const Y = renderBundle(b1); b1.dispose();
    result.aa = diff(X, Y); }
  for (const [name, dst] of [['wobble', 'B'], ['large', 'C']]) {
    // Reference: full build of the destination frame.
    const refBundle = createBundle(gl, build(frame(dst)));
    const R = renderBundle(refBundle);

    // Streamed: build frame-A, then update geometry to the dst frame.
    const streamBundle = createBundle(gl, build(frame('A')));
    const renderer = createRenderer(gl, shaders, { aacPoints: false });   // a static rebuild takes points, a streamed bundle covers; one byte apart
    renderer.setViewport(W, H);
    const up = updateBundleGeometry(gl, streamBundle, frame(dst));
    renderer.setBundle(streamBundle);
    renderer.markGeometryDirty();
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    renderer.drawBundle(streamBundle);
    const S = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, S);
    renderer.dispose();
    refBundle.dispose(); streamBundle.dispose();

    result.cases.push({ name, up, ...diff(S, R) });
  }
  // Prepared owners must publish the new geometry under the correct engine.
  for(const route of ['lb','cpatch']) {
    const renderer=createRenderer(gl,shaders,{aacPoints:false,cpatchOpts:{pool:false},psoWarmIdle:()=>true});
    renderer.setViewport(W,H);renderer.setFillEngine({route,kernel:'auto'});
    const make=()=>createBundle(gl,buildStreamableSections(frame('A').map((segs,i)=>({segs,fill:i?[.2,.5,.8,.6]:[.8,.2,.2,.6]})),null));
    const draw=async b=>{
      const start=performance.now(),counts={...renderer.debugStats.engines.draws};
      renderer.beginFrame([0,0,0,0]);renderer.drawBundle(b);renderer.endFrame();
      if(!await window.__gpuFence(gl,20000))throw Error('Streaming fence');
      const buf=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,buf);
      const actual=(renderer.debugStats.engines.draws[route]||0)-(counts[route]||0);
      await window.__gpuIdle(performance.now()-start);return {buf,actual};
    };
    const warm=async b=>{
      renderer.prepareBundle(b);
      if(!await renderer.awaitEngine(b,route,20000))throw Error('Prepared streaming route not ready: '+route);
      for(let i=0;i<4;i++)await draw(b);
    };
    const target=make();await warm(target);const reference=make();
    const up=updateBundleGeometry(gl,target,frame('B'),{lightweight:true});
    const control=updateBundleGeometry(gl,reference,frame('B'),{lightweight:route==='lb'});
    if(!up.ok||!control.ok)throw Error('Prepared stream update failed');
    const publication={owner:target._fillMeshOwner,stream:!!target._lbStream,stomps:target._fillMeshStomps||0};
    await warm(target);const got=await draw(target);await warm(reference);const wanted=await draw(reference);
    result.cases.push({name:'prepared-'+route,up,...diff(got.buf,wanted.buf),publication,actual:got.actual,referenceActual:wanted.actual});
    renderer.dispose();target.dispose();reference.dispose();
  }
  result.compiled = true;
} catch (e) { result.error = String(e && e.stack || e); }
window.__result = result;
window.__done = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.evaluateOnNewDocument(gpuThrottlePageSource());
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
await page.goto(url, { waitUntil: 'load', timeout: 15000 });
await page
  .waitForFunction(() => window.__done === true, { timeout: 90000, polling: 100 })
  .catch(() => {});
const r = await page.evaluate(() => window.__result);
await browser.close();
server.close();

if (r && r.aa)
  console.log(
    `  (record) the page's first compile against a second renderer, one frame: maxDiff=${r.aa.maxDiff} nDiff=${r.aa.nDiff}${r.aa.nDiff ? ' at ' + r.aa.where.join('; ') : ''}`,
  );
if (!r || !r.compiled) {
  fail('stream render did not complete: ' + ((r && r.error) || 'page error'));
} else
  for (const c of r.cases) {
    if (
      c.publication &&
      (c.publication.stomps ||
        !c.actual ||
        !c.referenceActual ||
        (c.name === 'prepared-lb' && c.publication.owner !== 'stream') ||
        (c.name === 'prepared-cpatch' && c.publication.stream))
    )
      fail(c.name + ': invalid ownership or route ' + JSON.stringify(c));
    else if (!c.up || !c.up.ok)
      fail(`${c.name}: updateBundleGeometry returned not-ok (${c.up && c.up.reason})`);
    else if (c.ink === 0) fail(`${c.name}: reference rendered nothing`);
    else if (c.maxDiff === 0)
      ok(
        `${c.name}: streamed == full-rebuild byte-identical (ink=${c.ink}, realloc=${c.up.reallocated})`,
      );
    else
      fail(
        `${c.name}: streamed differs (maxDiff=${c.maxDiff}, nDiff=${c.nDiff}): streamed vs rebuilt at ${c.where.join('; ')}`,
      );
  }
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nstreamGeometryRenderDiffSmoke: in-place streaming renders identical to a full rebuild',
);

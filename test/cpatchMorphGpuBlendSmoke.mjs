// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphGpuBlendSmoke — a CPatch morph drawn through the GPU blend matches the same morph packed
// on the CPU.
//
// The GPU route packs a morph segment once at its start, middle and end and blends every pose from
// those three planes (cpatchMorphBlend). Its shader must decode a block as SEVEN texels
// (cpatchPack.CP_BLOCK_TEXELS): a stride that disagrees reads, from the second block on, the wrong row and
// the wrong block's C-plane entry. The C plane carries the degree-2 w term of texels 2 and 3, which is
// nonzero for Bezout (kind 4) constraints -- and the worker's morph plan converts with forceBezout, so any
// curved CPatch morph packs them. The GPU route is the DEFAULT (opts.cpatchOpts.gpuBlend).
//
// Two renderers on two canvases, one per route; the poses sit mid-segment, where u*C is not zero.
//
// The FIRST pose is the first frame after the plan lands, and that frame is its own case:
// its deferred blend is flushed from inside the pipeline warm, and a pass that switches the warm's
// one-pixel scissor off lets the warm paint the whole morph over the frame -- 525 px off the CPU pack
// at t = 0.2, and nothing off on the same pose drawn later. test/cpatchMorphBlendStateSmoke pins the
// state restore in node; this is the picture.
import { readFileSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256,
  K = 12;
// A ring of TWELVE bowed cubics that only grows in t. Twelve, because the defect needs a SECOND block
// (maxCurves 8 a patch); a scale-only morph, because the planner is fast on it. (test/cpatchMorphServeSmoke
// draws a ring whose bow changes in t.)
function blobPath(t, phase) {
  const R = 40 + 22 * t,
    cx = 100,
    cy = 100,
    f = (v) => v.toFixed(3);
  const at = (j) => [
    cx + R * Math.cos((2 * Math.PI * j) / K + phase * t),
    cy + R * Math.sin((2 * Math.PI * j) / K + phase * t),
  ];
  let d = '';
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1),
      bow = 0.3;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    const c1 = [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
      c2 = [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1];
    if (j === 0) d += `M${f(A[0])} ${f(A[1])}`;
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(B[0])} ${f(B[1])}`;
  }
  return d + ' Z';
}
const svgAt = (t) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#123" d="${blobPath(t, 0)}"/></svg>`;
const SRC = svgAt(0),
  DST = svgAt(1);
const TS = [0.2, 0.45, 0.7];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="a" width="${N}" height="${N}"></canvas><canvas id="b" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
async function side(id, gpuBlend) {
  const gl = document.getElementById(id).getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  // The configuration probes/_cpatchMorphPaired.mjs drives CPatch morphs with: the unified morph
  // route, and the plan requested BY prepareBundle on the morph's own bundle.
  const R = createRenderer(gl, shaders, { cpatchFill: true, cpatchOpts: { interiorN: 8, gpuBlend }, aacFill: false, unifiedMorph: true });
  if (R.ready) await R.ready;
  R.setLoopBlinnFill('on');
  const srcBundle = createBundle(gl, await importSvg(${JSON.stringify(SRC)}));
  const dstBundle = createBundle(gl, await importSvg(${JSON.stringify(DST)}));
  const m = createShapeMorph(gl, srcBundle, dstBundle);
  const bb = m.bundle || m;
  m.setT(0);
  // Wait on undefined as well as 'pending': a bundle not yet prepared has not ASKED for its plan.
  for (let i = 0; i < 1200; i++) {
    if (R.prepareBundle) { try { R.prepareBundle(bb); } catch {} }
    const pl = bb._cpatchMorphPlan;
    if (pl !== undefined && pl !== 'pending') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { gl, R, m, bb, srcBundle, dstBundle, plan: bb._cpatchMorphPlan };
}
const A = await side('a', true), B = await side('b', false);
async function frame(s, t) {
  s.m.setT(t);
  let drewCp = 0;
  for (let i = 0; i < 300 && !drewCp; i++) {
    if (s.R.prepareBundle) { try { s.R.prepareBundle(s.bb); } catch {} }
    const before = ((s.R.debugStats.engines || {}).draws || {}).cpatch | 0;
    s.R.setViewport(${N}, ${N}); s.R.beginFrame([1, 1, 1, 1]); s.R.drawBundle(s.m); s.R.endFrame();
    if (s.R.precompileFills) { try { s.R.precompileFills(); } catch {} }
    drewCp = (((s.R.debugStats.engines || {}).draws || {}).cpatch | 0) - before;
    if (!drewCp) await new Promise((r) => setTimeout(r, 20));
  }
  const px = new Uint8Array(${N} * ${N} * 4);
  s.gl.readPixels(0, 0, ${N}, ${N}, s.gl.RGBA, s.gl.UNSIGNED_BYTE, px);
  return { px, drewCp };
}
window.__run = async (ts) => {
  const out = [];
  for (const t of ts) {
    const a = await frame(A, t), b = await frame(B, t);
    let diff = 0, maxd = 0, ink = 0;
    for (let i = 0; i < a.px.length; i += 4) {
      const d = Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2]));
      if (d > 2) diff++; if (d > maxd) maxd = d; if (b.px[i] < 128) ink++;
    }
    out.push({ t, diff, maxd, ink, cpA: a.drewCp, cpB: b.drewCp, blendA: !!A.bb._cpatchBlend, blendB: !!B.bb._cpatchBlend, planA: typeof A.plan === 'object' && !!A.plan });
  }
  return out;
};
window.__dispose = async () => {
  const { gl, R, m, bb } = A, target = bb._cpatchBlend;
  if (!target) throw Error('No prepared GPU blend to dispose');
  const pass = target.pass, textures = target.tex.slice(), fbo = target.fbo;
  const alive = () => ({ planes: textures.filter(t => gl.isTexture(t)).length,
    framebuffer: gl.isFramebuffer(fbo), program: gl.isProgram(pass.prog),
    vao: gl.isVertexArray(pass.vao), buffer: gl.isBuffer(pass.vb) });
  // Warm an unrelated analytic draw on the same renderer before queuing the
  // morph's final coefficient write. Its next image must survive disposal.
  const other = createBundle(gl, await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="M60 60L140 60L100 140Z" fill="#c24"/></svg>'));
  const drawOther = () => { R.setViewport(${N}, ${N}); R.beginFrame([1,1,1,1]); R.drawBundle(other); R.endFrame(); };
  const deadline = performance.now()+60000;
  while (true) {
    R.prepareBundle(other);
    const cpBefore = R.debugStats.engines?.draws?.cpatch||0;
    drawOther();
    if ((R.debugStats.engines?.draws?.cpatch||0)>cpBefore) break;
    if (performance.now()>deadline) throw Error('Unrelated CPatch draw did not prepare');
    await new Promise(r=>setTimeout(r,20));
  }
  const warmed = await R.warmScene([{name:'unrelated disposal reference',draw:drawOther}], {maxPasses:128,readyTimeoutMs:60000,fenceTimeoutMs:60000});
  if (!warmed.complete) throw Error('Unrelated disposal reference did not warm');
  const readOther = () => {drawOther();const px=new Uint8Array(${N}*${N}*4);gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);return px;};
  const reference = readOther();
  let activeProgram=null, blendDraws=0;
  const nativeUseProgram=gl.useProgram, nativeDrawArrays=gl.drawArrays;
  gl.useProgram=function(p){activeProgram=p;return nativeUseProgram.call(this,p);};
  gl.drawArrays=function(...a){if(activeProgram===pass.prog)blendDraws++;return nativeDrawArrays.apply(this,a);};
  m.setT(.61); const prepared=R.prepareBundle(bb), pose=bb._cpatchMorphT;
  const blendDrawsBeforeDispose=blendDraws, sameTarget=bb._cpatchBlend===target;
  const before = alive();
  m.dispose(); A.srcBundle.dispose(); A.dstBundle.dispose();
  const afterBundle = alive(), pixels = readOther();
  let changed=0,maxDifference=0,ink=0;
  for(let i=0;i<pixels.length;i++) {const d=Math.abs(pixels[i]-reference[i]);changed+=d>0;maxDifference=Math.max(maxDifference,d);if(i%4===0&&reference[i]<220)ink++;}
  const blendDrawsAfterDispose=blendDraws;
  gl.useProgram=nativeUseProgram;gl.drawArrays=nativeDrawArrays;
  const nextDrawError=gl.getError(), device=gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
  other.dispose();
  R.dispose(); R.dispose();
  const afterRenderer = alive();
  B.m.dispose(); B.srcBundle.dispose(); B.dstBundle.dispose(); B.R.dispose();
  return { before, afterBundle, afterRenderer, prepared, pose, sameTarget, blendDrawsBeforeDispose, blendDrawsAfterDispose, changed, maxDifference, ink, nextDrawError, device, error: gl.getError() };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

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
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });
  const res = await page.evaluate((ts) => window.__run(ts), TS);
  for (const r of res) {
    console.log(
      `  t=${r.t}: ${r.diff} px differ by more than 2/255 (max ${r.maxd}), ink ${r.ink}, cpatch draws gpu ${r.cpA} / cpu ${r.cpB}`,
    );
    if (!r.cpA || !r.cpB) {
      fail(`t=${r.t}: a side did not draw with CPatch — the comparison would be Slug against Slug`);
      continue;
    }
    if (!r.blendA || r.blendB) {
      fail(
        `t=${r.t}: the GPU side ${r.blendA ? 'used' : 'did NOT use'} the blend and the CPU side ${r.blendB ? 'DID' : 'did not'} — the arms are not the two routes`,
      );
      continue;
    }
    if (r.ink < 1000) {
      fail(`t=${r.t}: the frame is nearly blank (${r.ink} ink px)`);
      continue;
    }
    if (r.diff === 0) ok(`t=${r.t}: the GPU blend matches the CPU pack (max ${r.maxd}/255)`);
    else fail(`t=${r.t}: the GPU blend differs from the CPU pack on ${r.diff} px`);
  }
  const released = await page.evaluate(() => window.__dispose());
  if (process.env.MANTLE_CPATCH_BLEND_REPORT)
    writeFileSync(process.env.MANTLE_CPATCH_BLEND_REPORT, JSON.stringify(released, null, 2) + '\n');
  console.log('disposed blend recovery: ' + JSON.stringify(released));
  const { before, afterBundle, afterRenderer } = released;
  if (
    process.env.MANTLE_TEST_GL === 'metal' &&
    (!/Metal/.test(released.device) || /SwiftShader/i.test(released.device))
  )
    fail('physical Metal required');
  if (
    !released.prepared ||
    released.pose !== 0.61 ||
    !released.sameTarget ||
    released.blendDrawsBeforeDispose !== 0 ||
    released.ink < 1000
  )
    fail('disposal control requires a pending coefficient write and nonblank unrelated reference');
  else
    ok('disposal control queued a real coefficient write and retained a nonblank unrelated draw');
  if (released.changed || released.nextDrawError !== 0 || released.blendDrawsAfterDispose !== 0)
    fail(
      'a disposed coefficient target must not change the next unrelated draw or produce a GL error',
    );
  else ok('discarded deferred write preserves the next unrelated draw exactly without GL errors');
  if (
    before.planes !== 3 ||
    !before.framebuffer ||
    !before.program ||
    !before.vao ||
    !before.buffer
  )
    fail('blend resources must be live before disposal');
  else ok('prepared blend owns three planes, its framebuffer and helper');
  if (
    afterBundle.planes ||
    afterBundle.framebuffer ||
    !afterBundle.program ||
    !afterBundle.vao ||
    !afterBundle.buffer
  )
    fail(
      'bundle disposal must release target resources while retaining the renderer-owned warm helper',
    );
  else ok('bundle disposal releases the target and retains the warm helper');
  if (Object.values(afterRenderer).some(Boolean) || released.error !== 0)
    fail('final renderer disposal must release the helper without a GL error');
  else ok('final renderer disposal releases program, VAO and buffer');
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\ncpatchMorphGpuBlendSmoke: the GPU morph blend draws what the CPU pack draws');

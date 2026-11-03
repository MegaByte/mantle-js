// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _glCallAudit.mjs — every per-draw GL call, and which of them are REDUNDANT.
//
// The second half of step 7. The first half (probes/_dataPlacementAudit.mjs) counts
// where DATA lives; this counts what the driver is told about it every frame.
//
// GL-call counting is the sanctioned headless measurement here: wall-clock A/Bs at
// this magnitude do not converge (probes/_strokePathAB.mjs swung 2.4x on identical
// code), but a call that sets a value the driver already has is waste that can be
// proven without timing anything.
//
// Redundancy is judged per steady-state frame, after warm-up, by shadowing the
// state the call sets:
//   bindTexture(unit, tex)  redundant if that unit already holds that texture
//   uniformNf/Ni/Matrix     redundant if that location already holds those values
//   useProgram / bindVAO    redundant if already current
// MEASURED on examples/tiger.svg (304 shapes) via the unified route:
//
//   ONE steady-state frame = 9 GL calls total, 1 draw, 0 redundant
//     depthMask 2 · bindVertexArray 2 · disable 1 · clear 1 · bindBuffer 1
//     enable 1 · drawArrays 1
//
// So there is NO per-draw state win available on this path: the renderer's state
// shadow already suppresses redundant enable/disable/depthMask, and the unified
// stream's vertex buffer is uploaded once per geometry generation rather than per
// frame. "fillPass re-binds ~10 textures per draw" does not apply here — it
// belongs to the per-shape COMPOSED path, which the unified route does not use
// for this content.
//
// That makes the vertex-stream redundancy (probes/_dataPlacementAudit.mjs, 28.8%
// of the stream on this same asset) the only remaining data-placement lever of
// any size, which is worth knowing before spending effort on state caching.
//
// A redundant call is not automatically removable — some exist to defend against
// state another pass clobbers, which this cannot see. It is a candidate list.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// ASSET_ROOT: an extra directory to serve assets from, for ASSETS entries that live outside the package.
const ASSET_ROOT = process.env.ASSET_ROOT ? path.resolve(process.env.ASSET_ROOT) : null;
const ASSETS = (process.env.ASSETS || 'examples/tiger.svg').split(',');

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="1024" height="1024"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, depth:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const ASSETS = ${JSON.stringify(ASSETS)};

// ── shadow + counters ──────────────────────────────────────────────────────
let counting = false;
const calls = new Map(), redundant = new Map();
const bump = (m, k) => m.set(k, (m.get(k) | 0) + 1);
const texUnit = new Map(); let activeUnit = 0, curProg = null, curVao = null;
const uni = new Map();
const key = (loc, v) => { const l = uni.get(loc); return l !== undefined && l === v; };
const wrap = (name, fn) => { const o = gl[name].bind(gl); gl[name] = (...a) => { if (counting) fn(a); return o(...a); }; };

wrap('activeTexture', (a) => { bump(calls, 'activeTexture');
  if (activeUnit === a[0]) bump(redundant, 'activeTexture'); activeUnit = a[0]; });
wrap('bindTexture', (a) => { bump(calls, 'bindTexture');
  const k = activeUnit + ':' + a[0];
  if (texUnit.get(k) === a[1]) bump(redundant, 'bindTexture'); texUnit.set(k, a[1]); });
wrap('useProgram', (a) => { bump(calls, 'useProgram');
  if (curProg === a[0]) bump(redundant, 'useProgram'); curProg = a[0]; });
wrap('bindVertexArray', (a) => { bump(calls, 'bindVertexArray');
  if (curVao === a[0]) bump(redundant, 'bindVertexArray'); curVao = a[0]; });
for (const n of ['uniform1i','uniform1f','uniform2f','uniform3f','uniform4f','uniform1iv','uniform2fv','uniform4fv','uniformMatrix3fv','uniformMatrix4fv'])
  wrap(n, (a) => { bump(calls, 'uniform*');
    const v = n + '|' + a.slice(1).map(x => (x && x.length !== undefined) ? Array.from(x).join(',') : x).join(',');
    if (key(a[0], v)) bump(redundant, 'uniform*'); uni.set(a[0], v); });
for (const n of ['bindBuffer','bufferData','bufferSubData','vertexAttribPointer','enableVertexAttribArray','bindFramebuffer','viewport','scissor','clear','blendFunc','blendEquation','enable','disable','depthFunc','depthMask','colorMask'])
  wrap(n, () => bump(calls, n));
for (const n of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced'])
  wrap(n, () => bump(calls, 'DRAW'));

const out = [];
for (const src of ASSETS) {
  let svg; try { svg = await (await fetch('/' + src)).text(); } catch { continue; }
  const r = createRenderer(gl, shaders, { aacFill: false });
  await r.ready; r.setViewport(1024, 1024); r.setLoopBlinnFill('on');
  const b = createBundle(gl, await importSvg(svg));
  try { r.prepareBundle(b); } catch {}
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 30000); } catch {} }
  const f = () => { r.beginFrame([0,0,0,1]); r.drawBundle(b, {}); r.endFrame(); };
  f(); if (r.precompileFills) r.precompileFills();
  f(); if (r.precompileFills) r.precompileFills();
  for (let i=0;i<10;i++){ f(); await new Promise(res=>requestAnimationFrame(res)); }
  // steady state: shadow is warm, so anything counted redundant now is per-frame waste
  calls.clear(); redundant.clear(); counting = true;
  f();
  counting = false;
  out.push({ src, shapes: b.numShapes|0, uni: r.debugStats.unifiedFillDraws|0,
             calls: Object.fromEntries(calls), redundant: Object.fromEntries(redundant) });
  try { b.dispose(); } catch {}
}
window.out = out;
</script></body></html>`;
const server = http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/') {
    s.writeHead(200, { 'content-type': 'text/html' });
    s.end(HTML);
    return;
  }
  const p1 = path.join(ROOT, decodeURIComponent(u.pathname)),
    p2 = ASSET_ROOT && path.join(ASSET_ROOT, decodeURIComponent(u.pathname));
  for (const p of [p1, p2].filter(Boolean)) {
    try {
      const b = readFileSync(p);
      s.writeHead(200, {
        'content-type': /\.(js|mjs)$/.test(u.pathname)
          ? 'text/javascript'
          : u.pathname.endsWith('.glsl')
            ? 'text/plain'
            : u.pathname.endsWith('.svg')
              ? 'image/svg+xml'
              : 'text/html',
      });
      s.end(b);
      return;
    } catch {}
  }
  try {
    s.writeHead(404);
  } catch {}
  s.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 600000,
});
const pg = await br.newPage();
const logs = [];
pg.on('pageerror', (e) => logs.push(String(e.message)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
try {
  await pg.waitForFunction('typeof window.out!=="undefined"', { timeout: 580000 });
} catch {
  console.log('never finished:\n  ' + (logs.join('\n  ') || '(none)'));
  await br.close();
  server.close();
  process.exit(1);
}
const r = await pg.evaluate(() => window.out);
await br.close();
server.close();
for (const x of r) {
  console.log(`\n${x.src}  (${x.shapes} shapes, unifiedDraws ${x.uni})  ONE steady-state frame`);
  const keys = Object.keys(x.calls).sort((a, b) => x.calls[b] - x.calls[a]);
  console.log('  call'.padEnd(28) + 'count'.padStart(7) + 'redundant'.padStart(11) + '  %');
  for (const k of keys) {
    const c = x.calls[k],
      rd = x.redundant[k] || 0;
    console.log(
      '  ' +
        k.padEnd(26) +
        String(c).padStart(7) +
        String(rd).padStart(11) +
        '  ' +
        (rd ? ((100 * rd) / c).toFixed(0) + '%' : ''),
    );
  }
}

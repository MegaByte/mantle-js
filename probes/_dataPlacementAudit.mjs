// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _dataPlacementAudit.mjs — where does the fill shader's per-draw data LIVE, and
// is that the cheapest place for it?
//
// Step 7. Enumerates the actual bytes: per-vertex attributes (and how much of that
// is DUPLICATED across a triangle's three vertices), per-shape texture rows, and
// per-draw uniforms. Attribute redundancy is the interesting number because the
// unified stream carries 16 of its 29 floats per LB vertex as per-CURVE constants
// repeated three times — flagged in unifiedFillVerts.js as an open question rather
// than assumed either way, since this codebase has already measured a vertex
// texture fetch LOSING to a plain attribute (the shape-row binary search).
//
// MEASURED:
//
//   examples/tiger.svg   304 shapes
//     unified stream   2 044 152 B   (17 622 verts x 29 floats)
//     LB triangles     5 508, of which 4 598 (83%) carry per-curve data IDENTICAL
//                      across all three vertices
//     redundant        588 544 B = 28.8% of the stream
//     meta              58 368 B
//
//   examples/smoke/lbGpuMorph__SRC.svg   1 shape
//     redundant        2 816 B = 19.3% of the stream
//
// So the duplication is real and large, and it is the single biggest data-placement
// item in the fill path. What it is NOT is automatically worth moving: the stream is
// built once per geometry generation and cached, so the cost is upload bandwidth and
// vertex-fetch bandwidth, not per-frame CPU — and against that sits a measured
// precedent in this codebase of a vertex texture fetch losing to a plain attribute.
// A per-curve texture indexed by one attribute would cut ~29% of the stream; whether
// that pays needs an A/B, and per probes/_strokePathAB.mjs the per-config-canvas
// style of A/B does not converge at this magnitude, so it needs the
// build-all-canvases-up-front + rotation discipline of _balanceBench.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = (
  process.env.ASSETS || 'examples/tiger.svg,examples/smoke/lbGpuMorph__SRC.svg'
).split(',');
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const ASSETS = ${JSON.stringify(ASSETS)};
const out = [];
for (const src of ASSETS) {
  let svg; try { svg = await (await fetch('/' + src)).text(); } catch { continue; }
  // unifiedFillKeepVerts: the renderer drops the CPU copy of the stream after
  // uploading it (it is dead weight in production), but this audit's whole job is to
  // walk that array and count per-curve duplication, so it opts back in.
  const r = createRenderer(gl, shaders, { aacFill: false, unifiedFillKeepVerts: true });
  await r.ready; r.setViewport(512, 512); r.setLoopBlinnFill('on');
  const b = createBundle(gl, await importSvg(svg));
  try { r.prepareBundle(b); } catch {}
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 30000); } catch {} }
  const f = () => { r.beginFrame([0,0,0,1]); r.drawBundle(b, {}); r.endFrame(); };
  f(); if (r.precompileFills) r.precompileFills();
  f(); if (r.precompileFills) r.precompileFills();
  for (let i=0;i<8;i++){ f(); if ((r.debugStats.unifiedFillDraws|0)>0) break; await new Promise(res=>requestAnimationFrame(res)); }
  const uf = b._unifiedFill;
  const rec = { src, shapes: b.numShapes|0, uni: r.debugStats.unifiedFillDraws|0 };
  if (uf && uf.verts) {
    const stride = uf.morph ? 50 : 29, n = uf.vertexCount|0;
    rec.streamBytes = uf.verts.byteLength; rec.verts = n; rec.stride = stride;
    // How many of the 16 per-curve floats (offset 13..28) are IDENTICAL across
    // each triangle's three vertices? Those are per-CURVE, not per-vertex.
    let dupTris = 0, tris = 0;
    for (let t = 0; t + 2 < n; t += 3) {
      const a = t*stride, c = (t+1)*stride, d = (t+2)*stride;
      if (uf.verts[a+9] < 0.5) continue;         // cover quad, not LB
      tris++;
      let same = true;
      for (let k = 13; k < 29 && same; k++)
        if (uf.verts[a+k] !== uf.verts[c+k] || uf.verts[a+k] !== uf.verts[d+k]) same = false;
      if (same) dupTris++;
    }
    rec.lbTris = tris; rec.dupTris = dupTris;
    rec.dupBytes = dupTris * 2 * 16 * 4;         // 2 redundant copies x 16 floats
  }
  rec.curveTexBytes = b.curveTex ? (b.curveW|0) * (b.curveH|0) * 16 : 0;
  rec.metaBytes = b.metaFloats ? b.metaFloats.byteLength : 0;
  out.push(rec);
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
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
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
  } catch {
    try {
      s.writeHead(404);
    } catch {}
    s.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const pg = await br.newPage();
const logs = [];
pg.on('pageerror', (e) => logs.push(String(e.message)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
try {
  await pg.waitForFunction('typeof window.out!=="undefined"', { timeout: 280000 });
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
  console.log(`\n${x.src}  (${x.shapes} shapes, unifiedDraws ${x.uni})`);
  if (x.streamBytes != null) {
    console.log(`  unified stream   ${x.streamBytes} B  (${x.verts} verts x ${x.stride} floats)`);
    console.log(
      `  LB triangles     ${x.lbTris}, of which ${x.dupTris} have per-curve data IDENTICAL across all 3 verts`,
    );
    console.log(
      `  redundant bytes  ${x.dupBytes} B = ${((100 * x.dupBytes) / Math.max(x.streamBytes, 1)).toFixed(1)}% of the stream`,
    );
  } else console.log('  no unified stream built');
  console.log(`  curve texture    ${x.curveTexBytes} B`);
  console.log(`  meta             ${x.metaBytes} B`);
}

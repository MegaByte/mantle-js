// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbTranslucentSolidSmoke — forced LB serves translucent solids and composites
// alpha exactly, including overlapping shapes (no pixel composited twice).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 200;

// Two overlapping translucent solid discs, drawn as proper 4-cubic circles (tangent
// control points, k = 0.5523r). Do NOT use corner-style control points here: those
// classify as kind-4 (Bezout) cubics, which have their own open under-fill bug
// (probes/_lbCubicCircleBug.mjs) and would make this test fail for an unrelated reason.
// The center band is covered by both: red-over-blue at 50% each.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">
  <path fill="#3366cc" fill-opacity="0.5" d="M 30 100 C 30.000 72.385 52.385 50.000 80 50 C 107.615 50.000 130.000 72.385 130 100 C 130.000 127.615 107.615 150.000 80 150 C 52.385 150.000 30.000 127.615 30 100 Z"/>
  <path fill="#cc3333" fill-opacity="0.5" d="M 70 100 C 70.000 72.385 92.385 50.000 120 50 C 147.615 50.000 170.000 72.385 170 100 C 170.000 127.615 147.615 150.000 120 150 C 92.385 150.000 70.000 127.615 70 100 Z"/>
</svg>`;
const QUAD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">
  <path fill="#3366cc" fill-opacity="0.5" d="M 30 45 Q 100 15 170 45 L 170 155 Q 100 185 30 155 Z"/>
</svg>`;
emitFixture('lbTranslucentSolid__SVG', SVG);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
// The double-paint question is the unified draw's, answered by a painter-order depth
// claim (see unifiedFillDraw) — and that is what the pixel assertions below check.
const renderer = createRenderer(gl, shaders, { staticUnified: true });
// Exercise prepareBundle's synchronous builder before its queued worker can
// publish. It must choose the same convex-translucent chain plan as the worker.
const qBundle = createBundle(gl, await importSvg(${JSON.stringify(QUAD_SVG)}));
const syncPrepared = renderer.prepareBundle(qBundle);
const qChain = qBundle._lbMeshesRaw && qBundle._lbMeshesRaw[0] && qBundle._lbMeshesRaw[0].interiorChainA;
const syncConvexHasChain = !!qChain && qChain.some(v => v !== 0);
qBundle.dispose();
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle);
const draw = () => { renderer.setViewport(N,N); renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };
const readAll = () => { const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); return Array.from(px); };
const at = (px, x, yTop) => { const o = ((N-1-yTop)*N + x)*4; return [px[o], px[o+1], px[o+2]]; };

renderer.setLoopBlinnFill('off'); draw(); const slug = readAll();
const c0 = renderer.debugStats.loopBlinnRouteCount;
// awaitLbReady, not just prepareBundle: while the LB-hosting variant links a bundle
// falls to the best non-LB engine, so a one-frame draw would route nothing.
renderer.setLoopBlinnFill('on'); await renderer.awaitLbReady(bundle); draw(); const lb = readAll();
const lbRouted = renderer.debugStats.loopBlinnRouteCount - c0;

let maxDiff = 0, sum = 0;
for (let i = 0; i < slug.length; i++) { const d = Math.abs(slug[i]-lb[i]); if (d>maxDiff) maxDiff=d; sum+=d; }

// where does it differ? coarse 4x4 map of mean |diff| per cell + ink counts
const cells=[];
for(let cy=0;cy<4;cy++){ const row=[];
  for(let cx=0;cx<4;cx++){ let acc=0,n=0;
    for(let y=cy*N/4;y<(cy+1)*N/4;y++) for(let x=cx*N/4;x<(cx+1)*N/4;x++){
      const o=(y*N+x)*4; for(let k=0;k<3;k++){acc+=Math.abs(slug[o+k]-lb[o+k]); n++;} }
    row.push(+(acc/n).toFixed(1)); }
  cells.push(row); }
const ink=(px)=>{let n=0; for(let i=0;i<px.length;i+=4) if(px[i]<250||px[i+1]<250||px[i+2]<250) n++; return n;};

// DOUBLE-COMPOSITE DETECTOR. A mean over the whole image cannot see a one-pixel line, so it
// misses what this pins: an AA ring extruded from EVERY cubic hull edge, including the chord
// shared with the interior triangle, lies inside the fill and its klm reads "inside", so it
// paints coverage 1 a second time — invisible under an opaque
// fill, a solid line under a translucent one. Any LB pixel materially DARKER than Slug on a
// white ground is a pixel composited twice. There must be none.
let doubled = 0, worst = 0;
for (let i = 0; i < N*N; i++) {
  const o = i*4;
  const d = ((slug[o]+slug[o+1]+slug[o+2]) - (lb[o]+lb[o+1]+lb[o+2])) / 3;
  // > 16, not > 8: a genuine double-composite is huge (a 0.5 fill compositing to 0.75 reads ~35
  // and this fixture reads up to 56). Edge pixels differ by single digits simply because the two
  // kernels round differently at an edge, and scoring those would make this a test of AA agreement rather than of double-compositing.
  if (d > 16) { doubled++; if (d > worst) worst = d; }
}
window.__out = {
  doubled, worstDark: +worst.toFixed(1),
  cells, inkSlug: ink(slug), inkLb: ink(lb),
  lbRouted,
  syncPrepared, syncConvexHasChain,
  maxDiff, meanDiff: sum/slug.length,
  // (120,100) lies in the overlap of both discs; (55,100) only in the blue one.
  overlapLb: at(lb,120,100), overlapSlug: at(slug,120,100),
  soloLb:    at(lb,55,100),  soloSlug:    at(slug,55,100),
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
const near = (a, b, t) => a.every((v, i) => Math.abs(v - b[i]) <= t);

console.log('  diff map (mean |Δ| per 50x50 cell, top row = top of image):');
for (const row of o.cells) console.log('    ' + row.map((v) => String(v).padStart(6)).join(''));
console.log(`  ink: slug=${o.inkSlug} lb=${o.inkLb} (ratio ${(o.inkLb / o.inkSlug).toFixed(3)})`);
ok(o.lbRouted > 0, `translucent solids take the forced LB route (routes=${o.lbRouted})`);
ok(
  o.syncPrepared && !o.syncConvexHasChain,
  'synchronous and worker builders both omit convex translucent PART chains',
);
// LB/Slug differ by a few LSBs on cubic AA edges; interior pixels must agree tightly.
ok(o.meanDiff <= 3.0, `matches all-Slug (meanDiff=${o.meanDiff.toFixed(4)}, maxDiff=${o.maxDiff})`);
// The one that matters for translucency, and the one a mean cannot see.
ok(
  o.doubled === 0,
  `NO pixel is composited twice (${o.doubled} px darker than Slug, worst Δlum ${o.worstDark})`,
);
ok(
  near(o.overlapLb, o.overlapSlug, 3),
  `α composites exactly where the two discs OVERLAP (lb=${o.overlapLb} slug=${o.overlapSlug})`,
);
ok(
  near(o.soloLb, o.soloSlug, 3),
  `α correct in the singly-covered region (lb=${o.soloLb} slug=${o.soloSlug})`,
);

console.log(fail ? `\nLB-TRANSLUCENT-SOLID FAIL (${fail})` : '\nLB-TRANSLUCENT-SOLID PASS');
process.exit(fail ? 1 : 0);

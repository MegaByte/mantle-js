// lbGradientBatchSmoke — many DIFFERENT gradients must ride LB's one-draw combined route.
//
// The combined route paints solid colour from the per-vertex aColor attribute, so a
// gradient shape used to force the per-shape route (one draw + one uniform set per shape).
// Vertex-attribute locations are exhausted (loc 15 is taken; GL guarantees only 16), so
// per-shape paint now rides a TEXTURE indexed by the aShapeRow the route already carries:
//     texel (0,row) = (gradientId, 0, 0, 0)     texel (1,row) = shape em bbox
//
// A single uGradId uniform cannot serve a bundle whose shapes have DIFFERENT gradients —
// that is exactly what this pins, together with pixel parity against Slug. Both linear and
// radial, because objectBoundingBox units are resolved from the per-shape bbox texel.
//
// This removes a structural reason a bundle falls off the batched route.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 256;

// K discs, each with its OWN gradient. Tangent-control circles (k = 0.5523r) so the
// cubics are kind-2 and exact — corner controls would trip degree reduction, unrelated.
function sheet(K, kind) {
  const cols = Math.round(Math.sqrt(K)), cell = N / cols, r = cell * 0.40;
  let defs = '', body = '';
  for (let i = 0; i < K; i++) {
    const cx = (i % cols) * cell + cell / 2, cy = Math.floor(i / cols) * cell + cell / 2;
    const h1 = (i * 53) % 360, h2 = (i * 53 + 140) % 360;
    defs += kind === 'linear'
      ? `<linearGradient id="g${i}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1},70%,55%)"/><stop offset="1" stop-color="hsl(${h2},70%,45%)"/></linearGradient>`
      : `<radialGradient id="g${i}" cx="0.5" cy="0.5" r="0.6"><stop offset="0" stop-color="hsl(${h1},70%,60%)"/><stop offset="1" stop-color="hsl(${h2},70%,40%)"/></radialGradient>`;
    const k = 0.5523 * r;
    const P = [[cx - r, cy], [cx, cy - r], [cx + r, cy], [cx, cy + r]];
    let d = `M ${P[0][0]} ${P[0][1]} `;
    for (let j = 0; j < 4; j++) {
      const A = P[j], B = P[(j + 1) % 4];
      const ta = [-(A[1] - cy), (A[0] - cx)], tb = [-(B[1] - cy), (B[0] - cx)];
      d += `C ${(A[0] + ta[0] / r * k).toFixed(3)} ${(A[1] + ta[1] / r * k).toFixed(3)} ${(B[0] - tb[0] / r * k).toFixed(3)} ${(B[1] - tb[1] / r * k).toFixed(3)} ${B[0]} ${B[1]} `;
    }
    body += `<path fill="url(#g${i})" d="${d}Z"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><defs>${defs}</defs>${body}</svg>`;
}
const CASES = { 'linear x16': sheet(16, 'linear'), 'radial x16': sheet(16, 'radial') };

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const CASES = ${JSON.stringify(CASES)}, N = ${N};
const r = createRenderer(gl, shaders);
const readAll = () => { const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const out = [];
for (const [name, svg] of Object.entries(CASES)) {
  const b = createBundle(gl, await importSvg(svg));
  r.prepareBundle(b);
  const draw = () => { r.setViewport(N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); };
  r.setLoopBlinnFill('off'); draw(); const s = readAll();
  const c0 = r.debugStats.loopBlinnRouteCount;
  r.setLoopBlinnFill('auto'); draw(); const l = readAll();
  const autoRouted = r.debugStats.loopBlinnRouteCount - c0;
  let mx = 0, sum = 0;
  for (let i = 0; i < s.length; i++) { const d = Math.abs(s[i]-l[i]); if (d>mx) mx=d; sum+=d; }
  // colour VARIETY: if every shape wrongly sampled the same gradient (a single uniform),
  // the distinct colours at disc centres would collapse. Sample each disc's centre.
  const cols = Math.round(Math.sqrt(16)), cell = N/cols;
  const centres = [];
  for (let i = 0; i < 16; i++) {
    const cx = Math.round((i%cols)*cell + cell/2), cyTop = Math.round(Math.floor(i/cols)*cell + cell/2);
    const o = ((N-1-cyTop)*N + cx)*4;
    centres.push(l[o] + ',' + l[o+1] + ',' + l[o+2]);
  }
  out.push({ name, autoRouted, combined: !!b._lbCombined, maxDiff: mx, meanDiff: sum/s.length,
             distinct: new Set(centres).size });
  b.dispose();
}
window.__out = out; window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000 });
const o = await pg.evaluate(() => window.__out);
await br.close(); server.close();

let fail = 0;
const ok = (c, m) => c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m));
for (const r of o) {
  ok(r.autoRouted > 0, `${r.name}: gradient bundle takes the LB route under 'auto'`);
  ok(r.combined, `${r.name}: rides the ONE-DRAW combined route`);
  ok(r.distinct >= 14, `${r.name}: each shape keeps its OWN gradient (${r.distinct}/16 distinct centres)`);
  ok(r.meanDiff <= 3.0, `${r.name}: matches all-Slug (meanDiff=${r.meanDiff.toFixed(3)}, maxDiff=${r.maxDiff})`);
}
console.log(fail ? `\nLB-GRADIENT-BATCH FAIL (${fail})` : '\nLB-GRADIENT-BATCH PASS');
process.exit(fail ? 1 : 0);

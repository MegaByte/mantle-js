// lbCubicOverfillSmoke — LB must not over- or under-fill cubic shapes.
//
// Two defects, both measured by INK (pixels covered) against Slug rather than by mean
// channel diff: a few percent of over-fill hides inside AA-edge noise but shows up
// immediately in ink.
//
// 1. OVER-FILL. A Loop-Blinn cover hull is only sound when it contains exactly ONE
//    branch of the piece's implicit k³−lm. CUBIC_COVER_SUBDIV was 1 — i.e. cubics were
//    never subdivided beyond their inflections — so a FAT hull swallowed a second branch,
//    the sign flipped inside it, and the crescent filled out toward the convex hull.
//    Cubic pieces are now split ADAPTIVELY on control-polygon flatness. (Quads and arcs
//    emit one non-overlapping control triangle per segment and were always exact.)
//
// 2. UNDER-FILL. A cubic with C3 = -P0+3P1-3P2+P3 == 0 is a QUADRATIC in cubic clothing:
//    klmn reports d1 = d2 = 0, cubicKLMN bails, and the kind-4 Bezout crescent rendered it
//    WRONG — LB drew only the interior diamond through the anchors. Such cubics are now
//    degree-reduced to true kind-1 quadratics.
//
// Concave shapes (glyphs, tiger) take the CDT partition and were never affected; the
// regression this guards is a convex cubic blob/petal/leaf, and any corner-control shape.
//
// The residual ~0.994 on fat rings is crescent-SEAM undercount: cubic crescents have no
// bisector tiling partition (kind-1 quads do). That is a known, separate limit.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 200;

// convex ring of n cubics with a controllable outward bulge (0 = straight lines)
function cubicRing(n, bulge) {
  const c = 100, r = 60;
  const P = (i) => { const a = (i / n) * 2 * Math.PI; return [c + r * Math.cos(a), c + r * Math.sin(a)]; };
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let i = 0; i < n; i++) {
    const A = P(i), B = P(i + 1);
    const bx = (B[1] - A[1]) * bulge, by = -(B[0] - A[0]) * bulge;
    const c1 = [A[0] + (B[0] - A[0]) / 3 + bx, A[1] + (B[1] - A[1]) / 3 + by];
    const c2 = [A[0] + 2 * (B[0] - A[0]) / 3 - bx, A[1] + 2 * (B[1] - A[1]) / 3 - by];
    d += `C ${c1[0].toFixed(3)} ${c1[1].toFixed(3)} ${c2[0].toFixed(3)} ${c2[1].toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d + 'Z';
}
function quadRing(n, bulge) {
  const c = 100, r = 60;
  const P = (i) => { const a = (i / n) * 2 * Math.PI; return [c + r * Math.cos(a), c + r * Math.sin(a)]; };
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let i = 0; i < n; i++) {
    const A = P(i), B = P(i + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bulge, my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bulge;
    d += `Q ${mx.toFixed(3)} ${my.toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d + 'Z';
}
const wrap = (d) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#3366cc" d="${d}"/></svg>`;
// A cubic with C3 = -P0+3P1-3P2+P3 == 0 is a QUADRATIC in cubic clothing. klmn reports
// d1 = d2 = 0, cubicKLMN bails, and the kind-4 Bezout crescent rendered it WRONG: LB drew
// only the interior diamond through the anchors (ink 0.595). It is now degree-reduced to a
// true kind-1 quadratic. Corner-style control points are exactly this case.
const SQUIRCLE = 'M 40 100 C 40 60 60 40 100 40 C 140 40 160 60 160 100 C 160 140 140 160 100 160 C 60 160 40 140 40 100 Z';
const CASES = {
  'squircle (degree-reducible)': wrap(SQUIRCLE),            // was 0.595
  'cubic ring  4 x bulge 0.55': wrap(cubicRing(4, 0.55)),   // was 1.203
  'cubic ring  8 x bulge 0.55': wrap(cubicRing(8, 0.55)),   // was 1.077
  'cubic ring  8 x bulge 0.30': wrap(cubicRing(8, 0.30)),   // was 1.050
  'cubic ring 16 x bulge 0.55': wrap(cubicRing(16, 0.55)),  // was 1.040
  'quad  ring  8 x bulge 0.55': wrap(quadRing(8, 0.55)),    // control: fast path, exact
};

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const CASES = ${JSON.stringify(CASES)}, N = ${N};
const r = createRenderer(gl, shaders);
const readAll = () => { const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const ink = (px) => { let n=0; for (let i=0;i<px.length;i+=4) if (px[i]<250||px[i+1]<250||px[i+2]<250) n++; return n; };
const out = [];
for (const [name, svg] of Object.entries(CASES)) {
  const b = createBundle(gl, await importSvg(svg));
  r.prepareBundle(b);
  await r.awaitLbReady(b);   // LB builds off-thread; wait so routed/ink reflect LB, not readiness
  const draw = () => { r.setViewport(N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); };
  r.setLoopBlinnFill('off'); draw(); const s = readAll();
  const c0 = r.debugStats.loopBlinnRouteCount;
  r.setLoopBlinnFill('on'); draw(); const l = readAll();
  out.push({ name, routed: r.debugStats.loopBlinnRouteCount - c0, inkS: ink(s), inkL: ink(l) });
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
for (const r of o) {
  const ratio = r.inkL / r.inkS;
  const ok = r.routed > 0 && ratio >= 0.985 && ratio <= 1.015;
  if (!ok) fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${r.name}  ink LB/Slug = ${ratio.toFixed(3)} (routed=${r.routed})`);
}
console.log(fail ? `\nLB-CUBIC-OVERFILL FAIL (${fail})` : '\nLB-CUBIC-OVERFILL PASS');
process.exit(fail ? 1 : 0);

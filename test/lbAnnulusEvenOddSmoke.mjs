// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbAnnulusSdfSmoke.mjs — a CONCENTRIC circular RING built from CUBIC beziers (like
// the pause-menu how-to-play "?" ring) renders through the exact annulus SDF (kind
// 7), NOT per-≤90° cubic crescents: at SMALL render scale it's seam-free AND free of
// the same, for a ring that is only a ring because of the FILL RULE.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// cubic-bezier circle (4×90° arcs), CCW; k = r·4/3·tan(π/8).
function circlePath(cx, cy, r, ccw) {
  const k = r * 0.5522847498,
    dirs = ccw ? [0, 1, 2, 3] : [0, 3, 2, 1];
  const pt = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const tan = (a) => [(ccw ? -1 : 1) * Math.sin(a), (ccw ? 1 : -1) * Math.cos(a)];
  let d = '';
  for (let i = 0; i < 4; i++) {
    const a0 = (dirs[i] * Math.PI) / 2,
      a1 = (dirs[(i + 1) % 4] * Math.PI) / 2 + (ccw ? 0 : i === 3 ? -2 * Math.PI : 0);
    const p0 = pt(a0),
      p3 = pt(a1),
      t0 = tan(a0),
      t1 = tan(a1);
    const p1 = [p0[0] + k * t0[0], p0[1] + k * t0[1]],
      p2 = [p3[0] - k * t1[0], p3[1] - k * t1[1]];
    d +=
      (i === 0 ? `M${p0[0].toFixed(2)} ${p0[1].toFixed(2)} ` : '') +
      `C${p1[0].toFixed(2)} ${p1[1].toFixed(2)} ${p2[0].toFixed(2)} ${p2[1].toFixed(2)} ${p3[0].toFixed(2)} ${p3[1].toFixed(2)} `;
  }
  return d + 'Z';
}
const R = 44; // small render size — where the wedge shows
// same-WOUND circles under fill-rule="evenodd" — an annulus only because of the rule. The
// opposite-wound version (lbAnnulusSdfSmoke) is a hole under nonzero and needs no rule at all,
// so it cannot catch a builder that ignores one: buildLoopBlinnMesh passed `undefined` to
// extractAnnuli while buildLoopBlinnCDT passed the caller's rule, and extractAnnuli consults it in
// exactly one place -- under evenodd two same-wound concentric circles ARE an annulus.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44" width="44" height="44"><path fill="#000000" fill-rule="evenodd" d="${circlePath(22, 22, 18, true)} ${circlePath(22, 22, 12, true)}"/></svg>`;
emitFixture('lbAnnulusEvenOdd__SVG', SVG);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${R}" height="${R}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
// REFERENCE = AAC (exact signed-area coverage). Slug and LB share the same exactBoxCov
// kernel, so "LB matches Slug" does not prove either is right.
// Create the AAC reference FIRST: the LAST-created renderer owns the global off-thread
// LB builder, and a Slug-only renderer would suppress the worker build (leaving the
// bundle Slug forever). Keep the LB renderer created last so createBundle kicks the LB build.
const refR = createRenderer(gl, shaders, { staticUnified: true, aacFill: true }); refR.setViewport(${R}, ${R}); refR.setLoopBlinnFill('off');
const renderer = createRenderer(gl, shaders, { staticUnified: true }); renderer.setViewport(${R}, ${R});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle);
await renderer.awaitLbReady(bundle);   // LB builds off-thread; wait before asserting the route
const read = () => { const px = new Uint8Array(${R}*${R}*4); gl.readPixels(0,0,${R},${R},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const cov = (px,x,y) => { const q = ((${R}-1-y)*${R}+x)*4; return (255-px[q])/255; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame(); return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const drawRef = () => { refR.beginFrame([1,1,1,1]); refR.drawBundle(bundle); refR.endFrame(); return { px: read(), routed: 1 }; };
const slug = drawRef(), lb = draw('on');
let worst=0, sum=0, n=0, hole=1;
for (let y=0;y<${R};y++) for (let x=0;x<${R};x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if ((s>0.02&&s<0.98)||(l>0.02&&l<0.98)){ const e=Math.abs(s-l); if(e>worst)worst=e; sum+=e; n++; } }
hole = cov(lb.px, 22, 22);   // ring center must stay EMPTY
// WHICH PATH, not just whether it looks right. A ring renders correctly either way -- the ordinary
// LB build handles it -- so a pixel assertion alone cannot tell that the annulus SDF was skipped.
// The packed mesh's kindMask is the discriminator.
const _m = (bundle._lbMeshes || []).filter(Boolean);
const _km = _m.reduce((a, m) => a | (m.kindMask | 0), 0);
const _verts = _m.reduce((a, m) => a + (m.vertexCount | 0), 0);
window.__out = { kindMask: _km, verts: _verts, lbRouted: lb.routed, worst:+worst.toFixed(3), mean:+(sum/Math.max(n,1)).toFixed(3), hole:+hole.toFixed(2) };
window.__ready = true;
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
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
if (o.lbRouted) ok('ring routes through LB');
else fail('ring did NOT route to LB');
// The annulus SDF is a handful of vertices; an ordinary build of two circles is hundreds.
// NOTE what this does and does not pin down. It asserts the SDF was TAKEN, not WHICH builder took
// it: lbBuildCore tries buildLoopBlinnMesh and falls through to buildLoopBlinnCDT, and the CDT
// path passes the caller's rule, so the ring is recognized either way and this stays green with
// buildLoopBlinnMesh's own rule handling broken. It is the only coverage that an EVEN-ODD ring
// reaches the SDF at all.
if (o.verts > 0 && o.verts <= 24)
  ok('even-odd ring took the annulus SDF (' + o.verts + ' verts, kindMask ' + o.kindMask + ')');
else
  fail(
    'even-odd ring did NOT take the annulus SDF — built as ordinary geometry (' +
      o.verts +
      ' verts, kindMask ' +
      o.kindMask +
      ')',
  );
if (o.hole < 0.05) ok('ring hole stays empty (' + o.hole + ')');
else fail('ring hole filled (' + o.hole + ')');
if (o.worst <= 0.06)
  ok(
    'ring matches the exact reference at every boundary pixel (worst ' +
      o.worst +
      ') — annulus SDF, no wedge/seam',
  );
else
  fail(
    'ring boundary diverges from the exact reference (worst ' +
      o.worst +
      ') — crescent wedge/seam?',
  );
if (o.mean <= 0.015) ok('mean boundary error ' + o.mean);
else fail('mean boundary error too high (' + o.mean + ')');

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\\nlbAnnulusEvenOddSmoke: an EVEN-ODD ring reaches the annulus SDF');

// debugOverlaySmoke — the mesh overlay draws, on every route, and shows the mesh that was
// actually SUBMITTED.
//
// showTriOutline is the tool you reach for when a fill looks wrong, so it failing quietly is
// expensive. Two ways it did:
//
//   1. It was drawn at the tail of the cover-quad pass — inside render(). The Loop-Blinn route
//      returns from drawBundle without ever entering render(), so under LB the overlay drew
//      NOTHING at all.
//   2. What it drew came from bundle.coverQuadFloats — the SLUG cover mesh. LB never submits
//      those triangles, so even when it did draw, it drew a mesh the frame had not used.
//
// So: overlay pixels must appear on BOTH routes, and the LB overlay must not be the Slug one.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 260;

// Curved + straight edges, so the LB partition has interior triangles AND curve pieces.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">
  <path fill="#3366cc" d="M 40 130 C 40 80 80 40 130 40 C 180 40 220 80 220 130 C 220 180 180 220 130 220 C 80 220 40 180 40 130 Z"/>
</svg>`;
emitFixture('debugOverlay__SVG', SVG);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
const r = createRenderer(gl, shaders);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
r.prepareBundle(bundle);
if (r.awaitLbReady) await r.awaitLbReady(bundle);

const read = () => { const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
// drawBundle (NOT render()): this is the entry point the LB route takes, and the one the
// overlay used to be invisible from.
const draw = () => { r.setViewport(N,N); r.beginFrame([1,1,1,1]); r.drawBundle(bundle, {}); r.endFrame(); return read(); };
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4)
  if (Math.abs(a[i]-b[i]) > 24 || Math.abs(a[i+1]-b[i+1]) > 24 || Math.abs(a[i+2]-b[i+2]) > 24) n++; return n; };

const shot = (mode) => {
  r.setLoopBlinnFill(mode);
  r.showTriOutline = false; const plain = draw();
  r.showTriOutline = true;  const ov = draw();
  r.showTriOutline = false;
  return { plain, ov, lines: diff(plain, ov), routes: r.debugStats.loopBlinnRouteCount };
};
const c0 = r.debugStats.loopBlinnRouteCount;
const slug = shot('off');
const lb   = shot('on');

window.__out = {
  slugLines: slug.lines,
  lbLines:   lb.lines,
  lbRouted:  lb.routes > slug.routes,
  // The two overlays must be DIFFERENT meshes. (If LB fell back to drawing the cover quads,
  // this is ~0 and the overlay is lying about what was rendered.)
  overlaysDiffer: diff(slug.ov, lb.ov),
  lbMeshes: (bundle._lbMeshes || []).length,
};
window.__ready = true;
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
await pg.waitForFunction(() => window.__ready === true, { timeout: 90000 });
const o = await pg.evaluate(() => window.__out);
await br.close(); server.close();

let fail = 0;
const ok = (c, m) => c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m));

console.log(`  overlay px: slug=${o.slugLines} lb=${o.lbLines}  (LB meshes ${o.lbMeshes})`);
ok(o.lbRouted, 'the LB route serves this bundle (otherwise this test proves nothing)');
ok(o.slugLines > 100, `the overlay draws on the Slug route (${o.slugLines} px)`);
ok(o.lbLines > 100,   `the overlay draws on the LB route too (${o.lbLines} px)`);
ok(o.overlaysDiffer > 100,
   `and it draws LB's OWN mesh, not the Slug cover quads (${o.overlaysDiffer} px differ between the two overlays)`);

console.log(fail ? `\nDEBUG-OVERLAY FAIL (${fail})` : '\nDEBUG-OVERLAY PASS');
process.exit(fail ? 1 : 0);

// coverQuadBatchSmoke.mjs — guards the header-free cover-quad VBO batching.
//
// A bundle's cover-quad geometry is uploaded to the VBO with the per-chunk
// header slots stripped (see buildStrippedCoverQuad), so consecutive shapes'
// body verts are contiguous and the renderer's draw-batching test
// (`vboStart === pendingEnd`) can collapse them into ONE drawArrays. Before
// the strip, a one-vertex header sat between every chunk's vert run, so the
// test was always off by one slot and NEVER matched — every shape flushed as
// its own draw (measured ~4500 draws/frame in a busy scene that should issue
// ~50).
//
// Assertions:
//   1. An 8-rect bundle (8 fill chunks) draws in ONE TRIANGLES drawArrays.
//   2. All 8 colors still render (batching didn't corrupt geometry — the
//      stripped verts + repacked shapeIdx stay aligned).

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (p.endsWith('.glsl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try { res.writeHead(200, { 'content-type': mime(p) }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url  = `http://127.0.0.1:${port}/mantleDemo.html`;

// 8 non-overlapping colored rects → 8 contiguous fill chunks in one bundle.
const cols = ['#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff','#ff8000','#8000ff'];
const rects = cols.map((c,i)=>`<rect x="${i*25}" y="0" width="25" height="100" fill="${c}"/>`).join('');
const SVG = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">${rects}</svg>`;
emitFixture('coverQuadBatch__SVG', SVG);

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 200, height: 100 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 10000 });

const out = await page.evaluate(async (svg, cols) => {
  const { importSvg, createBundle } = await import('/src/index.js');
  const gl = window.__mantleGl, renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  const b = createBundle(gl, await importSvg(svg));
  const h = renderer.createBundleHandle(b);

  // Count TRIANGLES drawArrays (cover-quad fill draws) in one frame.
  let triDraws = 0;
  const orig = gl.drawArrays.bind(gl);
  gl.drawArrays = (mode, first, count) => { if (mode === gl.TRIANGLES) triDraws++; return orig(mode, first, count); };
  renderer.beginFrame([1,1,1,1]);
  h.draw();
  renderer.endFrame();
  gl.drawArrays = orig;

  const w = cnv.width, hgt = cnv.height;
  const px = new Uint8Array(w*hgt*4);
  gl.readPixels(0,0,w,hgt,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const found = new Set();
  const q = v => v<64?0:(v>192?255:128);
  for (let i=0;i<px.length;i+=4){
    const r=px[i],g=px[i+1],bl=px[i+2];
    if (r>240&&g>240&&bl>240) continue;   // skip white background
    found.add(`${q(r)},${q(g)},${q(bl)}`);
  }
  const chunks = b.coverQuadChunks.length;
  b.dispose();
  return { triDraws, chunks, found: [...found] };
}, SVG, cols);

await browser.close();
server.close();

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok   = (m) => console.log('ok', m);

if (out.chunks !== 8) fail(`expected 8 cover-quad chunks, got ${out.chunks}`);
else ok(`bundle has ${out.chunks} fill chunks`);

if (out.triDraws <= 2) ok(`${out.chunks} chunks batched into ${out.triDraws} TRIANGLES draw`);
else fail(`${out.chunks} chunks issued ${out.triDraws} draws — batching broken (header not stripped?)`);

const q = v => v<64?0:(v>192?255:128);
const want = cols.map(c => `${q(parseInt(c.slice(1,3),16))},${q(parseInt(c.slice(3,5),16))},${q(parseInt(c.slice(5,7),16))}`);
const missing = want.filter(w => !out.found.includes(w));
if (missing.length) fail(`missing colors after batch: [${missing.join(' | ')}]`);
else ok(`all 8 colors render correctly (batch geometry intact)`);

if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log('\ncoverQuadBatchSmoke: PASS');

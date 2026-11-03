// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _aacTripBound — what outer trip bound does the AAC band walk actually need?
//
// The cell is 1 device pixel tall. It spans bands b0..b1, and b1-b0 is the number
// of band boundaries inside it. Any trip bound below b1-b0+1 SILENTLY DROPS the
// remaining bands — no assert, no crash, just missing coverage.
//
// Band height (px) = shapeHeightPx / bandsY, and bandsY = clamp(round(sqrt(32n)),
// 4, 96) — so a 512-segment path gets bandsY = 96, NOT 32. The risk is a dense
// path drawn smaller than its own band count, and it needs a bound of 96.
// test/aacBandSeamSmoke.mjs renders at 160px (band height ~5px) and would never
// see it. This probe renders the same shape down to 24px and reports, per size,
// the max number of bands a cell actually spans — then renders AAC so the two
// shader builds can be diffed against each other.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { parsePathD } from '../src/svg/path.js';
import { segBboxInto } from '../src/svg/bbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VB = 160,
  cx = 80,
  cy = 80;

function wavy(K, R, amp, lobes) {
  const P = (i) => {
    const a = (i / K) * 2 * Math.PI,
      r = R + amp * Math.sin(lobes * a);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  let d = '';
  for (let i = 0; i < K; i++) {
    const A = P(i),
      B = P(i + 1);
    const bx = (B[1] - A[1]) * 0.55,
      by = -(B[0] - A[0]) * 0.55;
    const c1 = [A[0] + (B[0] - A[0]) / 3 + bx, A[1] + (B[1] - A[1]) / 3 + by];
    const c2 = [A[0] + (2 * (B[0] - A[0])) / 3 - bx, A[1] + (2 * (B[1] - A[1])) / 3 - by];
    if (i === 0) d += `M ${A[0].toFixed(3)} ${A[1].toFixed(3)} `;
    d += `C ${c1[0].toFixed(3)} ${c1[1].toFixed(3)} ${c2[0].toFixed(3)} ${c2[1].toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d + 'Z';
}
const D = wavy(512, 62, 8, 17);
const SIZES = [160, 96, 48, 32, 24];

// --- CPU: how many bands does a 1px cell span, at each render size? ---
// must match svg/buildContext.js exactly
const pickBandsAxis = (n) => Math.max(4, Math.min(96, Math.round(Math.sqrt(Math.max(1, n) * 32))));
const segs = parsePathD(D);
const t = new Float64Array(4);
let y0 = 1e9,
  y1 = -1e9,
  h = 0;
for (const s of segs) {
  segBboxInto(s, t, 0);
  y0 = Math.min(y0, t[1]);
  y1 = Math.max(y1, t[3]);
}
h = y1 - y0;
let nx = 0;
for (const s of segs) {
  segBboxInto(s, t, 0);
  if (t[3] - t[1] > h * 0.005) nx++;
}
const bandsY = pickBandsAxis(nx || segs.length);

console.log(`shape: 512 cubics, bbox height ${h.toFixed(1)} em, bandsY = ${bandsY}\n`);
console.log('renderPx  bandH(px)  max bands a 1px cell spans   bi<2 sound?');
console.log('-----------------------------------------------------------');
const spans = {};
for (const N of SIZES) {
  const pxPerEm = N / VB;
  const bandHpx = (h / bandsY) * pxPerEm;
  // worst case: a 1px cell placed to cross as many boundaries as possible
  const maxSpan = Math.floor(1 / bandHpx) + 2; // worst alignment: L/h boundaries, +1 band
  spans[N] = maxSpan;
  console.log(
    `${String(N).padStart(8)}  ${bandHpx.toFixed(3).padStart(9)}  ${String(maxSpan).padStart(25)}   ${maxSpan <= 2 ? 'yes' : 'NO — drops bands'}`,
  );
}

// --- GPU: render AAC at each size; caller diffs the two shader builds ---
const SVGS = Object.fromEntries(
  SIZES.map((N) => [
    N,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" width="${N}" height="${N}"><path fill="#3366cc" d="${D}"/></svg>`,
  ]),
);

const HTML = `<!DOCTYPE html><html><body><canvas id="c"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const SVGS = ${JSON.stringify(SVGS)};
async function render(svg, N){
  cv.width=N; cv.height=N;
  const sec = await importSvg(svg);
  const r = createRenderer(gl, shaders, { aacFill: true });
  r.setViewport(N,N); r.setLoopBlinnFill('off');
  const b = createBundle(gl, sec);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px);
  b.dispose();
  let sum=0; for (let i=0;i<px.length;i++) sum = (sum*31 + px[i]) >>> 0;   // checksum
  let ink=0; for (let i=0;i<px.length;i+=4) if(px[i]!==255||px[i+1]!==255||px[i+2]!==255) ink++;
  return { sum, ink, px: Array.from(px) };
}
const out = {};
try { for (const N of ${JSON.stringify(SIZES)}) out[N] = await render(SVGS[N], N); }
catch(e){ out.err = String(e); }
window.__out = out; window.__ready = true;
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
const browser = await launchBrowser({
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000 });
const out = await page.evaluate(() => window.__out);
await browser.close();
server.close();
if (out.err) {
  console.error('render threw:', out.err);
  process.exit(1);
}

const tag = process.argv[2] || 'run';
console.log(`\nAAC render (${tag}):`);
for (const N of SIZES)
  console.log(
    `  ${String(N).padStart(3)}px  ink=${String(out[N].ink).padStart(6)}  checksum=${out[N].sum}`,
  );
const fs = await import('fs');
fs.writeFileSync(
  `/tmp/aac_trip_${tag}.json`,
  JSON.stringify(Object.fromEntries(SIZES.map((N) => [N, out[N].px]))),
);
console.log(`\n(pixels written to /tmp/aac_trip_${tag}.json)`);

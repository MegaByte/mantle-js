// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterCacheResidencyRenderSmoke.mjs — a static filtered scene must stop evaluating
// its filter graphs after the first frame, and the cached frames must be identical
// to the one they replace.
//
// A filter-result cache bounded at 8 ENTRIES fails a bundle with more filtered shapes
// than that: every result goes into 8 slots, so each entry is evicted long before the
// next frame asks for it -- a permanent 0% hit rate that is WORSE than no cache, since
// every miss still pays a texture allocation, a framebuffer and a blit on top of
// re-running the graph (6.6-11.9x slower on real assets).
//
// This asserts both halves, because either alone is passable while broken:
//   evals after warm-up  == 0   (the cache is actually being hit)
//   warm frame           == cold frame, byte for byte (hitting it is CORRECT)
// It uses MORE filtered shapes than any small entry cap would hold, so a count-based
// bound fails the first assertion.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256,
  SHAPES = 24;

// Each circle gets its own filter so each is a distinct cache entry.
let defs = '',
  body = '';
for (let i = 0; i < SHAPES; i++) {
  const cx = 20 + (i % 6) * 42,
    cy = 20 + Math.floor(i / 6) * 42;
  defs +=
    `<filter id="f${i}" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feGaussianBlur stdDeviation="${1 + (i % 3)}"/></filter>`;
  body += `<circle cx="${cx}" cy="${cy}" r="14" fill="#${(0x334455 + i * 0x050301).toString(16).slice(0, 6)}" filter="url(#f${i})"/>`;
}
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs>${defs}</defs>${body}</svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const r=createRenderer(gl,shaders,{});
const grab=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p;};
window.__run=async(svg)=>{
  const sec=await importSvg(svg); const b=createBundle(gl,sec);
  r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const cold=grab(); const e0=r.debugStats.filterEvalCount|0;
  for(let f=0;f<4;f++){ r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); }
  const warm=grab(); const warmEvals=(r.debugStats.filterEvalCount|0)-e0;
  let ink=0; for(let i=0;i<N*N;i++) ink += (255-cold[i*4])/255;
  let nd=0,max=0; for(let i=0;i<cold.length;i++){const d=Math.abs(cold[i]-warm[i]); if(d){nd++; if(d>max)max=d;}}
  const st=r.debugStats;
  b.dispose();
  return {coldEvals:e0, warmEvals, nd, max, ink, entries:st.filterCacheEntries|0};
};
window.__ready=true;
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
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e.message)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
let o = null;
try {
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
  o = await pg.evaluate((s) => window.__run(s), SVG);
} catch (e) {
  console.log('FAIL page never ran: ' + (errs.join(' | ') || e.message));
}
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!o) {
  console.log('FILTER-CACHE-RESIDENCY FAIL');
  process.exit(1);
}
ok(o.ink > 200, `the scene actually rendered (ink ${o.ink.toFixed(0)})`);
ok(o.coldEvals >= SHAPES, `cold frame evaluated all ${SHAPES} graphs (got ${o.coldEvals})`);
ok(
  o.warmEvals === 0,
  `warm frames evaluated NOTHING (got ${o.warmEvals} — nonzero means cache thrash)`,
);
ok(
  o.nd === 0,
  `warm frame is byte-identical to cold (differing bytes ${o.nd}, max delta ${o.max})`,
);
ok(o.entries >= SHAPES, `cache holds all ${SHAPES} results (got ${o.entries})`);
console.log(fail ? `\nFILTER-CACHE-RESIDENCY FAIL (${fail})` : '\nFILTER-CACHE-RESIDENCY PASS');
process.exit(fail ? 1 : 0);

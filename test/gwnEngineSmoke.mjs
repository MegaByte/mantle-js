// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnEngineSmoke — the GWN+SDF fill engine renders, and matches Slug.
//
// The engine is TWO decisions, and making only one of them fails silently:
//
//   1. the #defines pick the kernel  — MANTLE_GWN alone is the WINDING-only tier (what the
//      hard engines ride); the AA'd path needs MANTLE_GWN_SDF as well;
//   2. the IMPORTER bakes the run tree — importSvg(svg, { gwnTree: true }).
//
// Miss (2) and the kernel walks a tree header nothing wrote: it renders nothing, in
// silence, on a blank canvas. This pins the working config against Slug, pins the empty
// failure so it cannot be mistaken for a rendering bug, and pins the warning that names
// the cause.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 300;

// Curve-heavy: cubics, quadratics and a hole, so the run tree is exercised on more than lines.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">
  <path fill="#3366cc" d="M 60 150 C 60 90 105 45 150 45 C 195 45 240 90 240 150 C 240 210 195 255 150 255 C 105 255 60 210 60 150 Z
                           M 150 90 C 116 90 100 118 100 150 C 100 182 116 210 150 210 C 184 210 200 182 200 150 C 200 118 184 90 150 90 Z"/>
  <path fill="#cc3333" d="M 20 270 Q 80 200 140 270 T 280 270 L 280 290 L 20 290 Z"/>
</svg>`;
emitFixture('gwnEngine__SVG', SVG);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
const SVG = ${JSON.stringify(SVG)};
const read = () => { const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const ink  = (px) => { let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i+1] < 250 || px[i+2] < 250) n++; return n; };

async function paint(rOpts, impOpts) {
  const r = createRenderer(gl, shaders, rOpts || {});
  r.setLoopBlinnFill('off');                       // isolate the COVERAGE kernel
  const b = createBundle(gl, await importSvg(SVG, impOpts || {}));
  r.prepareBundle(b);
  r.setViewport(N, N); r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame();
  return read();
}
const GWN = { fillDefines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'] };
const slug    = await paint(null, null);
const gwn     = await paint(GWN, { gwnTree: true });
const noTree  = await paint(GWN, null);            // the trap: kernel without its tree
const windOnly= await paint({ fillDefines: ['MANTLE_GWN'] }, { gwnTree: true });  // no _SDF ⇒ hard, not AA'd

const cmp = (a, b) => { let n = 0, max = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i]-b[i]); if (d > 16) n++; if (d > max) max = d; } return { n, max }; };
// AA'd vs hard: a pixel is INTERMEDIATE when it is neither the white ground nor one of the two
// solid fills — i.e. a blend. A hard kernel produces (almost) none; an AA'd one outlines every
// edge with them. (Counting "not white" would count the whole interior and compare nothing.)
const SOLID = [[255,255,255],[51,102,204],[204,51,51]];
const inter = (px) => { let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    let solid = false;
    for (const c of SOLID) if (Math.abs(px[i]-c[0]) <= 3 && Math.abs(px[i+1]-c[1]) <= 3 && Math.abs(px[i+2]-c[2]) <= 3) { solid = true; break; }
    if (!solid) n++;
  }
  return n; };

// Are the Slug/GWN differences on EDGES (both engines antialias, differently) or in the body
// (one of them is filling the wrong region)? Only the second is a bug.
const edgeish = (px, i) => {   // is any 8-neighbor a different color? then this is an edge px
  const x = (i/4) % N, y = ((i/4) / N) | 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x+dx, ny = y+dy; if (nx<0||ny<0||nx>=N||ny>=N) continue;
    const o = (ny*N+nx)*4;
    if (Math.abs(px[o]-px[i]) > 24 || Math.abs(px[o+1]-px[i+1]) > 24 || Math.abs(px[o+2]-px[i+2]) > 24) return true;
  }
  return false;
};
let bodyDiff = 0;
for (let i = 0; i < slug.length; i += 4) {
  const d = Math.max(Math.abs(slug[i]-gwn[i]), Math.abs(slug[i+1]-gwn[i+1]), Math.abs(slug[i+2]-gwn[i+2]));
  if (d > 16 && !edgeish(slug, i) && !edgeish(gwn, i)) bodyDiff++;
}
window.__out = {
  inkSlug: ink(slug), inkGwn: ink(gwn), inkNoTree: ink(noTree),
  gwnVsSlug: cmp(slug, gwn), bodyDiff,
  aaGwn: inter(gwn), aaSlug: inter(slug), aaWindingOnly: inter(windOnly),
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
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
const warns = [];
pg.on('console', (m) => warns.push(m.type() + ': ' + m.text()));
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

console.log(`  ink: slug=${o.inkSlug} gwn=${o.inkGwn} gwn-without-tree=${o.inkNoTree}`);
ok(o.inkGwn > 0, `GWN+SDF renders (ink=${o.inkGwn})`);
// The whole point of the engine: same picture as Slug, computed without bands.
ok(
  o.bodyDiff === 0,
  `fills the same REGION as Slug (${o.bodyDiff} non-edge px differ; ${o.gwnVsSlug.n} incl. AA edges)`,
);
ok(
  Math.abs(o.aaGwn - o.aaSlug) / Math.max(1, o.aaSlug) < 0.35,
  `antialiases like Slug (${o.aaGwn} intermediate px vs Slug's ${o.aaSlug})`,
);
// MANTLE_GWN without MANTLE_GWN_SDF is the winding-only tier — a HARD fill. If this ever
// starts producing AA, the two tiers have been conflated and the demo's engine list is lying.
ok(
  o.aaWindingOnly < o.aaSlug * 0.35,
  `MANTLE_GWN alone stays the winding-only (hard) tier (${o.aaWindingOnly} intermediate px)`,
);
// The trap, pinned: no tree ⇒ nothing renders. Silent blank output must at least be LOUD.
ok(o.inkNoTree === 0, `a GWN kernel without its run tree renders EMPTY (ink=${o.inkNoTree})`);
ok(
  warns.some((w) => /gwnTree/.test(w)),
  'and the renderer warns, naming importSvg({gwnTree:true}) as the remedy',
);

console.log(fail ? `\nGWN-ENGINE FAIL (${fail})` : '\nGWN-ENGINE PASS');
process.exit(fail ? 1 : 0);

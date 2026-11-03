// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchK4BoxCost — what does a CPatch PRE-SPLIT cost per fragment?
//
// SPLIT=1 is the only mode: the same shader in every arm, different bundles (setCPatchPreSplit 2
// against 1). The Bezout cubic has no arc box -- its coefficients fill texels 0-3 and texel 4 is the
// cross-chord strip (see cpatchPack.CP_BLOCK_TEXELS) -- so a define A/B on MANTLE_CPATCH_NO_K4BOX
// would time two identical programs, and the probe refuses to run one.
//
// Built on _lbCubicRouteDrawSpeed, which carries the traps this kind of measurement has to
// survive, and follows _balanceBench in giving each arm its own canvas, gl and renderer — the
// unified-fill VBO holds one stream, and sharing it between arms prices upload as render.
//
//   * A/A CONTROL, the same arm through both slots. Below its spread nothing is a result.
//   * ONE LONG RUN of BIG paints, with the raw samples and their distinct-value count printed,
//     because performance.now() is clamped to 100us headless and two arms then tie exactly.
//   * INK READ BACK AFTER the timed run, per arm, so a skipped repaint cannot tie at the floor.
//   * ENGINE LEDGER per arm: an arm that quietly drew Slug is not measuring CPatch.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = process.env.ASSET || '../MantleSamples/Assets/Mantle/tiger.svg';
const SVG = readFileSync(path.isAbsolute(ASSET) ? ASSET : path.join(ROOT, ASSET), 'utf8');
const SIZE = Number(process.env.SIZE || 768);
const BIG = Number(process.env.BIG || 300);
const PASSES = Number(process.env.PASSES || 3);
// Only the pre-split A/B runs: a NO_K4BOX define arm compiles to the default program.
if (!Number(process.env.SPLIT || 0)) {
  console.error(
    '_cpatchK4BoxCost: only the SPLIT=1 pre-split A/B runs; a NO_K4BOX define arm would time the default program twice',
  );
  process.exit(2);
}
const PAGE = `<!DOCTYPE html><body><div id=root></div><script type=module>
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
globalThis.Worker = undefined;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { setCPatchPreSplit } from '/src/renderer/cpatchBuild.js';
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const SPLIT = ${Number(process.env.SPLIT || 0)};
const svgText = ${JSON.stringify(SVG)};
const SIZE = ${SIZE};
// ARM NAMES: box = pre-split 2; nobox = pre-split 1; aa = a second copy of the box arm, the control.
// SPLIT mode is a PRE-SPLIT A/B: same shader in every arm, different bundles.
const SPECS = { box: 2, nobox: 1, aa: 2 };
const arms = {};
for (const [name, defs] of Object.entries(SPECS)) {
  const c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE;
  document.getElementById('root').appendChild(c);
  const gl = c.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
  const r = createRenderer(gl, shaders, { cpatchFill: true,
                                          fillDefines: ['MANTLE_CPATCH', ...(SPLIT ? [] : defs)],
                                          precompileFillsBudgetMs: 5000 });
  await r.ready; r.setViewport(SIZE, SIZE); r.setLoopBlinnFill('on');
  if (SPLIT) setCPatchPreSplit(defs);
  const b = createBundle(gl, await importSvg(svgText));
  r.prepareBundle(b); await r.awaitLbReady(b);
  let draws = 0, verts = 0; const od = gl.drawArrays.bind(gl);
  gl.drawArrays = (m,f,n) => { draws++; verts += n; return od(m,f,n); };
  r.beginFrame([1,1,1,1]); r.drawBundle(b, { worldMatrix:[1,0,0,0,1,0,0,0,1] }); r.endFrame();
  gl.drawArrays = od;
  const st = r.debugStats || {};
  if (SPLIT) setCPatchPreSplit(1);
  arms[name] = { gl, r, b, draws, verts, ext: gl.getExtension('EXT_disjoint_timer_query_webgl2'),
                 engines: st.engines ? JSON.stringify(st.engines.draws || st.engines) : null,
                 cpTexels: (b._cpatchTexels || b.cpatchTexels || 0) };
}
// N INSTANCES A FRAME. One tiger at 768px is 0.01 ms, which is under the clock's own grid
// (performance.now() is clamped to 100us headless, so a 300-paint sample quantizes to 1/300 ms and
// every arm lands on the same three values). The fragment cost is what is being measured, so the
// way to raise it is more covered pixels, not more samples.
const N = ${Number(process.env.NDRAW || 16)};
const paint = (a) => { a.r.beginFrame([1,1,1,1]);
  for (let i = 0; i < N; i++) a.r.drawBundle(a.b, { worldMatrix:[1,0,0,0,1,0, (i%4)*3, ((i/4)|0)*3, 1] });
  a.r.endFrame(); };
const names = ['box','nobox','aa'];
for (const n of names) { for (let w=0;w<40;w++) paint(arms[n]); arms[n].gl.finish(); }
const all = { box: [], nobox: [], aa: [] };
// INTERLEAVED BY PASS, not blocked end to end: this machine's GPU drifts within a run as well as
// between them, so each arm has to be sampled across the whole window.
for (let pass = 0; pass < ${PASSES}; pass++) for (const n of names) {
  const a = arms[n];
  for (let w=0;w<20;w++) paint(a); a.gl.finish();
  for (let f=0; f<4; f++) { const t0 = performance.now();
    for (let k=0;k<${BIG};k++) paint(a); a.gl.finish();
    all[n].push((performance.now()-t0)/${BIG}); }
}
const ink = {};
for (const n of names) { const a = arms[n];
  const px = new Uint8Array(SIZE*SIZE*4); a.gl.readPixels(0,0,SIZE,SIZE,a.gl.RGBA,a.gl.UNSIGNED_BYTE,px);
  // NOT alpha alone: the clear is opaque white, so every pixel passes and the check is vacuous --
  // which is how the first run reported ink = exactly SIZE*SIZE for all three arms.
  let c = 0; for (let i=0;i<px.length;i+=4) if (px[i+3] > 8 && !(px[i]>247&&px[i+1]>247&&px[i+2]>247)) c++;
  ink[n] = c; }
const med = (x) => x.slice().sort((p,q)=>p-q)[x.length>>1];
window.__out = { med: Object.fromEntries(names.map(n=>[n, med(all[n])])),
                 raw: Object.fromEntries(names.map(n=>[n, all[n].map(v=>+v.toFixed(5))])),
                 distinct: Object.fromEntries(names.map(n=>[n, new Set(all[n].map(v=>+v.toFixed(5))).size])),
                 ink, draws: Object.fromEntries(names.map(n=>[n, arms[n].draws])),
                 verts: Object.fromEntries(names.map(n=>[n, arms[n].verts])),
                 engines: Object.fromEntries(names.map(n=>[n, arms[n].engines])) };
</script>`;
const server = http.createServer((req, res) => {
  const _p = req.url === '/' ? null : req.url.split('?')[0];
  if (!_p) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(PAGE);
  }
  try {
    res.writeHead(200, {
      'Content-Type': _p.endsWith('.glsl') ? 'text/plain' : 'application/javascript',
    });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(_p))));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const args = ['--no-sandbox'];
if (process.env.GPU === '1') args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
const br = await launchBrowser({ headless: 'new', args, protocolTimeout: 900000 });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
pg.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text());
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 120000 });
await pg.waitForFunction('window.__out', { timeout: 900000 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
console.log(
  `\n  ${path.basename(ASSET)} at ${SIZE}px, ${BIG} paints a sample, ${PASSES} passes, GPU=${process.env.GPU || '0'}\n`,
);
for (const n of ['box', 'nobox', 'aa'])
  console.log(
    `    ${n.padEnd(6)} median ${o.med[n].toFixed(5)} ms   draws ${String(o.draws[n]).padStart(5)}  verts ${String(o.verts[n]).padStart(7)}  ink ${o.ink[n]}  distinct ${o.distinct[n]}/${o.raw[n].length}`,
  );
console.log(
  `\n    box / nobox   ${(o.med.box / o.med.nobox).toFixed(4)}x   <- ${process.env.SPLIT ? "the pre-split's fragment cost (split 2 over split 1)" : "the fifth texel's fragment cost"}`,
);
console.log(
  `    aa  / box     ${(o.med.aa / o.med.box).toFixed(4)}x   <- the A/A floor; nothing below this is a result`,
);
console.log('\n    engines: ' + JSON.stringify(o.engines));
for (const n of ['box', 'nobox', 'aa']) console.log(`    raw ${n}: ${o.raw[n].join(' ')}`);

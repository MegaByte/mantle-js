// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnEngineSmoke — the GWN+SDF fill engine on importSvg({gwnTree:true}) bundles:
//   gwnEngine       the engine renders (its defines and its tree both chosen) and matches Slug
//   gwnCurveRange   a shape's curve range ends at its curves, not at the GWN run tree after them
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import path from 'path';
import { fileURLToPath } from 'url';
import { emitFixture } from './_fixtures.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// gwnEngine — the GWN+SDF fill engine renders, and matches Slug.
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
async function gwnEngine(host) {
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

  const br = host.browser;
  const pg = await br.newPage();
  const warns = [];
  pg.on('console', (m) => warns.push(m.type() + ': ' + m.text()));
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(host.page(HTML), { waitUntil: 'load', timeout: 90000 });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });
  const o = await pg.evaluate(() => window.__out);
  await pg.close();

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
  return fail;
}

// gwnCurveRange — a shape's curve range must END at its curves, not at the GWN run tree.
//
// The tree's PIECE RECORDS are appended to the same curve buffer, right after each shape's curves.
// A range inferred as "up to the next shape's begin, else the end of the buffer" would, with
// importSvg({gwnTree:true}), swallow the tree as well: one tiger claw's [4,76) of real curves
// would become [4,432).
//
// Everything that reads a shape's geometry BY RANGE would then read the tree as if it were curves.
// The Loop-Blinn builder does, and on that garbage it does not come back — so prepareBundle(),
// which builds LB meshes synchronously on the main thread, would never return: a GWN render
// freezes rather than fails.
//
// Two assertions, because either alone would be easy to satisfy the wrong way: the RANGE must not
// change when a tree is requested, and prepareBundle must actually RETURN.
async function gwnCurveRange(host) {
  // A real tiger claw, lifted from examples/tiger.svg — near-degenerate cubics, which is what makes
  // the LB builder choke on the tree records rather than merely producing nonsense.
  const D =
    'm-122.3,84.285s0.1,1.894-0.73,1.875c-0.82-0.019-17.27-48.094-37.8-45.851,0,0,17.78-7.353,38.53,43.976z';
  const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-180 0 200 200" width="400" height="400"><path fill="#c8752a" d="${D}"/></svg>`;
  emitFixture('gwnCurveRange__CLAW', SVG);

  const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="300" height="300"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const SVG = ${JSON.stringify(SVG)};

const plain = await importSvg(SVG, { nativeArcs: true });
const treed = await importSvg(SVG, { nativeArcs: true, gwnTree: true });
const rng = (s) => s.curveRangesByShape.map(r => [r.begin, r.end]);

// prepareBundle builds the LB meshes SYNCHRONOUSLY. If the range is wrong it never returns, so this
// is the assertion — the timing is only how we report it.
const r = createRenderer(gl, shaders, { fillDefines: ['MANTLE_GWN','MANTLE_GWN_SDF'] });
r.setLoopBlinnFill('off');
const b = createBundle(gl, treed);
const t0 = performance.now();
r.prepareBundle(b);
const prepMs = performance.now() - t0;

r.setViewport(300,300); r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame();
const px = new Uint8Array(300*300*4); gl.readPixels(0,0,300,300,gl.RGBA,gl.UNSIGNED_BYTE,px);
let ink = 0;
for (let i = 0; i < px.length; i += 4) if (px[i+3] > 8 && (px[i] < 245 || px[i+1] < 245 || px[i+2] < 245)) ink++;

window.__out = {
  plainRange: rng(plain), treedRange: rng(treed),
  curvesPlain: plain.curves ? plain.curves.length : -1,
  curvesTreed: treed.curves ? treed.curves.length : -1,
  prepMs: Math.round(prepMs), ink,
};
window.__ready = true;
</script></body></html>`;

  const br = host.browser;
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(host.page(HTML), { waitUntil: 'load', timeout: 90000 });
  // A 30s ceiling IS the stall assertion: the broken build never resolves here.
  const ok0 = await pg
    .waitForFunction(() => window.__ready === true, { timeout: 30000, polling: 100 })
    .then(() => true)
    .catch(() => false);
  const o = ok0 ? await pg.evaluate(() => window.__out) : null;
  await pg.close();

  let fail = 0;
  const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

  if (!o) {
    console.error(
      '  FAIL prepareBundle never returned — the LB builder is reading the GWN tree as curves',
    );
    console.log('\nGWN-CURVE-RANGE FAIL (1)');
    return 1;
  }
  console.log(`  curve range without a tree: ${JSON.stringify(o.plainRange)}`);
  console.log(
    `  curve range WITH a tree   : ${JSON.stringify(o.treedRange)}   (prepareBundle ${o.prepMs} ms)`,
  );

  ok(
    JSON.stringify(o.plainRange) === JSON.stringify(o.treedRange),
    "asking for a GWN tree does not change the shape's CURVE range",
  );
  ok(
    o.prepMs < 2000,
    `prepareBundle returns (${o.prepMs} ms) — it built LB meshes from curves, not from tree records`,
  );
  ok(o.ink > 100, `and the shape still renders under GWN (ink=${o.ink})`);

  console.log(fail ? `\nGWN-CURVE-RANGE FAIL (${fail})` : '\nGWN-CURVE-RANGE PASS');
  return fail;
}

const host = await openCaseHost(ROOT, { headless: 'new', args: ['--no-sandbox'] });
const failures = await runCases(host, [
  ['gwnEngine', gwnEngine],
  ['gwnCurveRange', gwnCurveRange],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\ngwnEngineSmoke: the GWN engine renders and keeps curve ranges to the curves');

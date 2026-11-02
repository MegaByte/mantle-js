// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _fontBench — every fill engine on TEXT, at a range of glyph counts, on any source tree (PAGE_ROOT).
//
// ENGINES=slug,aac,lb,cpatch,gwn,auto (default all). ONE PAGE PER ENGINE: several live renderers on one page share the
// module-level LB builder chain, and a CPatch renderer's deliberate decline then falls through to another renderer's LB
// build -- the CPatch arm times Loop-Blinn. Pages run forward then in reverse and each engine keeps its lower median, so
// every engine gets one early and one late slot on the ramping GPU clock. Each case ends with one UNTIMED proof draw:
// AAC and GWN by the bound program's #defines, LB and CPatch by the draw ledger (older trees without one: LB route count +
// real meshes). An engine the build lacks (CPatch, or GWN's text tree) is reported as such, never timed as a fallback.
//
// Text is the extreme case of the many-small-shapes regime that the sprite sheet
// (jumpLongSplash) exposed: one shape per glyph, ~30 segments each, tiny cover
// quads, and — for a TrueType face like Roboto — almost all QUADRATIC segments.
// That is exactly where AAC's per-fragment fixed cost (its big kernel limits
// occupancy) is amortised over the least per-segment work.
//
// Font size is the knob that moves it: bigger glyphs ⇒ more fragments per segment
// ⇒ AAC's per-segment advantage gets something to pay for its fixed cost.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// PAGE_ROOT: serve the page's modules from another source tree (an older release checkout) so both renderers run the same bench.
const PAGE_ROOT = process.env.PAGE_ROOT ? path.resolve(process.env.PAGE_ROOT) : ROOT;
const W = 1600,
  H = 900;
// FONT=<path> to bench a different face. Roboto is TrueType (quads); a CFF/OTF
// face is cubics, and the two take DIFFERENT px² thresholds in preferAac.
const FONT = process.env.FONT || path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf');
const ttf = Array.from(new Uint8Array(readFileSync(FONT)));
// ~600 glyphs: enough to be fragment-bound rather than draw-call bound
// Two regimes, so draw-bound and fragment-bound are not conflated:
//   many tiny glyphs  → per-shape/per-draw cost dominates
//   few huge glyphs   → per-fragment cost dominates
const LINE = 'Handgloves quick brown fox jumps over the lazy dog 0123456789 ';
// NOTE: a bundle drawn with no worldMatrix fits its globalBBox to the viewport, so
// fontSize CANCELS out of the em→px chain — px²/shape is set by each glyph's share
// of the run bbox, i.e. by GLYPH COUNT, not by point size. Sweep glyph count.
const GLYPHS = (process.env.GLYPHS || '').split(',').filter(Boolean).map(Number);
const CASES = GLYPHS.length
  ? GLYPHS.map((n) => [
      `${String(n).padStart(3)} glyphs`,
      LINE.repeat(Math.ceil(n / LINE.length)).slice(0, n),
      48,
    ])
  : [
      ['520 glyphs @  8px', LINE.repeat(10), 8],
      ['520 glyphs @ 12px', LINE.repeat(10), 12],
      [' 52 glyphs @ 24px', LINE, 24],
      [' 10 glyphs @ 90px', 'Handgloves', 90],
      ['  3 glyphs @260px', 'Hgo', 260],
      ['  1 glyph  @700px', 'g', 700],
    ];

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { createRenderer, loadShaders, MantleFontAsset, createTextBundle } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
// THE PROGRAM THAT DREW, read from WebGL at the draw (see _zzEnginePaint). No backslash escapes in these patterns: this is
// a template literal, and a backslash-s collapses to a bare s.
const progCache = new WeakMap();
const defsIn = (src) => (String(src || '').match(/#define[ \t]+MANTLE_[A-Z0-9_]+/g) || []).map((d) => d.split(/[ \t]+/)[1]);
const programDefs = (pr) => {
  let d = progCache.get(pr); if (d) return d;
  d = new Set(); for (const sh of gl.getAttachedShaders(pr) || []) for (const x of defsIn(gl.getShaderSource(sh))) d.add(x);
  progCache.set(pr, d); return d;
};
let tally = null;
for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  const o = gl[fn].bind(gl);
  gl[fn] = (...a) => {
    if (tally) {
      const pr = gl.getParameter(gl.CURRENT_PROGRAM); const d = pr ? programDefs(pr) : new Set();
      const k = d.has('MANTLE_GWN_SDF') ? 'GWN_SDF' : d.has('MANTLE_HARD_TREE') ? 'HARD_TREE' : d.has('MANTLE_CPATCH') ? 'CPATCH'
              : d.has('MANTLE_AAC') ? 'AAC' : d.has('MANTLE_LB_FILL') ? 'LB_FILL' : pr ? 'OTHER' : 'NONE';
      tally[k] = (tally[k] | 0) + 1;
    }
    return o(...a);
  };
}
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const K=Number(${JSON.stringify(process.env.REPS || '12')});
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const sleep=(ms)=>new Promise((z)=>setTimeout(z,ms));
// Roboto is TrueType, so quadratics only: typeOmit compiles out the arc and cubic kernels from bundle.segTypeMask.
const OPTS = {
  slug:   [{ typeOmit: true }, 'off'],
  aac:    [{ aacFill: true, typeOmit: true }, 'off'],
  lb:     [{ typeOmit: true }, 'on'],
  // CPatch rides Loop-Blinn's draw path: LB 'off' closes that path and CPatch never drew (every case refused). No LB mode is
  // set, as in cpatchTextSmoke; an LB draw in its place is caught by the proof, which needs the CPatch ledger to move.
  cpatch: [{ cpatchFill: true, aacFill: false, typeOmit: true }, null],
  gwn:    [{ fillDefines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'], typeOmit: true }, 'off'],
  auto:   [{ aacFill: 'auto', typeOmit: true }, 'off'],
};
window.__runEngine = async (engine, ttf, cases) => {
  const [opts, lbMode] = OPTS[engine];
  const r = createRenderer(gl, shaders, opts); r.setViewport(${W},${H});
  if (lbMode && r.setLoopBlinnFill) r.setLoopBlinnFill(lbMode);
  // An older text path may take no gwnTree option and bake the tree under this global instead; the current tree ignores it.
  if (engine === 'gwn') globalThis.__MANTLE_GWN_TREE = true;
  const font = new MantleFontAsset(new Uint8Array(ttf));
  const hasLedger = !!(r.debugStats && r.debugStats.engines);
  const ledger = (e) => (((r.debugStats && r.debugStats.engines && r.debugStats.engines.draws) || {})[e]) | 0;
  const out = {};
  for (const [label, text, px] of cases) {
    const res = { ms: null, proof: '', note: '', gl: '' };
    const tb = await createTextBundle(gl, { font, text, style: { fontSize: px, fill: [0,0,0,1] }, ...(engine === 'gwn' ? { gwnTree: true } : {}) });
    const b = tb.bundle;
    res.shapes = b.numShapes | 0; res.mask = b.segTypeMask | 0;
    // GWN is NOT gated on b.gwnTree: HEAD's text path bakes the tree without setting that flag. The proof decides: a GWN_SDF
    // program must have drawn. The flag is reported beside the result.
    if (engine === 'gwn') res.note2 = 'bundle.gwnTree=' + !!b.gwnTree;
    const skip = engine === 'cpatch' && !hasLedger ? 'CPatch not in this build' : '';
    if (skip) { res.note = skip; out[label] = res; if (tb.dispose) tb.dispose(); continue; }
    // An older prepareBundle may build LB meshes synchronously in any LB mode, and on a gwnTree bundle that triangulation can spin
    // (see _zzEnginePaint). A GWN arm on a tree without precompileFills skips it; the warm loop below links its variant.
    if (r.prepareBundle && !(engine === 'gwn' && !r.precompileFills)) r.prepareBundle(b);
    { let w = 0; while (b._occupancyBuildPending && w < 20000) { await sleep(5); w += 5; } }
    if (engine === 'lb') {
      if (r.awaitLbReady) await r.awaitLbReady(b);
      else {
        const ready = () => b._lbMeshes && b._lbMeshes.some((m) => m && !m.slug && (m.vertexCount | 0) > 0) && (b._lbGen | 0) === (b._geomGen | 0);
        let w = 0; while (!ready() && w < 20000) { await sleep(10); w += 10; }
      }
    }
    if (engine === 'cpatch') {
      // A POOLED CONVERSION: keep drawing until CPatch itself has drawn (the path cpatchTextSmoke relies on).
      const c0 = ledger('cpatch'); let w = 0;
      while (ledger('cpatch') === c0 && w < 20000) { r.beginFrame([1,1,1,1]); r.drawBundle(tb); r.endFrame(); await sleep(20); w += 20; }
    }
    // TIME THE PROGRAM THAT SHIPS: HEAD holds a lean variant back until its pipeline is warm; a release tree uses it once linked.
    if (r.precompileFills) r.precompileFills();
    else for (let i = 0; i < 40; i++) { r.beginFrame([1,1,1,1]); r.drawBundle(tb); r.endFrame(); await sleep(0); }
    const runs = [];
    for (let rep = 0; rep < 9; rep++) {
      r.beginFrame([1,1,1,1]); for (let i = 0; i < 3; i++) r.drawBundle(tb); r.endFrame(); sync();
      const t0 = performance.now();
      r.beginFrame([1,1,1,1]); for (let i = 0; i < K; i++) r.drawBundle(tb); r.endFrame(); sync();
      runs.push((performance.now() - t0) / K);
    }
    runs.sort((a, c) => a - c);
    res.ms = runs[Math.floor(runs.length / 2)];   // median: min-of-N is biased low and noisy
    const l0 = { lb: ledger('lb'), cpatch: ledger('cpatch') };
    const lbr0 = (r.debugStats && r.debugStats.loopBlinnRouteCount) | 0;
    tally = {};
    r.beginFrame([1,1,1,1]); r.drawBundle(tb); r.endFrame();
    const t = tally; tally = null;
    // INK: a program can be the right one and still draw nothing or garbage (a GWN kernel with no tree to walk). The proof frame's
    // total COVERAGE (sum of darkness, in whole pixels) is compared against Slug's. A dark-pixel THRESHOLD count was tried first and
    // is wrong for small text: 520 glyphs a few pixels tall read 794 vs 1311 dark pixels between two correct engines, because AA
    // decides which side of 128 a pixel lands on. Coverage integrates that away.
    { const px = new Uint8Array(${W} * ${H} * 4); gl.readPixels(0, 0, ${W}, ${H}, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let ink = 0; for (let i = 0; i < px.length; i += 4) ink += 255 - px[i]; res.ink = Math.round(ink / 255); }
    const lbRoute = ((r.debugStats && r.debugStats.loopBlinnRouteCount) | 0) - lbr0;
    const lbReal = b._lbMeshes ? b._lbMeshes.filter((m) => m && !m.slug && (m.vertexCount | 0) > 0).length : 0;
    let ok = true;
    if (engine === 'aac') ok = (t.AAC | 0) > 0;
    else if (engine === 'gwn') ok = (t.GWN_SDF | 0) > 0;
    else if (engine === 'lb') ok = hasLedger ? ledger('lb') > l0.lb : (lbRoute > 0 && lbReal > 0);
    else if (engine === 'cpatch') ok = ledger('cpatch') > l0.cpatch;
    res.proof = ok ? 'ok' : 'REFUSED';
    res.gl = JSON.stringify(t);
    if (engine === 'auto') { res.px2 = (r.debugStats && r.debugStats.autoMeanShapePx2) || 0; res.picked = (r.debugStats && r.debugStats.autoEngine) || '?'; }
    out[label] = res;
    if (tb.dispose) tb.dispose();
  }
  return out;
};
window.__ready = true;
</script></body></html>`;
const ENGINES = (process.env.ENGINES || 'slug,aac,lb,cpatch,gwn,auto').split(',').filter(Boolean);
// TREES=label=dir,...: one server per source tree and every page in ONE browser, interleaved, so the trees share the GPU clock's
// ramp and a cross-tree ratio is a within-run A/B (separate runs drift 30-40%). Default: the one tree PAGE_ROOT names.
const TREES = process.env.TREES
  ? process.env.TREES.split(',').map((s) => {
      const [label, dir] = s.split('=');
      return { label, root: path.resolve(dir) };
    })
  : [
      {
        label: PAGE_ROOT === ROOT ? 'head' : path.basename(path.dirname(PAGE_ROOT)),
        root: PAGE_ROOT,
      },
    ];
const serve = (root) =>
  http.createServer((q, res) => {
    try {
      const pp = decodeURIComponent(q.url.split('?')[0]);
      if (pp === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(HTML);
        return;
      }
      res.writeHead(200, {
        'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript',
      });
      res.end(readFileSync(path.join(root, pp)));
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
for (const t of TREES) {
  t.server = serve(t.root);
  await new Promise((z) => t.server.listen(0, '127.0.0.1', z));
  t.port = t.server.address().port;
}
// THE same GPU PATH AS _zzEnginePaint. --enable-unsafe-swiftshader only PERMITS a software fallback; this states Metal outright.
const br = await launchBrowser({
  headless: 'new',
  protocolTimeout: 900000,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-webgpu', '--no-sandbox'],
});
const runPage = async (tree, engine) => {
  const pg = await br.newPage();
  let err = '';
  pg.on('pageerror', (e) => {
    err = err || e.message;
    console.error(` [${tree.label} ${engine} err]`, e.message);
  });
  try {
    await pg.goto(`http://127.0.0.1:${tree.port}/`, { waitUntil: 'load', timeout: 90000 });
    await pg.waitForFunction(() => window.__ready === true, { timeout: 90000 });
    return await pg.evaluate((e, t, c) => window.__runEngine(e, t, c), engine, ttf, CASES);
  } catch (e) {
    return { __error: err || e.message };
  } finally {
    await pg.close();
  }
};
// Forward then reverse; within the forward pass the tree order swaps every other engine, so neither tree always runs first.
const slots = [];
ENGINES.forEach((e, i) => {
  for (const t of i % 2 ? [...TREES].reverse() : TREES) slots.push([t, e]);
});
const res = {};
for (const t of TREES) {
  res[t.label] = {};
  for (const e of ENGINES) res[t.label][e] = {};
}
for (const [t, e] of slots) res[t.label][e].fwd = await runPage(t, e);
for (const [t, e] of [...slots].reverse()) res[t.label][e].rev = await runPage(t, e);
await br.close();
for (const t of TREES) t.server.close();
const cellMs = (tl, e, label) => {
  const { fwd, rev } = res[tl][e];
  if (fwd.__error || rev.__error) return { txt: 'ERR' };
  const a = fwd[label],
    z = rev[label];
  if (!a || !z) return { txt: 'ERR' };
  if (a.note) return { txt: 'n/a' };
  if (a.proof !== 'ok' || z.proof !== 'ok') return { txt: 'REFUSED' };
  const ms = Math.min(a.ms, z.ms);
  return { txt: ms.toFixed(4), ms };
};
const eng = ENGINES.filter((e) => e !== 'auto');
const firstOk = (tl) => {
  for (const e of ENGINES) {
    const o = res[tl][e].fwd;
    if (o && !o.__error) return o;
  }
  return null;
};
for (const t of TREES) {
  const f0 = firstOk(t.label),
    first = (f0 && f0[CASES[0][0]]) || {};
  console.log(
    `\n== ${t.label}  ${path.basename(FONT)}  (mask 0b${(first.mask || 0).toString(2).padStart(4, '0')} = ${(first.mask || 0) & 4 ? 'CUBIC' : 'QUAD'})  ${t.root}\n`,
  );
  console.log(
    [
      'case'.padEnd(20),
      'shapes'.padStart(6),
      ...eng.map((e) => e.padStart(8)),
      ...(ENGINES.includes('auto') ? ['auto'.padStart(8), 'vs best', 'picked'] : []),
    ].join('  '),
  );
  for (const [label] of CASES) {
    const cells = eng.map((e) => cellMs(t.label, e, label));
    const row = [
      label.padEnd(20),
      String(((f0 || {})[label] || {}).shapes || 0).padStart(6),
      ...cells.map((c) => c.txt.padStart(8)),
    ];
    if (ENGINES.includes('auto')) {
      const ok = cells.filter((c) => c.ms !== undefined).map((c) => c.ms);
      const best = ok.length ? Math.min(...ok) : NaN;
      const au = cellMs(t.label, 'auto', label),
        a = (res[t.label].auto.fwd || {})[label] || {};
      row.push(
        au.txt.padStart(8),
        au.ms !== undefined && Number.isFinite(best)
          ? (au.ms / best).toFixed(3).padStart(7)
          : '   -   ',
        String(a.picked || '?').toUpperCase(),
      );
    }
    console.log(row.join('  '));
  }
  for (const e of ENGINES) {
    for (const pass of ['fwd', 'rev'])
      if (res[t.label][e][pass].__error)
        console.log(`  ${e} (${pass}): PAGE FAILED — ${res[t.label][e][pass].__error}`);
    for (const [label] of CASES)
      for (const pass of ['fwd', 'rev']) {
        const x = (res[t.label][e][pass] || {})[label];
        if (!x) continue;
        if (x.note) {
          if (pass === 'fwd') console.log(`  ${e} ${label.trim()}: ${x.note}`);
        } else if (x.note2 && pass === 'fwd' && label === CASES[0][0])
          console.log(`  ${e}: ${x.note2}  programs ${x.gl}`);
        else if (x.proof !== 'ok')
          console.log(
            `  ${e} ${label.trim()} (${pass}): DID NOT DRAW WITH ${e.toUpperCase()} — programs ${x.gl}`,
          );
      }
  }
}
// INK vs SLUG, per tree: an engine more than 3% off Slug's dark-pixel count did not draw the same text, whatever its program was.
for (const t of TREES) {
  if (!ENGINES.includes('slug')) break;
  const bad = [];
  for (const [label] of CASES) {
    const s0 = ((res[t.label].slug.fwd || {})[label] || {}).ink;
    for (const e of ENGINES) {
      if (e === 'slug') continue;
      const x = (res[t.label][e].fwd || {})[label];
      if (!x || x.note || x.ink === undefined || !s0) continue;
      if (Math.abs(x.ink - s0) > 0.03 * s0)
        bad.push(`${e} ${label.trim()}: ink ${x.ink} vs slug ${s0}`);
    }
  }
  console.log(
    `\n== ${t.label} ink vs slug: ` +
      (bad.length ? 'MISMATCH\n  ' + bad.join('\n  ') : 'every drawn engine within 3%'),
  );
}
if (TREES.length > 1) {
  const [A, B] = [TREES[0].label, TREES[TREES.length - 1].label];
  console.log(`\n== ${B} / ${A}  (ms ratio, same browser; < 1 means ${B} is faster)\n`);
  console.log(['case'.padEnd(20), ...ENGINES.map((e) => e.padStart(8))].join('  '));
  for (const [label] of CASES)
    console.log(
      [
        label.padEnd(20),
        ...ENGINES.map((e) => {
          const a = cellMs(A, e, label),
            b = cellMs(B, e, label);
          return (
            a.ms !== undefined && b.ms !== undefined ? (b.ms / a.ms).toFixed(3) : '-'
          ).padStart(8);
        }),
      ].join('  '),
    );
}

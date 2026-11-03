// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/fillPrograms.mjs — what each fill program actually compiles, and what is
// compiled into it that this bundle can never reach.
//
// GL-FREE ON PURPOSE. Everything here is a count: which define set a bundle's variant takes
// (the real `variantDefinesFor`, driven against a stub GL), and how many lines of GLSL survive
// the preprocessor under it (a C-preprocessor walk of the committed, assembled
// src/shaders/generated/*.glsl — the same text `withDefines` hands the driver). Neither number
// needs a frame, and neither can be inflated by a fallback: a program that did not get the
// define is a program whose text is still there to count.
//
//   node probes/perf/fillPrograms.mjs                 # the whole corpus
//   only=tiger node probes/perf/fillPrograms.mjs      # one asset
//
// ── THE FALSIFIABLE CLAIMS ──────────────────────────────────────────────────────────────────
//
// C1. `MANTLE_NO_BEZOUT` is emitted from the packer's presence flag (`hasBezout`, which ORs
//    `interiorHasChain2`), shipped across the worker wire. Falsify by finding a bundle whose
//    every mesh reports hasBezout === false and whose variant key lacks MANTLE_NO_BEZOUT.
//    Guarded by test/fillBezoutOmitSmoke.mjs.
//
// C2 (MEASURED HERE). The define is worth 174 of the 2812 fragment lines an LB variant
//    compiles (-6.2%), 7,336 of 102,665 characters (-7.1%), and 40.7% of _lbCoverage.glsl
//    itself (428 -> 254 lines) — plus two vec4 varyings and, under MANTLE_LB_CURVE_TEX, two
//    texel fetches per vertex. Falsify by preprocessing the generated shaders and getting
//    different numbers.
//
// C3 (MEASURED HERE). It reaches slightly over half the assets in this repo's corpus by COUNT
//    and almost none of its geometry by VERTEX. Printed below; the split is the point, and it
//    is what makes C2 an upper bound on a real frame rather than a claim about one.
//
// C4 (PRICED, NOT TAKEN). `typeOmit` is off by default. The mask it reads is already
//    load-bearing for correctness elsewhere — `preferNoAa` picks a kernel that renders HARD
//    for cubic/arc from the same `segTypeMask`, so a mask that lied about a cubic would
//    already mis-render — but turning the omit on changes which arms of the coverage walk
//    EXIST, and that cannot be gated on a count. The per-asset win is printed; the GPU gate
//    that would let it default on is written at the bottom.
//
// C5 (PRICED, AND THE PRICE IS NOT A COUNT). "All-LB draws may compile the Slug cover
//    kernel." The survey below says 90.7% of corpus assets have an LB mesh for every fill
//    row — under a FULL build, which is the wrong question. What decides whether a row's
//    cover quad needs `renderFill` is the per-shape 'auto' pick, and that pick is made at
//    DRAW time from the shape's on-screen size (lbShapePolicy), so it moves with zoom. A
//    define keyed on it is correct but re-keys per scale, and being wrong about one row does
//    not render badly — it renders nothing there. So the count says the opportunity is real
//    and says nothing about whether to take it; GPU D below is the experiment that would.
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');
const REPO = path.resolve(JS, '..');

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(path.join(JS, 'src/svg/importer.js'));
const { parseMetaBin } = await import(path.join(JS, 'src/renderer/bundle.js'));
const { buildLbBundle } = await import(path.join(JS, 'src/renderer/lbBuildCore.js'));

// ── a C-preprocessor, enough for the #if skeleton these shaders use ─────────────────────────
function preprocess(src, defs) {
  const D = new Set(defs);
  const out = [];
  const stack = [];
  let active = true;
  const ev = (e) => {
    const s = e
      .replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_, n) => (D.has(n) ? '1' : '0'))
      .replace(/defined\s+([A-Za-z_]\w*)/g, (_, n) => (D.has(n) ? '1' : '0'))
      .replace(/\b([A-Za-z_]\w*)\b/g, (n) => (D.has(n) ? '1' : '0'));
    try {
      return !!Function('"use strict";return (' + s + ')')();
    } catch {
      return false;
    }
  };
  for (const line of src.split('\n')) {
    const t = line.trim();
    let m;
    if ((m = /^#\s*ifdef\s+([A-Za-z_]\w*)/.exec(t))) {
      const c = D.has(m[1]);
      stack.push({ parent: active, taken: c });
      active = active && c;
      continue;
    }
    if ((m = /^#\s*ifndef\s+([A-Za-z_]\w*)/.exec(t))) {
      const c = !D.has(m[1]);
      stack.push({ parent: active, taken: c });
      active = active && c;
      continue;
    }
    if ((m = /^#\s*if\s+(.*)$/.exec(t))) {
      const c = ev(m[1]);
      stack.push({ parent: active, taken: c });
      active = active && c;
      continue;
    }
    if ((m = /^#\s*elif\s+(.*)$/.exec(t))) {
      const f = stack[stack.length - 1];
      if (!f) continue;
      const c = !f.taken && ev(m[1]);
      f.taken = f.taken || c;
      active = f.parent && c;
      continue;
    }
    if (/^#\s*else\b/.test(t)) {
      const f = stack[stack.length - 1];
      if (!f) continue;
      const c = !f.taken;
      f.taken = true;
      active = f.parent && c;
      continue;
    }
    if (/^#\s*endif\b/.test(t)) {
      const f = stack.pop();
      if (f) active = f.parent;
      continue;
    }
    if (active && (m = /^#\s*define\s+([A-Za-z_]\w*)/.exec(t))) D.add(m[1]);
    if (active && (m = /^#\s*undef\s+([A-Za-z_]\w*)/.exec(t))) D.delete(m[1]);
    if (active) out.push(line);
  }
  return out.join('\n');
}
function codeStats(src) {
  let lines = 0,
    chars = 0;
  for (let l of src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
    const i = l.indexOf('//');
    if (i >= 0) l = l.slice(0, i);
    l = l.trim();
    if (!l || l.startsWith('#')) continue;
    lines++;
    chars += l.length;
  }
  return { lines, chars };
}
const statsFor = (f, defs) => codeStats(preprocess(readFileSync(f, 'utf8'), defs));

const G = (n) => path.join(JS, 'src/shaders/generated', n);
const S = (n) => path.join(JS, 'src/shaders', n);
const FRAG = G('mantle.frag.glsl'),
  VERT = G('mantle.vert.glsl'),
  LBC = S('_lbCoverage.glsl');
const BASE = ['MANTLE_LB_FILL', 'MANTLE_LB_CURVE_TEX'];

console.log('\n== C2: what MANTLE_NO_BEZOUT is worth, in compiled text ==');
{
  const row = (name, defs, files) => {
    const f = statsFor(FRAG, defs),
      v = statsFor(VERT, defs),
      l = statsFor(LBC, defs);
    console.log(
      `  ${name.padEnd(40)} frag ${String(f.lines).padStart(5)}L ${String(f.chars).padStart(7)}ch  vert ${String(v.lines).padStart(4)}L  _lbCoverage ${String(l.lines).padStart(4)}L`,
    );
    return { f, v, l };
  };
  const a = row('LB variant (full)', BASE);
  const b = row('LB variant +MANTLE_NO_BEZOUT', [...BASE, 'MANTLE_NO_BEZOUT']);
  const pct = (x, y) => `${((100 * (x - y)) / x).toFixed(1)}%`;
  console.log(
    `  -> frag ${a.f.lines - b.f.lines} lines (${pct(a.f.lines, b.f.lines)}), ` +
      `${a.f.chars - b.f.chars} chars (${pct(a.f.chars, b.f.chars)}), ` +
      `_lbCoverage ${a.l.lines - b.l.lines} lines (${pct(a.l.lines, b.l.lines)})`,
  );
  console.log(
    '  -> plus vLB1/vLB2: two vec4 varyings, and two texel fetches per vertex under MANTLE_LB_CURVE_TEX',
  );
}

console.log('\n== C4: what typeOmit would be worth, in compiled text ==');
{
  const NAMES = ['MANTLE_NO_LINE', 'MANTLE_NO_QUAD', 'MANTLE_NO_CUBIC', 'MANTLE_NO_ARC'];
  const full = statsFor(FRAG, BASE);
  for (let m = 1; m <= 0xf; m++) {
    const omit = [];
    for (let t = 0; t < 4; t++) if (!(m & (1 << t))) omit.push(NAMES[t]);
    if (!omit.length) continue;
    const s = statsFor(FRAG, [...BASE, ...omit]);
    console.log(
      `  segTypeMask 0x${m.toString(16)}  ->  frag ${String(s.lines).padStart(5)}L ` +
        `(-${full.lines - s.lines}, -${((100 * (full.lines - s.lines)) / full.lines).toFixed(1)}%)  ${omit.join(' ')}`,
    );
  }
}

// ── corpus survey ───────────────────────────────────────────────────────────────────────────
const dirs = [path.join(REPO, 'MantleSamples/Assets/Mantle'), path.join(REPO, 'fixtures/svg')];
const files = [];
for (const d of dirs) {
  try {
    for (const f of readdirSync(d)) if (f.endsWith('.svg')) files.push(path.join(d, f));
  } catch {}
}
files.sort();
const only = process.env.ONLY ? files.filter((f) => f.includes(process.env.ONLY)) : files;

console.log(`\n== C3/C5: corpus survey over ${only.length} SVGs ==`);
let nAsset = 0,
  nNoBez = 0,
  nAllLb = 0,
  meshTot = 0,
  meshBez = 0,
  vertTot = 0,
  vertBez = 0;
let nTypeOmit = 0,
  skipped = 0;
const VERBOSE = !!process.env.VERBOSE;
for (const f of only) {
  let sec, pm, res;
  try {
    sec = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
    pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
    res = buildLbBundle({
      curveFloats: new Float32Array(sec.curves),
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      ranges: sec.curveRangesByShape,
      numShapes: sec.numShapes,
    });
  } catch {
    skipped++;
    continue;
  }
  let real = 0,
    bez = 0,
    vt = 0,
    vb = 0,
    km = 0;
  for (const pk of res.packed) {
    if (!pk || pk.slug || !(pk.vertexCount | 0)) continue;
    real++;
    vt += pk.vertexCount | 0;
    km |= pk.kindMask | 0;
    if (pk.hasBezout) {
      bez++;
      vb += pk.vertexCount | 0;
    }
  }
  if (!real) {
    skipped++;
    continue;
  }
  // How many rows carry a FILL (meta slot 7 = fill alpha > 0)? A row whose fill has no LB
  // mesh draws its cover quad through renderFill — which is what C5 is about.
  const st = pm.floatsPerShape | 0;
  let fillRows = 0,
    fillRowsCovered = 0;
  for (let s = 0; s < (sec.numShapes | 0); s++) {
    if (!(pm.metaFloats[s * st + 7] > 0)) continue;
    fillRows++;
    const pk = res.packed[s];
    if (pk && !pk.slug && (pk.vertexCount | 0) > 0) fillRowsCovered++;
  }
  nAsset++;
  meshTot += real;
  meshBez += bez;
  vertTot += vt;
  vertBez += vb;
  const noBez = bez === 0;
  if (noBez) nNoBez++;
  const allLb = fillRows > 0 && fillRowsCovered === fillRows;
  if (allLb) nAllLb++;
  const tm = sec.segTypeMask | 0 || 0xf;
  if (tm !== 0xf) nTypeOmit++;
  if (VERBOSE) {
    console.log(
      `  ${noBez ? 'NOBEZ' : '     '} ${allLb ? 'ALLLB' : '     '} ${path.basename(f).padEnd(34)}` +
        ` meshes ${String(real).padStart(4)} bez ${String(bez).padStart(4)} verts ${String(vt).padStart(7)}` +
        ` km 0x${km.toString(16)} tm 0x${tm.toString(16)} fillRows ${fillRowsCovered}/${fillRows}`,
    );
  }
}
const pc = (a, b) => `${a} of ${b} (${((100 * a) / b).toFixed(1)}%)`;
console.log(`  assets with Loop-Blinn meshes: ${nAsset} (skipped ${skipped})`);
console.log(`  C3  MANTLE_NO_BEZOUT applies to ${pc(nNoBez, nAsset)} assets`);
console.log(
  `      ...but only ${pc(meshTot - meshBez, meshTot)} meshes and ${pc(vertTot - vertBez, vertTot)} vertices`,
);
console.log(`  C4  typeOmit would strip at least one arm on ${pc(nTypeOmit, nAsset)} assets`);
console.log(`  C5  assets whose EVERY fill row has an LB mesh: ${pc(nAllLb, nAsset)}`);

console.log(`
== WHAT NEEDS A GPU, AND EXACTLY WHAT TO FILL IN =============================================

GPU A  Does MANTLE_NO_BEZOUT change any pixel?  (it must not)
  It is a presence define, so this is a CORRECTNESS gate, not a speed one.
    driver:  probes/_zzEnginePaint.mjs, ARMS='lb'
    assets:  every asset this survey printed NOBEZ (run with VERBOSE=1 to list them)
    sizes:   512
    arms:    A = this tree;  B = this tree with the two lines in fillPass.js that push
             MANTLE_NO_BEZOUT commented out.  Pin the engine with setFillEngine, never
             fillDefines — a forced define rides a different route.
    gate:    frames BYTE-IDENTICAL, and debugStats.engines.draws identical (a variant that
             failed to link falls back to the base program and would read as a pass).
    fill in: [ ] identical frames on N assets   [ ] draws identical   [ ] 0 link failures

GPU B  Is it worth anything?  (prediction: at most noise on this corpus)
    same driver, ARMS='lb:__MANTLE_FILL_DEFINES=,lb' is NOT valid here (the define is chosen
    per bundle, not per arm) — use the A/B above, interleaved, with an A/A control FIRST.
    PREDICTION, written before the run: no asset in this corpus moves outside the A/A floor.
    The 40.7% of _lbCoverage.glsl this removes lands on assets whose LB geometry is 1.6% of
    the corpus's vertices, so a frame-time win here would be evidence about PROGRAM PRESENCE
    (the 2-5% a merely-existing kernel costs), not about the work removed.
    fill in: A/A spread ____ %   |  per-asset A/B ____ x  |  verdict ____

GPU C  The gate that would let typeOmit default on.
    arms:    A = createRenderer(..., { typeOmit: false })   B = { typeOmit: true }
    assets:  every corpus asset whose segTypeMask != 0xF (printed above)
    sizes:   256 and 1024 (a stripped arm must be identical at both; a mask error shows up
             as MISSING INK, which is scale-dependent in how visible it is, not in whether
             it is there)
    gate:    BYTE-IDENTICAL frames on every asset, both sizes, AND on a morph pose and a
             streamed re-upload of the same bundle (the two paths that can move geometry
             under a mask computed at import).
    fill in: [ ] identical   [ ] morph identical   [ ] streamed identical   [ ] speed ____ x
    Until all four are ticked the default stays off: a wrong mask does not render badly, it
    renders NOTHING where the missing arm was, and no count can see that.

GPU D  Is a cover-fill-free LB program worth building at all?
    There is no such define, so this is measured by STANDING IN for it before writing
    it, which is the cheap half of the experiment and the half that decides:
    arm A:  an asset from the ALLLB list, drawn normally.
    arm B:  the same asset and the same route with globalThis.__MANTLE_FILL_DEFINES set to
            'MANTLE_COV_STUB' (and __MANTLE_DEBUG__ = true, the hook's gate) — that replaces fCovBase's value with a constant while leaving
            every other stage standing, so the delta is an UPPER BOUND on what omitting
            renderFill could ever buy. (It renders wrong on purpose; read the timer, not the
            frame, and check debugStats.engines.draws is unchanged.)
    sizes:  512 and 2048, REPEAT>=8, A/A control first.
    decide: if B is inside the A/A floor at both sizes, stop — the kernel's mere PRESENCE is
            all that is left and MANTLE_NO_BEZOUT already measures that (GPU B). If B is
            outside it, the define is worth building, keyed on R._lbAutoPicks covering every
            fill row, and the variant key must carry the pick generation so a zoom that
            un-picks a row re-keys instead of losing its ink.
    fill in: A/A ____ %  |  @512 ____ x  |  @2048 ____ x  |  verdict ____
`);

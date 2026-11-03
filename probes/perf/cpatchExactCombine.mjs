// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/cpatchExactCombine.mjs — what CPatch's exact COMBINE is, what it can cost, and the GPU runs
// that price it.
//
//   node probes/perf/cpatchExactCombine.mjs
//
// Prints exact combine's share of the compiled CPatch kernel, whether the CPU twin (cpatchCov.js) carries
// the same two- and three-plane forms, and the GPU A/B that splits the cost between its two mechanisms.
//
// A loop-free exact area with an exact-tie break ships as cpExactBoxCov23 in _cpatchCoverage.glsl (a
// Green's-theorem area; nearly coincident planes locate their crossing once, so no area is lost between
// two answers).
//
// ── WHAT exact COMBINE actually IS, AND WHY A LINE COUNT WILL NOT PRICE IT ──────────────────
//
// Two mechanisms, both in `cpatchCoverage()`:
//
//   1. THE MIN-COMBINE. The constraint walk keeps the two SMALLEST non-cut coverages together
//      with their normals and signed distances — `exC1/exN1/exD1`, `exC2/exN2/exD2` — and after
//      the loop composes them as an area rather than a min:
//        `if (exC2 < 1.0) cov = min(cov, exactBoxCov2(-exN1, exD1, -exN2, exD2));`
//      (The shipped kernel has no define that turns it off; an A/B needs a tree that carries
//      `#ifndef MANTLE_CPATCH_MINCOMBINE` around it.)
//   2. THE RELAXED SEAM'S exact PIECE. The tightest CUT is tracked the same way
//      (`exCutC/exCutD/exCutN`) and where the patch's own coverage says it is mid-ramp on a real
//      edge, the piece becomes `exactBoxCov3` of three half-planes. (Likewise unguarded; the A/B
//      arm is `#ifndef MANTLE_CPATCH_SEAM_MINPIECE`.)
//
// THE COST IS NOT CODE SIZE. Preprocessed, the whole of exact combine is FIVE lines of the
// 332-line CPatch kernel (printed below). What it costs is EIGHT LIVE FLOATS carried across the
// constraint loop — two coverages, two distances, two vec2 normals — plus a two-deep insertion
// sort per iteration, in a loop the file's own notes call register-bound, where residency is
// what hides the fetch latency. That is exactly the kind of cost a line count cannot see and a
// GPU timer can.
//
// AND IT IS NOT ON every DRAW. `fillPass` pushes MANTLE_CPATCH_SEAM_HARD whenever the unified
// draw claims depth — a translucent draw, a morph, or a bundle that needs the claim — and the
// hard-seam branch skips the `exactBoxCov3` piece entirely. So a CPatch MORPH never pays for
// (2) and never gets its accuracy either. The min-combine in (1) is outside that guard and does
// apply. Any A/B that does not state which of the two it is measuring is measuring both.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');

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
    if (active) out.push(line);
  }
  return out.join('\n');
}
function codeLines(src) {
  let n = 0;
  for (let l of src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
    const i = l.indexOf('//');
    if (i >= 0) l = l.slice(0, i);
    l = l.trim();
    if (!l || l.startsWith('#')) continue;
    n++;
  }
  return n;
}
const CP = readFileSync(path.join(JS, 'src/shaders/_cpatchCoverage.glsl'), 'utf8');
const BASE = ['MANTLE_LB_FILL', 'MANTLE_LB_CURVE_TEX', 'MANTLE_CPATCH'];
const L = (d) => codeLines(preprocess(CP, d));

console.log('\n== exact combine, as compiled text ==');
const full = L(BASE);
const hard = L([...BASE, 'MANTLE_CPATCH_SEAM_HARD']);
console.log(`  _cpatchCoverage.glsl, CPatch default        ${full} lines`);
console.log(`    with MANTLE_CPATCH_SEAM_HARD (morph/alpha) ${hard} lines  (-${full - hard})`);
console.log('  -> exact combine is five of them (counted on a tree with the');
console.log('     MANTLE_CPATCH_MINCOMBINE / _SEAM_MINPIECE arms that take it out). The cost is');
console.log('     REGISTERS, not instructions: exC1, exD1, exC2, exD2 and');
console.log('     two vec2 normals -- eight live floats -- carried across a loop this file calls');
console.log('     register-bound, plus a two-deep insertion sort per iteration. A line count');
console.log('     cannot price that and neither can a static analysis; only a frame can.');

console.log('\n== the CPU twin cannot check any of it ==');
{
  const cov = readFileSync(path.join(JS, 'src/renderer/cpatchCov.js'), 'utf8');
  const n2 = (cov.match(/exactBoxCov2/g) || []).length;
  const n3 = (cov.match(/exactBoxCov3/g) || []).length;
  const n1 = (cov.match(/exactBoxCov/g) || []).length - n2 - n3;
  console.log(
    `  src/renderer/cpatchCov.js: exactBoxCov ${n1}, exactBoxCov2 ${n2}, exactBoxCov3 ${n3}`,
  );
  console.log('  If exactBoxCov2 and exactBoxCov3 read 0, the CPU twin models a min()-combined,');
  console.log(
    '  FENCED kernel: it walks packed cover rows explicitly and composes constraints with',
  );
  console.log(
    '  min(). Every CPU quality probe built on it (_rowGateAaRef, _rowGateSpill, _zzAaAudit,',
  );
  console.log(
    '  _cpatchShapeQuality, morphScale/_morphCov) would then measure a kernel the tree does',
  );
  console.log('  not ship. Matching the twin to the shader is CPU work, not GPU work: without it');
  console.log('  the accuracy gate below has to be read off rendered frames, which is exactly the');
  console.log('  loop the CPU twin exists to break.');
}

console.log(`
== WHAT NEEDS A GPU, AND EXACTLY WHAT TO FILL IN =============================================

GPU A/B  Does exact combine cost 2x, and which half?
  driver:  probes/_zzEnginePaint.mjs. It takes ARMS entries of the form engine:GLOBAL=value, so
           two configurations share ONE GPU state and one run -- which is the only kind of
           comparison that counts here (cross-run drift is 30-40%).
  arms:    B, C and D name defines the shipped kernel does not have: run them on a tree that
           carries them, beside this one -- probes/_zzEngineCorpus.mjs interleaves source trees
           in one run (TREES=).
           A  cpatch                                        (default, both mechanisms)
           B  cpatch:__CP_DEFINES=MANTLE_CPATCH_MINCOMBINE  (min-combine off, piece on)
           C  cpatch:__CP_DEFINES=MANTLE_CPATCH_SEAM_MINPIECE  (piece off, min-combine on)
           D  cpatch:__CP_DEFINES=MANTLE_CPATCH_MINCOMBINE,MANTLE_CPATCH_SEAM_MINPIECE
  order:   A,A first as the A/A control, then A,B,C,D,A -- the trailing A catches drift.
  assets:  tiger.svg at 512 and 2048 (the file's own cost model is blocks-per-fragment, so the
           2048 reading is the one that tests it), plus Roboto 'N' at 512 for a glyph, plus one
           asset with many SUB-PIXEL features, which is where mechanism 2 does its work.
  check:   debugStats.engines.draws must show cpatch in EVERY arm. A CPatch decline falls to LB
           and reads as a triumph; the probe already enforces per-arm engine deltas, so use them.
  ACCURACY GATE, and it is the point -- these defines buy ink, not speed:
           report wrong-solid, AA mean and AA max for every arm from the same run. The exact
           piece exists because "for a stem narrower than a pixel that is the stem's WHOLE
           partial on both sides, so two 0.3 sides composited to 0.51 (Roboto at a 3px cap
           +50% ink)". If D is fast and its ink is wrong, D is not an option.
  fill in: A/A ____ %
           @512   B/A ____ x   C/A ____ x   D/A ____ x
           @2048  B/A ____ x   C/A ____ x   D/A ____ x
           wrong solid  A ____  B ____  C ____  D ____
           AA mean      A ____  B ____  C ____  D ____
  DECIDE ON THE SPLIT. If B ~= A and C ~= D, the cost is the SEAM PIECE and it is already off
  for morphs and translucent draws, so the fix is a gate, not a rewrite. If C ~= A and B ~= D,
  the cost is the two-deep tracking in the loop, and the loop-free form below is worth building.

GPU A/B  The loop-free form, if the A/B above says the tracking is the cost.
  The design: the two tightest constraints do
  not have to be found by carrying eight floats through the walk. Every constraint already
  computes its coverage and its (n, d); a SECOND pass over the same block range, entered only
  when the composed coverage says the fragment is on an edge (cov < CP_SEAM_NEAR, which is
  already computed), can re-find the two smallest with NO state carried through the first pass.
  It trades a rare second walk for eight registers on every fragment of every patch.
  gate:   BYTE-IDENTICAL to A. The two passes must select the same pair, so any difference is a
          bug, not a tolerance.
  fill in: [ ] identical   |  @512 ____ x   @2048 ____ x   |  worth keeping ____
`);

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shaderDefaultText.mjs — the package shader text is unchanged by a switch deletion, under every define set.
//
// Deleting a `#ifdef ESCAPE` arm keeps the branch the renderer compiles when nothing sets it, so for every
// define set that does not name a deleted switch, the preprocessed text must be the same bytes before and
// after. This runs the C preprocessor over the ASSEMBLED shaders (src/shaders/generated/*.glsl) of two
// trees and compares the output, whitespace-normalized, under:
//
//   - no defines;
//   - every identifier either tree tests in an #if/#ifdef/#ifndef/#elif, alone and inside each of the
//     contexts below (most LB and GWN arms only exist inside MANTLE_LB_FILL or MANTLE_GWN);
//   - the define sets the renderer emits (fillPass.js variantDefinesFor, renderer.js aacFill /
//     exactEdgeAa), listed in SETS.
//
//   node probes/flags/shaderDefaultText.mjs <base js.kontek.mantle> <tree js.kontek.mantle> [DELETED,NAMES]
//
// Deleted names are excluded from every set: the new text no longer answers to them by design.
import { readFileSync, readdirSync, existsSync } from 'fs';
import { clangPreprocess } from '../../test/_glslMainEmu.mjs';
import path from 'path';

const [baseTree, tree, deletedArg] = process.argv.slice(2);
if (!baseTree || !tree) {
  console.error('usage: shaderDefaultText.mjs <base> <tree> [DELETED,...]');
  process.exit(2);
}
const deleted = new Set(
  (deletedArg || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const GEN = (t) => path.join(t, 'src/shaders/generated');

const LB = ['MANTLE_LB_FILL', 'MANTLE_LB_CURVE_TEX'];
const CONTEXTS = [
  [],
  LB,
  [...LB, 'MANTLE_LB_MORPH'],
  ['MANTLE_GWN', 'MANTLE_GWN_SDF'],
  ['MANTLE_HARD', 'MANTLE_GWN', 'MANTLE_HARD_TREE'],
  ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'],
  [...LB, 'MANTLE_CPATCH', 'MANTLE_CPATCH_HULLVAR'],
];
const OMIT_KINDS = [
  'MANTLE_LB_NO_DISC',
  'MANTLE_LB_NO_EDGE_STRIP',
  'MANTLE_LB_NO_CURVE_BAND',
  'MANTLE_LB_NO_CHAIN_STRIP',
  'MANTLE_NO_BEZOUT',
];
const COLOR_OMIT = ['MANTLE_NO_CHANNEL_LERP', 'MANTLE_NO_PALETTE', 'MANTLE_NO_COLOR_MATRIX'];
const SETS = [
  ['MANTLE_LB_FILL'],
  LB,
  [...LB, 'MANTLE_LB_MORPH'],
  [...LB, ...OMIT_KINDS],
  [...LB, 'MANTLE_LB_MORPH', ...OMIT_KINDS],
  [...LB, 'MANTLE_NO_RECOLOR'],
  [...LB, ...COLOR_OMIT],
  ['MANTLE_AAC'],
  ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'],
  [...LB, 'MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'],
  [...LB, 'MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS', ...OMIT_KINDS, 'MANTLE_NO_RECOLOR'],
  ['MANTLE_HARD', 'MANTLE_GWN'],
  ['MANTLE_HARD', 'MANTLE_GWN', 'MANTLE_HARD_TREE'],
  [...LB, 'MANTLE_HARD', 'MANTLE_GWN', 'MANTLE_HARD_TREE'],
  ['MANTLE_HARD_MIXED', 'MANTLE_GWN'],
  [...LB, 'MANTLE_HARD_MIXED', 'MANTLE_GWN'],
  [...LB, 'MANTLE_COVER_KERNEL', 'MANTLE_GWN'],
  ['MANTLE_GWN', 'MANTLE_GWN_SDF'],
  [...LB, 'MANTLE_GWN', 'MANTLE_GWN_SDF'],
  ['MANTLE_EXACT_EDGE'],
  [...LB, 'MANTLE_EXACT_EDGE'],
  ['MANTLE_AAC', 'MANTLE_EXACT_EDGE'],
  [...LB, 'MANTLE_CPATCH', 'MANTLE_CPATCH_HULLVAR'],
  [...LB, 'MANTLE_CPATCH', 'MANTLE_CPATCH_HULLVAR', 'MANTLE_CPATCH_SEAM_HARD'],
  [...LB, 'MANTLE_LB_MORPH', 'MANTLE_CPATCH', 'MANTLE_CPATCH_HULLVAR', 'MANTLE_CPATCH_SEAM_HARD'],
  ['MANTLE_NO_LINE', 'MANTLE_NO_ARC'],
  ['MANTLE_NO_QUAD', 'MANTLE_NO_CUBIC'],
  [...LB, 'MANTLE_NO_CUBIC', 'MANTLE_NO_ARC'],
  ['MANTLE_LB_FILL_COV'],
];

function idsOf(text) {
  const ids = new Set();
  for (const line of text.split('\n')) {
    const m = /^\s*#\s*(if|ifdef|ifndef|elif)\b(.*)$/.exec(line);
    if (!m) continue;
    for (const id of m[2].replace(/\/\/.*$/, '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])
      if (id !== 'defined') ids.add(id);
  }
  return ids;
}
// From a FILE and under a time cap (test/_glslMainEmu clangPreprocess): fed on stdin, `clang -E` has sat at 0% CPU for
// the whole of a run, twice, and hung it.
function pp(text, defs) {
  const src = text
    .split('\n')
    .filter((l) => !/^\s*#\s*(version|extension|pragma)\b/.test(l))
    .join('\n');
  const r = clangPreprocess(src, ['-P', '-undef', '-w', '-x', 'c', ...defs.map((d) => '-D' + d)]);
  const out = (r.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  return `${r.status}\n${out}\n${r.status ? r.stderr : ''}`;
}

const files = readdirSync(GEN(tree))
  .filter((f) => f.endsWith('.glsl'))
  .sort();
let identicalFiles = 0,
  checked = 0,
  bad = 0;
const setsSeen = new Set();
for (const f of files) {
  const bp = path.join(GEN(baseTree), f);
  if (!existsSync(bp)) {
    console.log(`  NEW FILE ${f}`);
    bad++;
    continue;
  }
  const A = readFileSync(bp, 'utf8'),
    B = readFileSync(path.join(GEN(tree), f), 'utf8');
  if (A === B) {
    identicalFiles++;
    continue;
  }
  const ids = [...new Set([...idsOf(A), ...idsOf(B)])].filter((d) => !deleted.has(d)).sort();
  const sets = [[], ...SETS];
  for (const ctx of CONTEXTS) for (const d of ids) if (!ctx.includes(d)) sets.push([...ctx, d]);
  let diffs = 0;
  for (const s0 of sets) {
    const s = s0.filter((d) => !deleted.has(d));
    const key = s.join(',');
    setsSeen.add(key);
    checked++;
    const a = pp(A, s),
      b = pp(B, s);
    if (a !== b) {
      diffs++;
      bad++;
      if (diffs <= 3) {
        const al = a.split('\n'),
          bl = b.split('\n');
        let i = 0;
        while (i < al.length && al[i] === bl[i]) i++;
        console.log(
          `  DIFF ${f} [${key || 'no defines'}] first at line ${i}:\n    - ${al.slice(i, i + 2).join('\n      ')}\n    + ${bl.slice(i, i + 2).join('\n      ')}`,
        );
      }
    }
  }
  console.log(
    `${f}: text changed; ${sets.length} define sets (${ids.length} tested identifiers x ${CONTEXTS.length} contexts + ${SETS.length} renderer sets + none), ${diffs} differ after preprocessing`,
  );
}
console.log(
  `${files.length} generated shaders: ${identicalFiles} byte-identical, ${files.length - identicalFiles} changed; ${checked} preprocessings compared over ${setsSeen.size} distinct define sets; ${bad} differ`,
);
process.exit(bad ? 1 : 0);

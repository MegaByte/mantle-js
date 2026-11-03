// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchShaderIdentity — does the ASSEMBLED shader preprocess to the same text as another tree's?
//
// Deleting a shader switch must leave every variant the renderer builds unchanged. This runs the C
// preprocessor (clang -E -P, the same macro language as GLSL's) over each tree's generated
// src/shaders/generated/*.glsl under every define set below and compares the results, so an
// #ifdef removed with its arm, a comment edited or a dead helper deleted cannot move a variant.
//
//   node probes/flags/cpatchShaderIdentity.mjs <base js.kontek.mantle> <head js.kontek.mantle>
//
// A set is `a|b`: preprocess base under a and head under b. That is how a define the renderer
// the renderer does not emit is checked -- the base variant WITH it must equal the head variant WITHOUT it.
import { readFileSync, readdirSync } from 'node:fs';
import { clangPreprocess } from '../../test/_glslMainEmu.mjs';
import path from 'node:path';

const [baseRoot, headRoot] = process.argv.slice(2);
if (!baseRoot || !headRoot) {
  console.log('usage: cpatchShaderIdentity.mjs <base root> <head root>');
  process.exit(2);
}

// The define sets fillPass.variantDefinesFor emits for a CPatch draw (MANTLE_LB_FILL + MANTLE_CPATCH,
// SEAM_HARD when the draw claims depth), with and without the curve-texture fetch and the LB kind
// omissions a CPatch-only bundle gets, plus no defines at all and the Loop-Blinn fill alone.
const LB = 'MANTLE_LB_FILL,MANTLE_LB_CURVE_TEX';
const OMIT =
  'MANTLE_LB_NO_DISC,MANTLE_LB_NO_EDGE_STRIP,MANTLE_LB_NO_CURVE_BAND,MANTLE_LB_NO_CHAIN_STRIP';
const SETS = [
  '',
  'MANTLE_LB_FILL',
  LB,
  `MANTLE_LB_FILL,MANTLE_CPATCH,MANTLE_CPATCH_HULLVAR|MANTLE_LB_FILL,MANTLE_CPATCH`,
  `${LB},MANTLE_CPATCH,MANTLE_CPATCH_HULLVAR|${LB},MANTLE_CPATCH`,
  `${LB},MANTLE_CPATCH,MANTLE_CPATCH_HULLVAR,MANTLE_CPATCH_SEAM_HARD|${LB},MANTLE_CPATCH,MANTLE_CPATCH_SEAM_HARD`,
  `${LB},${OMIT},MANTLE_CPATCH,MANTLE_CPATCH_HULLVAR|${LB},${OMIT},MANTLE_CPATCH`,
  `${LB},${OMIT},MANTLE_CPATCH,MANTLE_CPATCH_HULLVAR,MANTLE_CPATCH_SEAM_HARD|${LB},${OMIT},MANTLE_CPATCH,MANTLE_CPATCH_SEAM_HARD`,
  // The same sets with the define present on both sides, so an arm that still read it would show.
  `${LB},MANTLE_CPATCH,MANTLE_CPATCH_HULLVAR`,
  `${LB},MANTLE_CPATCH,MANTLE_CPATCH_HULLVAR,MANTLE_CPATCH_SEAM_HARD`,
];

function pre(file, defs) {
  const src = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#\s*(version|extension|pragma)\b/.test(l))
    .join('\n');
  const head = defs
    .filter(Boolean)
    .map((d) => `#define ${d} 1`)
    .join('\n');
  // From a file, under a time cap: a stdin-fed `clang -E` has hung whole runs (test/_glslMainEmu clangPreprocess).
  const r = clangPreprocess(head + '\n' + src, ['-P', '-x', 'c']);
  if (r.status !== 0) throw new Error(`clang failed on ${file}: ${r.stderr.slice(0, 400)}`);
  return r.stdout.replace(/[ \t]+$/gm, '').replace(/\n{2,}/g, '\n');
}

const gen = (root) => path.join(root, 'src/shaders/generated');
const files = readdirSync(gen(baseRoot))
  .filter((f) => f.endsWith('.glsl'))
  .sort();
let checked = 0,
  differ = 0;
for (const f of files) {
  const text = readFileSync(path.join(gen(baseRoot), f), 'utf8');
  // Only the shaders a CPatch or Loop-Blinn define can reach; the rest are checked under no defines.
  const sets = /MANTLE_CPATCH|MANTLE_LB_FILL/.test(text) ? SETS : [''];
  for (const set of sets) {
    const [a, b = a] = set.split('|');
    const A = pre(path.join(gen(baseRoot), f), a.split(','));
    const B = pre(path.join(gen(headRoot), f), b.split(','));
    checked++;
    if (A !== B) {
      differ++;
      const al = A.split('\n'),
        bl = B.split('\n');
      let i = 0;
      while (i < al.length && al[i] === bl[i]) i++;
      console.log(
        `DIFF ${f} [${set || 'no defines'}] at line ${i}:\n  base: ${al[i]}\n  head: ${bl[i]}`,
      );
    }
  }
}
console.log(`\n${checked} (file, define set) pairs preprocessed, ${differ} differ`);
process.exit(differ ? 1 : 0);

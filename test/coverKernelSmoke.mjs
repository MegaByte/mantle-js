// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Check that engine-ledger kernel labels match the shader selection defines,
// including fallback to a base program while a variant is warming.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  ENGINES,
  coverKernelOfVariantKey,
  engineOfVariantKey,
} from '../src/renderer/engineLedger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(path.join(ROOT, 'src/shaders/mantle.frag.glsl'), 'utf8').split('\n');

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

// The selection block: the `#if` that opens the MIXED chain, through its matching #endif.
// MANTLE_COVER_KERNEL is a second way into the same chain (the id comes off the cover vertex rather
// than the meta row), so the opener is that one `#if` whichever spelling turned it on.
const starts = lines
  .map((l, i) =>
    /^\s*#\s*if\s+defined\(MANTLE_HARD_MIXED\)(\s*\|\|\s*defined\(MANTLE_COVER_KERNEL\))?\s*$/.test(
      l,
    )
      ? i
      : -1,
  )
  .filter((i) => i >= 0);
ok(starts.length === 1, `one kernel selection block in mantle.frag.glsl (found ${starts.length})`);
if (starts.length !== 1) {
  console.log('\nCOVER-KERNEL FAIL');
  process.exit(1);
}

function truth(expr, defs) {
  const js = expr.replace(/defined\s*\(\s*(\w+)\s*\)/g, (_, n) => (defs.has(n) ? 'true' : 'false'));
  if (!/^(?:\s|[()!]|&&|\|\||true|false)*$/.test(js))
    throw new Error('unsupported #if expression: ' + expr);
  return Function('return (' + js + ');')();
}

/** The renderFill* calls the preprocessor keeps in the selection block for this define set, sorted. */
function keptKernels(defs) {
  const stack = [];
  let active = true;
  const kept = new Set();
  const open = (c) => {
    stack.push({ parent: active, taken: c });
    active = active && c;
  };
  for (let i = starts[0]; i < lines.length; i++) {
    const line = lines[i].replace(/\/\/.*$/, '');
    let m;
    if ((m = line.match(/^\s*#\s*if\s+(.+)$/))) open(truth(m[1], defs));
    else if ((m = line.match(/^\s*#\s*ifdef\s+(\w+)/))) open(defs.has(m[1]));
    else if ((m = line.match(/^\s*#\s*ifndef\s+(\w+)/))) open(!defs.has(m[1]));
    else if ((m = line.match(/^\s*#\s*elif\s+(.+)$/))) {
      const top = stack[stack.length - 1];
      const c = !top.taken && truth(m[1], defs);
      active = top.parent && c;
      top.taken = top.taken || c;
    } else if (/^\s*#\s*else\b/.test(line)) {
      const top = stack[stack.length - 1];
      active = top.parent && !top.taken;
      top.taken = true;
    } else if (/^\s*#\s*endif\b/.test(line)) {
      active = stack.pop().parent;
      if (!stack.length) return [...kept].sort();
    } else if (active) {
      for (const k of line.matchAll(/\b(renderFill\w*)\s*\(/g)) kept.add(k[1]);
    }
  }
  throw new Error('kernel selection block has no matching #endif');
}

// [defines, the renderFill* functions the chain keeps, the engine the engine ledger names]
const CASES = [
  [[], ['renderFill'], ENGINES.SLUG],
  [['MANTLE_AAC'], ['renderFillAAC'], ENGINES.AAC],
  [['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'], ['renderFillAAC'], ENGINES.AAC],
  // the rotated footprint only in a program for a draw whose map is not axis-aligned
  [['MANTLE_ROTATED_MAP'], ['renderFillM'], ENGINES.SLUG],
  [
    ['MANTLE_HARD_MIXED', 'MANTLE_GWN', 'MANTLE_ROTATED_MAP'],
    ['renderFillHardBand', 'renderFillM'],
    ENGINES.HARD_MIXED,
  ],
  [['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS', 'MANTLE_ROTATED_MAP'], ['renderFillAACM'], ENGINES.AAC],
  [
    ['MANTLE_HARD_MIXED', 'MANTLE_GWN', 'MANTLE_AAC', 'MANTLE_ROTATED_MAP'],
    ['renderFillAACM', 'renderFillHardBand'],
    ENGINES.HARD_MIXED_AAC,
  ],
  [['MANTLE_HARD', 'MANTLE_GWN'], ['renderFillHardBand'], ENGINES.HARD_BAND],
  [['MANTLE_HARD', 'MANTLE_HARD_TREE', 'MANTLE_GWN'], ['renderFillGWNSDF'], ENGINES.HARD_TREE],
  [['MANTLE_HARD_MIXED', 'MANTLE_GWN'], ['renderFill', 'renderFillHardBand'], ENGINES.HARD_MIXED],
  [
    ['MANTLE_HARD_MIXED', 'MANTLE_GWN', 'MANTLE_AAC'],
    ['renderFillAAC', 'renderFillHardBand'],
    ENGINES.HARD_MIXED_AAC,
  ],
  [
    ['MANTLE_HARD_MIXED', 'MANTLE_GWN', 'MANTLE_HARD_TREE'],
    ['renderFill', 'renderFillGWNSDF', 'renderFillHardBand'],
    ENGINES.HARD_MIXED,
  ],
  [['MANTLE_GWN'], ['renderFillGWNSDF'], ENGINES.GWN],
  [['MANTLE_GWN', 'MANTLE_GWN_SDF'], ['renderFillGWNSDF'], ENGINES.GWN],
  [['MANTLE_GWN', 'MANTLE_AAC'], ['renderFillGWNSDF'], ENGINES.GWN],
  [['MANTLE_HARD', 'MANTLE_AAC'], ['renderFillHardBand'], ENGINES.HARD_BAND],
  // The unified route's wire and recolor defines do not change which kernel shades a cover quad.
  [
    ['MANTLE_LB_FILL', 'MANTLE_LB_CURVE_TEX', 'MANTLE_AAC', 'MANTLE_NO_RECOLOR'],
    ['renderFillAAC'],
    ENGINES.AAC,
  ],
  [['MANTLE_CPATCH', 'MANTLE_LB_FILL'], ['renderFill'], ENGINES.SLUG],
  // The PER-ENTRY spelling of the mixed chain keeps exactly the same kernels as the per-shape
  // one, which is the point -- it moves where the ID comes from and nothing else. Same kernel set,
  // same engine-ledger entry, for each pairing.
  [
    ['MANTLE_COVER_KERNEL', 'MANTLE_LB_FILL', 'MANTLE_GWN'],
    ['renderFill', 'renderFillHardBand'],
    ENGINES.HARD_MIXED,
  ],
  [
    ['MANTLE_COVER_KERNEL', 'MANTLE_LB_FILL', 'MANTLE_GWN', 'MANTLE_AAC'],
    ['renderFillAAC', 'renderFillHardBand'],
    ENGINES.HARD_MIXED_AAC,
  ],
  [
    ['MANTLE_COVER_KERNEL', 'MANTLE_LB_FILL', 'MANTLE_GWN', 'MANTLE_HARD_TREE'],
    ['renderFill', 'renderFillGWNSDF', 'renderFillHardBand'],
    ENGINES.HARD_MIXED,
  ],
];

for (const [defs, kernels, engine] of CASES) {
  const key = defs.slice().sort().join('|'); // fillPass definesKey
  const name = key || 'base';
  const kept = keptKernels(new Set(defs));
  ok(
    kept.join() === kernels.join(),
    `[${name}] the shader keeps ${kernels.join(' + ')} (got ${kept.join(' + ') || 'none'})`,
  );
  const got = coverKernelOfVariantKey(key, false);
  ok(got === engine, `[${name}] the engine ledger names ${engine} (got ${got})`);
  // A link failure names the whole variant: the analytic engine when there is one, else its kernel.
  const whole = defs.includes('MANTLE_CPATCH')
    ? ENGINES.CPATCH
    : defs.includes('MANTLE_LB_FILL')
      ? ENGINES.LB
      : engine;
  ok(
    engineOfVariantKey(key) === whole,
    `[${name}] engineOfVariantKey names ${whole} (got ${engineOfVariantKey(key)})`,
  );
}
ok(coverKernelOfVariantKey(null, false) === ENGINES.SLUG, 'no key (the default program) is Slug');
ok(
  coverKernelOfVariantKey('MANTLE_AAC', true) === ENGINES.INERT,
  'a bundle with no fill row reports inert whatever the program',
);

console.log(fail ? `\nCOVER-KERNEL FAIL (${fail})` : '\nCOVER-KERNEL PASS');
process.exit(fail ? 1 : 0);

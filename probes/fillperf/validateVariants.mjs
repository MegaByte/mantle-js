// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// validateVariants — compile the generated fill shaders under the define sets the renderer builds (and the pricing
// variants), with glslangValidator. A shader that fails to compile draws nothing on the GPU, silently; this catches it
// in node. Skips (exit 0) when glslangValidator is not installed.
//   node probes/fillperf/validateVariants.mjs
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (spawnSync('glslangValidator', ['--version']).status !== 0) {
  console.log('SKIP validateVariants: no glslangValidator');
  process.exit(0);
}
const SETS = [
  [],
  ['MANTLE_AAC'],
  ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'],
  ['MANTLE_HARD', 'MANTLE_GWN'],
  ['MANTLE_HARD', 'MANTLE_HARD_TREE', 'MANTLE_GWN'],
  ['MANTLE_HARD_MIXED', 'MANTLE_GWN'],
  ['MANTLE_HARD_MIXED', 'MANTLE_GWN', 'MANTLE_AAC'],
  ['MANTLE_GWN'],
  ['MANTLE_GWN', 'MANTLE_GWN_SDF'],
  ['MANTLE_AAC', 'MANTLE_NO_CUBIC', 'MANTLE_NO_ARC'],
  ['MANTLE_AAC', 'MANTLE_NO_LINE', 'MANTLE_NO_QUAD'],
  ['MANTLE_NO_CUBIC', 'MANTLE_NO_ARC'],
  ['MANTLE_CPATCH', 'MANTLE_LB_FILL'],
  ['MANTLE_COVER_KERNEL', 'MANTLE_GWN', 'MANTLE_LB_FILL'],
  ['MANTLE_LB_FILL', 'MANTLE_LB_CURVE_TEX', 'MANTLE_AAC', 'MANTLE_NO_RECOLOR'],
  // the rotated-map variants: a draw whose em -> pixel map is not axis-aligned
  ['MANTLE_ROTATED_MAP'],
  ['MANTLE_AAC', 'MANTLE_ROTATED_MAP'],
  ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS', 'MANTLE_ROTATED_MAP'],
  ['MANTLE_HARD_MIXED', 'MANTLE_GWN', 'MANTLE_AAC', 'MANTLE_ROTATED_MAP'],
  // a GWN+SDF program under a rotated map (the renderer adds the define to any engine's draw)
  ['MANTLE_GWN', 'MANTLE_GWN_SDF', 'MANTLE_ROTATED_MAP'],
  // the default programs of a pair-band bundle (renderFill is the exact walk, which reads the layout)
  ['MANTLE_AAC_PAIR_BANDS'],
  ['MANTLE_AAC_PAIR_BANDS', 'MANTLE_ROTATED_MAP'],
  ['MANTLE_AAC_PAIR_BANDS', 'MANTLE_NO_CUBIC', 'MANTLE_NO_ARC'],
];
const dir = mkdtempSync(path.join(os.tmpdir(), 'mantle-validate-'));
let fail = 0,
  n = 0;
function check(file, stage, defs) {
  const text = readFileSync(path.join(ROOT, 'src/shaders/generated', file), 'utf8');
  const nl = text.indexOf('\n');
  const src =
    text.slice(0, nl + 1) + defs.map((d) => `#define ${d}\n`).join('') + text.slice(nl + 1);
  const f = path.join(dir, 'v.' + stage);
  writeFileSync(f, src);
  const r = spawnSync('glslangValidator', ['-S', stage, f], { encoding: 'utf8' });
  n++;
  if (r.status !== 0) {
    fail++;
    console.log(
      `FAIL ${file} [${defs}]\n${(r.stdout || '')
        .split('\n')
        .filter((l) => /ERROR/.test(l))
        .slice(0, 4)
        .join('\n')}`,
    );
  }
}
for (const defs of SETS) {
  check('mantle.frag.glsl', 'frag', defs);
  check('maskBake.frag.glsl', 'frag', defs);
}
check('aacPoints.vert.glsl', 'vert', []);
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `VALIDATE FAIL ${fail} of ${n}` : `VALIDATE PASS (${n} compiles)`);
process.exit(fail ? 1 : 0);

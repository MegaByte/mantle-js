#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Development diagnostics for shader emulations and test-only models.
// Run explicitly with npm run diagnose:accuracy; --fused selects fused arithmetic.
// These checks do not gate CPU validation, physical-GPU validation or publishing.
import { ACCURACY_DIAGNOSTICS } from './accuracyDiagnostics.mjs';
import { runNodeChecks } from './runNodeChecks.mjs';
// The lane takes about an hour end to end; `--part=K/N` runs the K-th of N contiguous slices (1-based) so a scheduler can batch it:
// node scripts/runAccuracyDiagnostics.mjs --part=2/6. The slices partition the list, so running all N is the whole lane.
const args = process.argv.slice(2),
  fused = args.includes('--fused');
const partArg = args.find((a) => a.startsWith('--part='));
const part = partArg ? /^--part=(\d+)\/(\d+)$/.exec(partArg) : null;
if (partArg && (!part || +part[1] < 1 || +part[1] > +part[2])) {
  console.error('usage: --part=K/N with 1 <= K <= N');
  process.exit(1);
}
const filters = args.filter((a) => a !== '--fused' && a !== '--list' && !a.startsWith('--part='));
let selected = filters.length
  ? ACCURACY_DIAGNOSTICS.filter((f) =>
      filters.some((s) => f.toLowerCase().includes(s.toLowerCase())),
    )
  : ACCURACY_DIAGNOSTICS;
if (part) {
  const k = +part[1],
    n = +part[2],
    size = Math.ceil(selected.length / n);
  selected = selected.slice((k - 1) * size, k * size);
}
if (!selected.length) {
  console.error('No accuracy diagnostic matches', filters);
  process.exit(1);
}
console.log(
  'Development accuracy diagnostics: ' + selected.length + (fused ? ' (fused emulators)' : ''),
);
if (args.includes('--list')) {
  for (const f of selected) console.log('  ' + f);
} else
  process.exit(
    await runNodeChecks(selected, {
      label: 'ACCURACY-DIAGNOSTICS',
      env: { MANTLE_GPU_CARE: '0', ...process.env, MANTLE_EMU_FMA: fused ? '1' : '0' },
    }),
  );

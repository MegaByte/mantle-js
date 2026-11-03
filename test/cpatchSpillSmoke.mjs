// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchSpillSmoke — NO PATCH PAINTS OUTSIDE ITS CONTOUR, over a corpus, with a stated bound.
//
// THE PROPERTY. A CPatch decomposition covers a shape with patches whose union must be the shape.
// The half that is easy to see is MISS -- interior nobody paints, which shows up as a hole.
// The other half is SPILL -- area the union paints that the contour does not cover -- and it is the
// one that hides, because a patch spilling into a NEIGHBOURING patch's interior changes no pixel,
// and a patch spilling into background is a thin rind that reads as an AA difference. It is real:
// the hull-row gate exists precisely because patches spill without it.
//
// WHY this IS A WRAPPER AND NOT A NEW MODEL. probes/cpatchGate/_rowGateSpill.mjs measures exactly
// this, under the CPU kernel model (cpatchCov.patchCoverage, which composes _cpatchCoverage.glsl
// term for term), and it is CALIBRATED: --selftest checks that the arms are monotone (a hull row is
// a min(), so fencing can only remove ink), that an AA-free hard count is a lower bound on the
// model, that halving the grid does not move the answer, and that the same arm twice is
// bit-identical. Rewriting that model here would be a second, uncalibrated copy of it, and the
// first thing to go stale. So the smoke RUNS the probe and asserts on its JSON. Its sibling
// _rowGateAaRef.mjs measures the AA band against an exact reference; that is a different
// instrument (this one is deliberately blind to the half-pixel band) and is not wrapped here.
//
// WHAT IT CATCHES. A packer or kernel change that lets a patch paint past its contour: the gate
// arm's spill leaves zero. It also catches the measurement going soft -- the `none` arm must still
// spill a lot, because a corpus whose patches cannot spill even unfenced proves nothing about a
// bound of zero, and the probe's own selftest must still report no ordering failure.
//
// THE CORPUS is in-tree (examples/smoke/), so this runs in a fresh checkout: 400 glyph shapes,
// which is where the unfenced spill lives, plus one 400-cubic star that decomposes into 301
// patches. Not tiger -- that is a fetched asset, and this must not depend on the network.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// px^2 with the shape laid out across 512 px, the scale _rowGateSpill reports at.
//
// On this corpus at N=96: gate 0.00, all 0.00, none 2862.41 px^2. The bound is
// not zero because the model is known to over-report a sharp tip by a sample or two (cpatchCov:
// three pixels on tiger's per-shape sweep that the GPU does not paint), and one sample stands for
// (1.3 * 512 / 96)^2 = 48 px^2 -- so a single spurious sample would blow a bound of zero. The bar
// below is under one sample and 700x under what the unfenced arm spills: it is a bound that a real
// defect cannot slip through and a quadrature wobble cannot trip.
const BOUND_SHAPE = 24; // px^2, worst single shape
const BOUND_TOTAL = 48; // px^2, whole corpus (one sample's worth)
const BITES_AT_LEAST = 500; // px^2 the UNFENCED arm must still spill, or the corpus proves nothing

const CORPUS = [
  'examples/smoke/lbMemBudget__SVG.svg', // 400 glyph shapes
  'examples/smoke/engineDeclineIsolation__STAR.svg', // one 400-cubic star, 301 patches
];

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mantle-cpatch-spill-'));
const outFile = path.join(tmp, 'spill.json');
let rows = null,
  stdout = '';
try {
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, 'probes/cpatchGate/_rowGateSpill.mjs'), '--selftest', '--noarea', ...CORPUS],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 600000,
      env: { ...process.env, OUT: outFile, N: '96', ARMS: 'none,gate,all' },
    },
  );
  stdout = (r.stdout || '') + (r.stderr || '');
  ok(
    r.status === 0,
    `_rowGateSpill ran (exit ${r.status === null ? 'signal ' + r.signal : r.status})`,
  );
  if (r.status === 0) rows = JSON.parse(readFileSync(outFile, 'utf8'));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (!rows) {
  console.error(stdout.split('\n').slice(-20).join('\n'));
  console.log('FAIL cpatchSpillSmoke: the probe produced no measurement');
  process.exit(1);
}

const withPatches = rows.filter((r) => r.patches > 0 && r.arms && r.arms.gate);
ok(
  withPatches.length >= 300,
  `${withPatches.length} shapes decomposed into patches (${rows.length} rows)`,
);

// ── the property: the shipped row set spills nothing past the contour ─────────────────────────
let total = 0,
  worst = null;
for (const r of withPatches) {
  const s = r.arms.gate.spill;
  total += s;
  if (!worst || s > worst.arms.gate.spill) worst = r;
}
const name = (r) => `${r.file.split('/').pop()} #${r.shape}`;
ok(
  worst && worst.arms.gate.spill <= BOUND_SHAPE,
  `no shape paints more than ${BOUND_SHAPE} px^2 outside its contour ` +
    `(worst ${name(worst)}: ${worst.arms.gate.spill.toFixed(3)} px^2 over ${worst.patches} patches)`,
);
ok(
  total <= BOUND_TOTAL,
  `the corpus paints ${total.toFixed(3)} px^2 outside its contours in total (bound ${BOUND_TOTAL})`,
);

// ── the measurement is still able to see a spill ──────────────────────────────────────────────
const sum = (arm) => withPatches.reduce((t, r) => t + (r.arms[arm] ? r.arms[arm].spill : 0), 0);
const none = sum('none');
ok(
  none >= BITES_AT_LEAST,
  `unfenced, the same corpus spills ${none.toFixed(2)} px^2 — the bound above is measuring ` +
    `something (bar ${BITES_AT_LEAST})`,
);

// ── the probe's own calibration still holds ───────────────────────────────────────────────────
// A hull row is a min() of a half-plane's coverage, so fencing more patches can only take ink
// away: none >= gate >= all, on every shape. Any other order means the arms are not what they say.
let nonMono = 0,
  firstMono = null;
for (const r of withPatches) {
  const { none: n, gate: g, all: a } = r.arms;
  if (!n || !g || !a) continue;
  if (!(n.spill >= g.spill - 1e-9 && g.spill >= a.spill - 1e-9)) {
    nonMono++;
    if (!firstMono)
      firstMono = `${name(r)}: none ${n.spill.toFixed(3)} gate ${g.spill.toFixed(3)} all ${a.spill.toFixed(3)}`;
  }
}
ok(
  nonMono === 0,
  `spill is monotone in the row set on every shape (none >= gate >= all)` +
    (firstMono ? ` — first: ${firstMono}` : ''),
);

// The AA-free count (a point is painted only when ONE patch admits it outright) is a lower bound
// on the model, which unions partial coverages; they must not cross.
let crossed = 0;
for (const r of withPatches) if (r.hard && r.hard.spill > r.arms.gate.spill + 1e-9) crossed++;
ok(crossed === 0, `the AA-free hard count stays at or under the model on every shape`);

// ...and the probe says so itself.
const line = stdout.split('\n').find((l) => l.startsWith('selftest:'));
ok(
  !!line && /^selftest: 0 /.test(line),
  `the probe's selftest reports no failure (${line || 'no selftest line'})`,
);

console.log(fail ? `FAIL cpatchSpillSmoke: ${fail} check(s)` : 'PASS cpatchSpillSmoke');
process.exit(fail ? 1 : 0);

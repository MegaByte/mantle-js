// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/lbHitTestInvariants.mjs — four Loop-Blinn and hit-test performance invariants, re-derived from
// the source at run time.
//
//   node probes/perf/lbHitTestInvariants.mjs
//
// A performance decision is a liability if nothing re-checks it: the code it names can be reverted by a
// merge and its guard can be deleted. Every claim below is re-derived from the source, and the one that
// has a guard has that guard MUTATION-CHECKED — turning the rule off must turn the smoke red, or the smoke
// is decoration.
//
// ── WHAT each CLAIMS, AND WHAT IS CHECKED ───────────────────────────────────────────────────
//
// THE HULL-REJECT CLUSTER — 1191 -> 900 ms on tiger, 1.32x. The control-hull ray reject, squared
//       distances in the split-plan and containment samplers, a bbox reject in inFace9, and no
//       `onArc9`, which nothing called.
//       CHECKED: the reject and inFace9 are present, and `onArc9` is gone.
//
// CONTAINMENT SPLITTING. `__LB_HULL_CONTAIN` off is SLOWER (1556 vs 1127 ms) and loses 96 meshes —
//       declining costs more than meshing, so containment splitting pays for itself twice. A
//       "19.9 s of 21.5 s" reading of it is a measurement artifact.
//       CHECKED: containment splitting is unconditional -- there is no switch -- so the
//       measured-good configuration is the only one.
//
// NO HULL REJECT IN THE HIT TEST — measured, not worth taking. The same control-hull reject applied
//       to `src/hitTest/fillCoverage.js` is output-identical over 280,000 cases and measures 1.02x
//       (noise) at 110 segments and 0.99x — SLOWER — at 591 segments, because the y-hull cull
//       already rejects with two comparisons and the x-cull only sees segments spanning the
//       query row.
//       CHECKED: it is NOT in fillCoverage.js.
//
// RELATIVE HULL SLACK. A convex combination is not exact in floating point, so a control x equal to
//       the query x rounds a few ulps above it, and an exact `x > px` counts a crossing the reject
//       deletes: 741 mismatches over 200,000 hit-test cases, 25,305 over 2.4M degenerate
//       `raySegCross` cases including 1-2 ulps BELOW the ray — so a strict comparison is not
//       enough either. The reject carries slack RELATIVE to the magnitudes fed to the arithmetic
//       (`HULL_REL = 1e-12`), no absolute epsilon.
//       CHECKED: HULL_REL exists, is relative, has that value — and the guard
//       (test/lbHullRejectDegenerateSmoke.mjs) is mutation-checked below.
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');
let bad = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`);
  if (!c) bad++;
};

const src = (p) => readFileSync(path.join(JS, p), 'utf8');

console.log('\n== the hull-reject cluster is present ==');
{
  const part = src('src/renderer/lbPartition.js');
  const cub = src('src/geom/lbCubicMath.js');
  const cont = src('src/geom/lbContour.js');
  ok(!/\bonArc9\s*\(/.test(part + cub + cont), 'onArc9 is gone (nothing called it)');
  ok(
    /hull/i.test(cont) && /HULL_REL/.test(cont),
    'the control-hull ray reject is present in lbContour',
  );
  ok(/inFace9/.test(part), 'inFace9 is present');
  console.log(
    '  (squared-distance sampling and the bbox reject are timing claims: 1191 -> 900 ms on',
  );
  console.log('   tiger. This checks the code is present, not the time.)');
}

console.log('\n== containment splitting always runs ==');
{
  const part = src('src/renderer/lbPartition.js');
  ok(
    !/__LB_HULL_CONTAIN/.test(part),
    'no switch turns it off, so the configuration measured FASTER is the only one',
  );
  ok(
    /partitionCubicSplitTs\(P0, others9\)/.test(part),
    '...and the split plan is handed the sampled boundary (others9), not skipped, which would ship the 1556 ms arm',
  );
}

console.log('\n== the hit test carries no hull reject ==');
{
  const fc = src('src/hitTest/fillCoverage.js');
  ok(!/HULL_REL/.test(fc), 'no relative hull slack in fillCoverage.js');
  ok(!/hull\s*reject|hullReject/i.test(fc), 'no hull reject in fillCoverage.js');
  console.log('  It is output-identical over 280,000 cases and measures 1.02x and 0.99x, so it is');
  console.log('  not worth taking. A rejected optimization stays rejected only while the code');
  console.log('  stays out.');
}

console.log('\n== the hull slack is relative, has its value, and the guard really guards ==');
{
  const cont = src('src/geom/lbContour.js');
  const m = /const HULL_REL = ([0-9eE.+-]+);/.exec(cont);
  ok(!!m, 'HULL_REL is declared');
  ok(m && Number(m[1]) === 1e-12, `HULL_REL is 1e-12 (${m && m[1]})`);
  ok(
    /HULL_REL \* Math\.max\(/.test(cont),
    'it scales by Math.max of the magnitudes fed to the arithmetic — RELATIVE, not absolute',
  );
  ok(!/HULL_REL \* 1\b|HULL_REL;\s*\/\/ absolute/.test(cont), 'no absolute use of it');
}

console.log('\n== mutation check — turning the slack off must turn the smoke red ==');
{
  const p = path.join(JS, 'src/geom/lbContour.js');
  const orig = readFileSync(p, 'utf8');
  const smoke = path.join(JS, 'test/lbHullRejectDegenerateSmoke.mjs');
  const run = () => {
    try {
      execFileSync(process.execPath, [smoke], { cwd: JS, stdio: 'ignore' });
      return 0;
    } catch (e) {
      return e.status == null ? -1 : e.status;
    }
  };
  const before = run();
  ok(before === 0, `the guard passes on this tree (exit ${before})`);
  try {
    writeFileSync(p, orig.replace(/const HULL_REL = 1e-12;/, 'const HULL_REL = 0;'));
    const mutated = run();
    ok(mutated !== 0, `with HULL_REL = 0 the guard FAILS (exit ${mutated}) — it is not decoration`);
  } finally {
    writeFileSync(p, orig);
  }
  // this PROBE EDITS A SOURCE FILE, so it has to prove it put it back — byte for byte, not
  // "the smoke passes again". A restore that silently lost a byte would leave a working tree
  // nobody thinks to check, and the next commit would carry it.
  ok(readFileSync(p, 'utf8') === orig, 'lbContour.js is restored byte for byte');
  const after = run();
  ok(after === 0, `...and the guard passes again (exit ${after})`);
}

console.log(bad ? `\nFAIL (${bad})` : '\nPASS — all four invariants hold');
process.exit(bad ? 1 : 0);

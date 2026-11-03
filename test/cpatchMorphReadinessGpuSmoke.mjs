// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphReadinessGpuSmoke — CPatch preparation of morph handles on the physical GPU, through
// probes/analyticArea/gpu.mjs:
//   cpatchMorphReadiness            readiness is a CPatch contract even when the drawable is a
//                                   morph handle: the API and the first draw (not CPatch's accuracy)
//   cpatchRationalMorph             native-only preparation declines rational morphs without
//                                   changing raw coverage
//   cpatchMorphCertifiedFallback    declining unproved CPatch preparation preserves actual raw AAC
//                                   morph draws
// The last two fixtures share every probe option (an AAC-initial renderer), so their cases run in
// one probe launch; the readiness fixture needs a renderer without the AAC fill and runs in its own.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  dir = mkdtempSync(path.join(tmpdir(), 'mantle-cpatch-morph-'));
const fixture = (name) => JSON.parse(readFileSync(path.join(root, 'test/fixtures', name)));

// Run one probe input; `budget` is the probe's wall cap (ms) for the cases it carries.
function probe(tag, config, env, budget) {
  const input = path.join(dir, tag + '-input.json'),
    output = path.join(dir, tag + '-output.json');
  writeFileSync(input, JSON.stringify(config));
  execFileSync(process.execPath, [path.join(root, 'probes/analyticArea/gpu.mjs'), input, output], {
    cwd: root,
    env: {
      ...process.env,
      ...env,
      MANTLE_GPU_BURST_MS: '40',
      MANTLE_GPU_WALL_MS: String(budget),
    },
    timeout: budget + 10000,
    stdio: 'pipe',
  });
  return JSON.parse(readFileSync(output));
}

let failures = 0;
function check(name, run) {
  console.log(`\n-- ${name}`);
  const t0 = Date.now();
  try {
    run();
  } catch (e) {
    failures++;
    if (e.stdout) process.stderr.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    console.error(`FAIL ${name}: ${(e && e.stack) || e}`);
  }
  console.log(`   (${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---- cpatchMorphReadiness ------------------------------------------------------------------------
// Readiness is a CPatch contract even when the drawable is a morph handle.
// This guards the API and the first draw; it does not check CPatch's accuracy.
check('cpatchMorphReadiness', () => {
  const config = fixture('cpatch-morph-readiness.json');
  assert(config.productionShaders);
  const d = probe('readiness', config, {}, 60000);
  assert(d.finished && d.sourceStable && d.harnessStable);
  assert.equal(d.rows.length, 2);
  for (const row of d.rows) {
    for (const a of row.arms) {
      assert.equal(a.preparation.awaitEngineReady, true);
      assert.equal(
        a.preparation.lbMorphBuilt,
        false,
        'Awaiting CPatch must not start the LB pair build',
      );
      assert.equal(a.preparation.built, 2);
      assert(
        a.preparation.firstReadyPin.ledger.cpatch > 0,
        'The first draw after readiness must actually use CPatch',
      );
      assert(!a.preparation.firstReadyPin.ledger.lb && !a.preparation.firstReadyPin.ledger.slug);
      assert(a.morph.cpatchGpuBlend && a.morph.cpatchPlanReady);
      assert.equal(a.imageHash, a.finalImageHash);
      if (row.name === 'native-triangle')
        assert.equal(
          a.morph.cpatchNativeShapes,
          2,
          'actual worker/native plans serve both translucent paints',
        );
    }
    assert.equal(row.arms[0].imageHash, row.arms[1].imageHash);
  }
  console.log(
    'cpatchMorphReadiness PASS: successful await, first CPatch draw, no LB pair build, live pose restoration',
  );
});

// ---- the AAC-initial fixtures: one probe launch for both -------------------------------------------
// Independent disk/square integration. A fixed-angle quarter circle morph is
// exactly a quarter circle of radius 6+4t, with .51 opacity.
function primitive(x, r) {
  x = Math.max(0, Math.min(x, r));
  return 0.5 * (x * Math.sqrt(Math.max(0, r * r - x * x)) + r * r * Math.asin(x / r));
}
function area(x, y, r) {
  const a = Math.max(0, x - 8),
    b = Math.min(r, x + 1 - 8),
    lo = Math.max(0, y - 8),
    hi = y + 1 - 8;
  if (b <= a || hi <= lo || lo >= r) return 0;
  const full = hi < r ? Math.sqrt(Math.max(0, r * r - hi * hi)) : 0,
    end = Math.sqrt(Math.max(0, r * r - lo * lo)),
    e = Math.min(b, end),
    q = Math.max(a, full);
  return (
    0.51 *
    (Math.max(0, Math.min(b, full) - a) * (hi - lo) +
      (e > q ? primitive(e, r) - primitive(q, r) - lo * (e - q) : 0))
  );
}
let rational, certified, shared;
check('aac-initial probe', () => {
  rational = fixture('cpatch-rational-morph.json');
  for (const c of rational.cases.filter((c) => c.name.startsWith('quarter-scale'))) {
    c.samples = [];
    for (let x = 6; x < 20; x++)
      for (let y = 6; y < 20; y++) c.samples.push({ x, y, area: area(x, y, 6 + 4 * c.morphT) });
    c.captureReferencePixels = true;
    c.referencePixels = c.samples.map((s) => [s.x, s.y]);
  }
  const config = fixture('cpatch-morph-certified-fallback.json');
  assert(config.productionShaders && config.initialKernel === 'aac');
  certified = config;
  // One launch serves both only while they ask for the same probe: every option but the cases.
  const { cases: rc, ...ro } = rational,
    { cases: cc, ...co } = certified;
  assert.deepEqual(co, ro, 'the two fixtures no longer share their probe options');
  const names = new Set(rc.map((c) => c.name));
  assert(!cc.some((c) => names.has(c.name)), 'a case name is in both fixtures');
  const d = probe(
    'aac-initial',
    { ...ro, cases: rc.concat(cc) },
    { MANTLE_GPU_BASELINE_ROOT: '' },
    120000,
  );
  assert(d.finished && d.sourceStable && d.harnessStable);
  assert(!/software|swiftshader|llvmpipe/i.test(d.device.renderer));
  assert.equal(d.rows.length, rc.length + cc.length);
  shared = d;
});
const rowsOf = (config) => {
  const names = new Set(config.cases.map((c) => c.name));
  return shared.rows.filter((r) => names.has(r.name));
};

// ---- cpatchRationalMorph -------------------------------------------------------------------------
// Native-only preparation declines rational morphs without changing raw coverage.
check('cpatchRationalMorph', () => {
  assert(shared, 'the shared probe run did not complete');
  const d = { rows: rowsOf(rational) };
  assert.equal(d.rows.length, 4);
  for (const row of d.rows) {
    const cp = row.arms[0],
      raw = row.arms[1],
      p = cp.preparation;
    // A pair whose arc changes its sweep (the weight refusals) is declined before any plan: a control-point lerp cannot draw SVG's arc interpolation.
    const declinedEarly = row.name.includes('weight-refusal');
    assert.equal(p.pendingPlanState, declinedEarly ? null : 'pending');
    assert(p.pendingPin.ledger.aac > 0);
    assert(!p.pendingPin.ledger.lb && !p.pendingPin.ledger.cpatch && !p.pendingPin.ledger.slug);
    assert.equal(p.lbMorphBuilt, false);
    assert.equal(cp.imageHash, cp.finalImageHash);
    assert.equal(raw.imageHash, raw.finalImageHash);
    assert.equal(p.awaitEngineReady, false);
    assert.match(
      p.bail,
      declinedEarly
        ? /an arc a control-point lerp cannot draw/
        : /uncertified interval: native whole-interval certificate declined/,
    );
    assert(!cp.morph.cpatchPlanReady && !cp.morph.cpatchGpuBlend);
    assert(
      cp.pin.ledger.aac > 0 && !cp.pin.ledger.cpatch && !cp.pin.ledger.lb && !cp.pin.ledger.slug,
    );
    assert.equal(p.pendingMaxDelta, 0);
    assert.equal(cp.imageHash, raw.imageHash);
    assert.equal(row.comparisons[0].maxByte, 0);
    if (row.name.startsWith('quarter-scale')) {
      assert(p.pendingQuality.maxError * 255 <= 1);
      assert(cp.quality.maxError * 255 <= 1);
      assert(raw.quality.maxError * 255 <= 1);
      assert(row.comparisons[0].maxByte <= 1);
    }
  }
  console.log(
    'cpatchRationalMorph PASS: native-only rational refusal retains translucent early/late quarter coverage <=1 alpha byte and identical pending/raw AAC, including changed weights and pose restoration',
  );
});

// ---- cpatchMorphCertifiedFallback ----------------------------------------------------------------
// Declining unproved CPatch preparation preserves actual raw AAC morph draws.
check('cpatchMorphCertifiedFallback', () => {
  assert(shared, 'the shared probe run did not complete');
  const d = { rows: rowsOf(certified) };
  assert.equal(d.rows.length, 2);
  for (const row of d.rows) {
    const fallback = row.arms.find((a) => a.name === 'fallback'),
      raw = row.arms.find((a) => a.name === 'raw'),
      p = fallback.preparation;
    assert.equal(p.pendingPlanState, 'pending');
    assert(p.pendingPin.ledger.aac > 0);
    assert(!p.pendingPin.ledger.lb && !p.pendingPin.ledger.cpatch && !p.pendingPin.ledger.slug);
    assert(
      p.pendingQuality.maxError * 255 <= 1,
      'Translucent pending draw matches the independent area',
    );
    assert.equal(p.pendingMaxDelta, 0, 'Preparation leaves the already correct raw image intact');
    assert.equal(p.awaitEngineReady, false);
    assert.equal(p.lbMorphBuilt, false);
    assert.match(p.bail, /uncertified interval/);
    assert(!/over the .*budget/.test(p.bail));
    assert(!fallback.morph.cpatchPlanReady && !fallback.morph.cpatchGpuBlend);
    assert(
      fallback.pin.ledger.aac > 0 &&
        !fallback.pin.ledger.cpatch &&
        !fallback.pin.ledger.lb &&
        !fallback.pin.ledger.slug,
    );
    assert(fallback.quality.maxError * 255 <= 1);
    assert(raw.quality.maxError * 255 <= 1);
    assert.equal(fallback.imageHash, raw.imageHash);
    assert.equal(fallback.imageHash, fallback.finalImageHash);
    assert.equal(row.comparisons.find((x) => x.arm === 'raw').maxByte, 0);
  }
  console.log(
    'cpatchMorphCertifiedFallback PASS: pending AAC, rejected uncertified plans, translucent early/late area <=1 byte, identical raw fallback and pose restoration',
  );
});

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\ncpatchMorphReadinessGpuSmoke PASS');

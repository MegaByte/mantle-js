// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Native-only preparation declines rational morphs without changing raw coverage.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const dir = mkdtempSync(path.join(tmpdir(), 'mantle-cpatch-rational-'));
try {
  const config = JSON.parse(
    readFileSync(path.join(root, 'test/fixtures/cpatch-rational-morph.json')),
  );
  for (const c of config.cases.filter((c) => c.name.startsWith('quarter-scale'))) {
    c.samples = [];
    for (let x = 6; x < 20; x++)
      for (let y = 6; y < 20; y++) c.samples.push({ x, y, area: area(x, y, 6 + 4 * c.morphT) });
    c.captureReferencePixels = true;
    c.referencePixels = c.samples.map((s) => [s.x, s.y]);
  }
  const input = path.join(dir, 'input.json'),
    output = path.join(dir, 'output.json');
  writeFileSync(input, JSON.stringify(config));
  execFileSync(process.execPath, [path.join(root, 'probes/analyticArea/gpu.mjs'), input, output], {
    cwd: root,
    env: {
      ...process.env,
      MANTLE_GPU_BASELINE_ROOT: '',
      MANTLE_GPU_BURST_MS: '40',
      MANTLE_GPU_WALL_MS: '60000',
    },
    timeout: 70000,
    stdio: 'pipe',
  });
  const d = JSON.parse(readFileSync(output));
  assert(d.finished && d.sourceStable && d.harnessStable);
  assert(!/software|swiftshader|llvmpipe/i.test(d.device.renderer));
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
    'cpatchRationalMorphGpuSmoke PASS: native-only rational refusal retains translucent early/late quarter coverage <=1 alpha byte and identical pending/raw AAC, including changed weights and pose restoration',
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

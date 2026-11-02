// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Declining unproved CPatch preparation preserves actual raw AAC morph draws.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  dir = mkdtempSync(path.join(tmpdir(), 'mantle-cpatch-certified-'));
try {
  const config = JSON.parse(
    readFileSync(path.join(root, 'test/fixtures/cpatch-morph-certified-fallback.json')),
  );
  assert(config.productionShaders && config.initialKernel === 'aac');
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
    'cpatchMorphCertifiedFallbackGpuSmoke PASS: pending AAC, rejected uncertified plans, translucent early/late area <=1 byte, identical raw fallback and pose restoration',
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

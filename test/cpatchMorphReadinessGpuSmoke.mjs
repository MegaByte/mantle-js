// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Readiness is a CPatch contract even when the drawable is a morph handle.
// This guards the API and the first draw; it does not check CPatch's accuracy.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  dir = mkdtempSync(path.join(tmpdir(), 'mantle-cpatch-ready-'));
try {
  const config = JSON.parse(
    readFileSync(path.join(root, 'test/fixtures/cpatch-morph-readiness.json')),
  );
  assert(config.productionShaders);
  const input = path.join(dir, 'input.json'),
    output = path.join(dir, 'output.json');
  writeFileSync(input, JSON.stringify(config));
  execFileSync(process.execPath, [path.join(root, 'probes/analyticArea/gpu.mjs'), input, output], {
    cwd: root,
    env: { ...process.env, MANTLE_GPU_BURST_MS: '40', MANTLE_GPU_WALL_MS: '60000' },
    timeout: 70000,
    stdio: 'pipe',
  });
  const d = JSON.parse(readFileSync(output));
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
    'cpatchMorphReadinessGpuSmoke PASS: successful await, first CPatch draw, no LB pair build, live pose restoration',
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

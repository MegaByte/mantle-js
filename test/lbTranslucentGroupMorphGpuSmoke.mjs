// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Group markers are structural rows. Check actual analytic morph draws, nested
// isolation and changing opacity against an authored pose and independent OVER.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  dir = mkdtempSync(path.join(tmpdir(), 'mantle-lb-group-morph-'));
try {
  const cfg = JSON.parse(
    readFileSync(path.join(root, 'test/fixtures/lb-translucent-group-morph.json')),
  );
  assert(cfg.productionShaders);
  const input = path.join(dir, 'input.json'),
    output = path.join(dir, 'output.json');
  writeFileSync(input, JSON.stringify(cfg));
  execFileSync(process.execPath, [path.join(root, 'probes/analyticArea/gpu.mjs'), input, output], {
    cwd: root,
    env: { ...process.env, MANTLE_GPU_BURST_MS: '40', MANTLE_GPU_WALL_MS: '60000' },
    timeout: 70000,
    stdio: 'pipe',
  });
  if (process.env.MANTLE_GPU_REPORT_DIR) {
    mkdirSync(process.env.MANTLE_GPU_REPORT_DIR, { recursive: true });
    copyFileSync(
      output,
      path.join(process.env.MANTLE_GPU_REPORT_DIR, 'lb-translucent-group-morph.json'),
    );
  }
  const d = JSON.parse(readFileSync(output));
  assert(d.finished && d.sourceStable && d.harnessStable);
  for (const row of d.rows) {
    const a = Object.fromEntries(row.arms.map((x) => [x.name, x]));
    for (const [name, engine] of [
      ['lbGpu', 'lb'],
      ['lbAA', 'lb'],
      ['lbCpu', 'lb'],
      ['cpGpu', 'cpatch'],
      ['cpAA', 'cpatch'],
      ['slugGpu', 'slug'],
      ['slugCpu', 'slug'],
      ['aacGpu', 'aac'],
      ['aacCpu', 'aac'],
    ]) {
      const arm = a[name];
      assert(arm.pin.ledger[engine] > 0, row.name + ' ' + name + ' real analytic draw');
      if (engine === 'lb' || engine === 'cpatch') {
        assert(arm.preparation.awaitEngineReady);
        assert(!arm.pin.ledger.slug, 'structural group rows do not credit Slug');
      }
      assert(arm.morph.matched > 0);
      assert.equal(arm.morph.usesGpuCurveLerp, !name.endsWith('Cpu'));
      assert(arm.morph.poseUpdatesInTiming);
      assert.equal(arm.imageHash, arm.finalImageHash);
      assert(arm.colorQuality.maxByte <= 1, row.name + ' ' + name + ' independent OVER');
    }
    assert.equal(a.lbGpu.imageHash, a.lbAA.imageHash);
    assert.equal(a.cpGpu.imageHash, a.cpAA.imageHash);
    for (const q of row.comparisons)
      assert(q.maxByte <= 1, row.name + ' ' + q.arm + ' full RGBA vs authored current pose');
  }
  console.log(
    'lbTranslucentGroupMorphGpuSmoke PASS: actual LB/Slug/AAC GPU/CPU and CPatch morph draws, nested overlapping translucent groups, changing opacity, early/late poses, independent OVER and authored-pose RGBA',
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

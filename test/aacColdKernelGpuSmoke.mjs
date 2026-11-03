// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// A cold runtime AAC request must draw AAC with the required affine footprint.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(path.join(root, 'test/fixtures/aac-cold-kernel.json')));
const dir = mkdtempSync(path.join(tmpdir(), 'mantle-aac-cold-'));
try {
  for (const [i, config] of fixture.configs.entries()) {
    assert(config.productionShaders && !config.sdfRecognition);
    const input = path.join(dir, i + '-input.json'),
      output = path.join(dir, i + '-output.json');
    writeFileSync(input, JSON.stringify(config));
    execFileSync(
      process.execPath,
      [path.join(root, 'probes/analyticArea/gpu.mjs'), input, output],
      {
        cwd: root,
        env: {
          ...process.env,
          MANTLE_GPU_BASELINE_ROOT: '',
          MANTLE_GPU_BURST_MS: '40',
          MANTLE_GPU_WALL_MS: '60000',
        },
        timeout: 70000,
        stdio: 'pipe',
      },
    );
    const report = JSON.parse(readFileSync(output));
    assert(report.finished && report.sourceStable && report.harnessStable);
    assert(!/software|swiftshader|llvmpipe/i.test(report.device.renderer));
    assert(report.device.timerQuery);
    assert.equal(report.rows.length, 1);
    const row = report.rows[0],
      a = row.arms.find((a) => a.name === 'fixed'),
      raw = row.arms.find((a) => a.name === 'raw'),
      p = a.preparation;
    assert.equal(p.pendingPlanState, 'pending');
    for (const draw of [p.pendingPin, a.pin, raw.pin]) {
      assert(
        draw.ledger.aac > 0 && !draw.ledger.slug && !draw.ledger.lb && !draw.ledger.cpatch,
        'Actual cold/pending/settled draw must use AAC',
      );
    }
    if (config.cases[0].drawOptions?.worldMatrix)
      assert(p.pendingPin.defines.includes('MANTLE_ROTATED_MAP'));
    assert(
      p.pendingQuality.pixels > 0 && p.pendingQuality.maxError * 255 <= 1,
      'Cold translucent pixels match independent ellipse area within one byte',
    );
    assert(a.quality.maxError * 255 <= 1 && raw.quality.maxError * 255 <= 1);
    assert.equal(p.pendingMaxDelta, 0, 'Preparation must preserve the correct pending image');
    assert.equal(a.imageHash, a.finalImageHash, 'Changing poses restore the checked image');
    assert.equal(a.imageHash, raw.imageHash);
    assert.equal(row.comparisons.find((x) => x.arm === 'raw').maxByte, 0);
    console.log(
      'aacColdKernelGpuSmoke PASS ' +
        config.initialKernel +
        ' ' +
        row.name +
        ' ' +
        report.device.renderer,
    );
  }
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

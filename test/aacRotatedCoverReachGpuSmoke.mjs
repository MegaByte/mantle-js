// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Rotated AAC needs the pixel box support in its cover dilation. A plain
// half-pixel push clips an independently verified two-byte fringe.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  readFileSync(path.join(root, 'test/fixtures/aac-rotated-cover-reach.json')),
);
const dir = mkdtempSync(path.join(tmpdir(), 'mantle-aac-reach-'));
try {
  // One probe run draws every case; each case keeps its own A/A pair.
  const input = path.join(dir, 'cases.json'),
    output = path.join(dir, 'out.json');
  writeFileSync(input, JSON.stringify(fixture));
  execFileSync(process.execPath, [path.join(root, 'probes/analyticArea/gpu.mjs'), input, output], {
    cwd: root,
    env: { ...process.env, MANTLE_GPU_BURST_MS: '40', MANTLE_GPU_WALL_MS: '60000' },
    timeout: 70000, // DEADLINE-OK: the probe's own wall cap (MANTLE_GPU_WALL_MS) plus its shutdown
    stdio: 'pipe',
  });
  const d = JSON.parse(readFileSync(output));
  assert(d.finished && d.sourceStable && d.harnessStable);
  assert(d.config.productionShaders);
  assert.equal(d.rows.length, fixture.cases.length);
  for (const r of d.rows) {
    const current = r.arms.filter((a) => a.name !== 'legacyRaw');
    for (const arm of current) {
      assert(arm.pin.ledger.aac > 0);
      assert(arm.inkAlpha > 0);
      assert(arm.pin.defines.includes('MANTLE_ROTATED_MAP'));
      assert.equal(arm.colorQuality.maxByte, 0, r.name + ' ' + arm.name);
    }
    assert.equal(current[0].imageHash, current[1].imageHash, 'raw AAC A/A images must match');
    assert(
      r.arms.find((a) => a.name === 'legacyRaw').colorQuality.maxByte > 0,
      'old setting must reproduce missing coverage',
    );
    console.log('  ok ' + r.name);
  }
  console.log('aacRotatedCoverReachGpuSmoke PASS');
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

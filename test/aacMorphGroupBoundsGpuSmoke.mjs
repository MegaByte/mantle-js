// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Group RT bounds must follow GPU-resident morph metadata, including its AA
// band, on both unified and ordinary routes. CPU meta remains at pose zero.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  dir = mkdtempSync(path.join(tmpdir(), 'mantle-morph-group-bounds-'));
try {
  const config = JSON.parse(
    readFileSync(path.join(root, 'test/fixtures/aac-morph-group-bounds.json')),
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
  for (const row of d.rows) {
    const arms = Object.fromEntries(row.arms.map((a) => [a.name, a]));
    for (const name of ['rawGpu', 'rawGpuAA', 'rawClassic', 'rawCpu']) {
      const a = arms[name];
      assert(a.pin.ledger.aac > 0);
      assert.equal(a.imageHash, a.finalImageHash);
      assert.equal(a.morph.usesGpuCurveLerp, name !== 'rawCpu');
      assert(a.morph.matched > 0);
      assert(a.morph.poseUpdatesInTiming);
      assert(!a.pin.defines.includes('MANTLE_AREA_MONOTONE'));
      assert(
        a.colorQuality.maxByte <= 1,
        row.name + ' ' + name + ' independent edge/opacity reference',
      );
    }
    assert.equal(arms.rawClassic.unified, false);
    assert.equal(arms.rawGpu.unified, true);
    assert.equal(arms.rawGpu.imageHash, arms.rawGpuAA.imageHash);
    for (const q of row.comparisons)
      assert(q.maxByte <= 1, row.name + ' ' + q.arm + ' full image vs authored current pose');
  }
  console.log(
    'aacMorphGroupBoundsGpuSmoke PASS: moving translucent group bounds, GPU/CPU morphs, unified/ordinary routes, early/late/rotated poses',
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

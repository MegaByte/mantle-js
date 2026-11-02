// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Physical GPU proof: zero-radius arcs are their authored chords in static and
// morph draws, including translucent groups. Never accept a silent Slug fallback.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  dir = mkdtempSync(path.join(tmpdir(), 'mantle-zero-radius-gpu-'));
try {
  const cfg = JSON.parse(readFileSync(path.join(root, 'test/fixtures/lb-zero-radius-morph.json')));
  assert(cfg.productionShaders);
  let count = 0;
  for (let i = 0; i < cfg.cases.length; i += 3) {
    const input = path.join(dir, 'input.json'),
      output = path.join(dir, 'output.json');
    writeFileSync(input, JSON.stringify({ ...cfg, cases: cfg.cases.slice(i, i + 3) }));
    execFileSync(
      process.execPath,
      [path.join(root, 'probes/analyticArea/gpu.mjs'), input, output],
      {
        cwd: root,
        env: { ...process.env, MANTLE_GPU_BURST_MS: '40', MANTLE_GPU_WALL_MS: '60000' },
        timeout: 70000,
        stdio: 'pipe',
      },
    );
    if (process.env.MANTLE_GPU_REPORT_DIR) {
      mkdirSync(process.env.MANTLE_GPU_REPORT_DIR, { recursive: true });
      copyFileSync(
        output,
        path.join(process.env.MANTLE_GPU_REPORT_DIR, 'lb-zero-radius-' + i + '.json'),
      );
    }
    const d = JSON.parse(readFileSync(output));
    assert(d.finished && d.sourceStable && d.harnessStable);
    for (const row of d.rows) {
      const a = Object.fromEntries(row.arms.map((x) => [x.name, x]));
      for (const [prefix, engine] of [
        ['lb', 'lb'],
        ['cp', 'cpatch'],
      ]) {
        for (const name of ['Line', 'Arc', 'ArcAA']) {
          const arm = a[prefix + name];
          assert(arm.pin.ledger[engine] > 0, row.name + ' requested engine drew');
          assert(arm.preparation.awaitEngineReady);
          assert(arm.inkAlpha > 1000);
          assert.equal(
            arm.imageHash,
            a[prefix + 'Line'].imageHash,
            row.name + ' ' + engine + ' chord equality',
          );
          if (arm.morph) {
            assert(arm.morph.matched > 0);
            assert(arm.morph.poseUpdatesInTiming);
            assert.equal(arm.imageHash, arm.finalImageHash);
          }
        }
      }
      count++;
    }
  }
  assert.equal(count, 24);
  console.log(
    'lbZeroRadiusArcGpuSmoke PASS: 18 static + 6 morph cases, scales 2^-20/1/2^20, rotations, translucent groups, actual LB/CPatch draws and identical RGBA',
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

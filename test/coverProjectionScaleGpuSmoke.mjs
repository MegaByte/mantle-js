// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Physical-GPU cover-support check. Equivalent authored shapes must
// retain their whole image under powers-of-two document scaling. This does
// not assert that the coverage model is exact.
//
// The baseline arm ('historical') is the shipped source with an absolute projection guard and a Slug support policy
// that applies the exact-cover reach only under a rotated map. Ordinary support has two contracts. A rotated, sheared or
// projective map is drawn by the baseline and the shipped policy with the same margin, so its image is byte-identical.
// An axis-aligned or reflected map takes the shipped exact-cover reach (a wider margin than the baseline's): its
// image may differ in the last bits, and the contract is accuracy, not identity -- against an independent exact
// pixel-box reference (test/_boxCoverageReference.mjs) the shipped output is no less accurate than the baseline's,
// in mean and in maximum error over the edge pixels and their neighbors.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { edgeSamples, isDiagonalMap } from './_boxCoverageReference.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  readFileSync(path.join(root, 'test/fixtures/cover-projection-scales.json')),
);
const dir = mkdtempSync(path.join(tmpdir(), 'mantle-cover-projection-'));
try {
  const baseline = path.join(dir, 'historical');
  cpSync(path.join(root, 'src'), path.join(baseline, 'src'), { recursive: true });
  const vertex = path.join(baseline, 'src/shaders/mantle.vert.glsl');
  const before = readFileSync(vertex, 'utf8');
  // Replace both parts of the shipped support with the baseline's. Otherwise the
  // shipped inverse-map support can cover pixels the baseline guard loses.
  const supportGuard = before
    .split('\n')
    .find((l) => l.startsWith('#if defined(MANTLE_AAC) || (!defined(MANTLE_NO_COVER_FILL)'));
  assert(supportGuard, 'exact-cover support guard must be present');
  const after = before
    .replace(/if \(abs\(denom\) <= [^;]+;/, 'if (abs(denom) < 1e-12) return vec2(0.0);')
    .replace(supportGuard, '#ifdef MANTLE_AAC');
  assert.notEqual(after, before, 'historical guard must replace the current helper');
  writeFileSync(vertex, after);
  const policyPath = path.join(baseline, 'src/renderer/fillPass.js');
  const policyBefore = readFileSync(policyPath, 'utf8');
  const policyAfter = policyBefore.replace(
    /v\.boxFilterReach = [^;]+;/,
    "v.boxFilterReach = defs.includes('MANTLE_AAC') && defs.includes('MANTLE_ROTATED_MAP');",
  );
  assert.notEqual(
    policyAfter,
    policyBefore,
    'historical Slug margin policy must replace the current policy',
  );
  writeFileSync(policyPath, policyAfter);
  const input = path.join(dir, 'input.json'),
    output = path.join(dir, 'gpu.json');
  // Projective controls retain the shipped box margin in both arms to isolate
  // the projection guard. Affine controls use the baseline Slug support.
  for (const c of fixture.cases)
    if (c.name.startsWith('projective')) {
      c.arms.find((a) => a.name === 'baselineSlug').coverAaReach = true;
    }
  // Independent reference for every axis-aligned/reflected case: exact box-averaged alpha (coverage x the fill opacity).
  const opacityOf = (svg) => +/fill-opacity="([^"]+)"/.exec(svg)[1];
  const diagonal = new Set();
  for (const c of fixture.cases)
    if (isDiagonalMap(c.drawOptions?.worldMatrix) && !c.name.startsWith('projective')) {
      c.samples = edgeSamples(c.svg, c.size, c.drawOptions?.worldMatrix, opacityOf(c.svg));
      diagonal.add(c.name);
    }
  writeFileSync(input, JSON.stringify(fixture));
  execFileSync(process.execPath, [path.join(root, 'probes/analyticArea/gpu.mjs'), input, output], {
    cwd: root,
    env: {
      ...process.env,
      MANTLE_GPU_BASELINE_ROOT: baseline,
      MANTLE_GPU_BASELINE_COMMIT:
        'current source with historical absolute projection guard and Slug support policy',
      MANTLE_GPU_BURST_MS: '40',
      MANTLE_GPU_WALL_MS: '165000',
    },
    timeout: 175000,
    stdio: 'pipe',
  });
  const d = JSON.parse(readFileSync(output));
  assert(d.finished && d.sourceStable && d.harnessStable);
  assert(d.config.productionShaders);
  assert(!/swiftshader|llvmpipe|software/i.test(d.device.renderer), 'physical GPU required');
  const hashes = new Map();
  let negativeControls = 0,
    accuracyChecks = 0;
  const lessAccurate = [];
  for (const row of d.rows) {
    assert.equal(row.glError, 0);
    const arms = new Map(row.arms.map((a) => [a.name, a]));
    assert.equal(
      arms.get('candidateSlug').imageHash,
      arms.get('candidateAA').imageHash,
      'A/A ' + row.name,
    );
    const family = row.name.replace(/--20|-0|-20|-24/, '');
    for (const name of ['candidateSlug', 'candidateAAC']) {
      const arm = arms.get(name);
      if (!arm) continue;
      assert(arm.inkAlpha > 0);
      assert(arm.pin.ledger[name === 'candidateAAC' ? 'aac' : 'slug'] > 0);
      assert.equal(arm.imageHash, arm.finalImageHash, 'final ' + row.name + ' ' + name);
      const key = family + ':' + name;
      if (hashes.has(key))
        assert.equal(arm.imageHash, hashes.get(key), 'scale invariance ' + row.name + ' ' + name);
      else hashes.set(key, arm.imageHash);
    }
    if (/-20(?:-|$)|-24$/.test(row.name) && !row.name.includes('--20')) {
      const delta = row.comparisons.find((c) => c.arm === 'candidateSlug');
      if (delta && delta.maxByte > 10) negativeControls++;
    } else if (!diagonal.has(row.name)) {
      const kernel = arms.has('candidateAAC') ? 'AAC' : 'Slug';
      assert.equal(
        arms.get('candidate' + kernel).imageHash,
        arms.get('baseline' + kernel).imageHash,
        'ordinary/tiny support ' + row.name + ' ' + kernel,
      );
    }
    if (diagonal.has(row.name)) {
      for (const kernel of ['Slug', 'AAC']) {
        const cand = arms.get('candidate' + kernel),
          base = arms.get('baseline' + kernel);
        if (!cand || !base) continue;
        const q = cand.quality,
          b = base.quality;
        assert(q && b && q.pixels > 0, 'reference samples ' + row.name + ' ' + kernel);
        // Sanity of the reference itself: both policies land within a few bytes of it on ordinary support (the
        // baseline policy at 2^20 is the deliberate missing-support control and is only compared, not bounded).
        if (!/-20-/.test(row.name) || /--20-/.test(row.name))
          assert(
            b.maxError < 0.02 && q.maxError < 0.02,
            'reference agrees ' + row.name + ' ' + kernel + ' ' + b.maxError + ' ' + q.maxError,
          );
        console.log(
          `  ${row.name} ${kernel}: edge px ${q.pixels}, mean err cur ${(q.meanError * 255).toFixed(5)} hist ${(b.meanError * 255).toFixed(5)} bytes, max err cur ${(q.maxError * 255).toFixed(4)} hist ${(b.maxError * 255).toFixed(4)} bytes, image ${cand.imageHash === base.imageHash ? 'identical' : 'differs'}`,
        );
        // No slack on any map: the vertex stage rounds a plain cover vertex onto the rasterizer's subpixel grid, so the
        // wider reach cannot change the interpolated position (test/reflectedCoverSnapSmoke.mjs models it on the CPU).
        if (!(q.meanError <= b.meanError)) lessAccurate.push('mean ' + row.name + ' ' + kernel);
        if (!(q.maxError <= b.maxError)) lessAccurate.push('max ' + row.name + ' ' + kernel);
        accuracyChecks++;
      }
    }
  }
  assert.deepEqual(lessAccurate, [], 'current policy no less accurate than the historical one');
  console.log('historical missing-support controls:', negativeControls);
  assert.equal(d.rows.length, 35);
  assert(accuracyChecks >= 15, 'axis/reflected accuracy comparisons: ' + accuracyChecks);
  assert(negativeControls >= 10, 'historical guard must reproduce missing raster support');
  console.log(
    'coverProjectionScaleGpuSmoke PASS (35 nonempty scale/affine/projective controls, historical negative controls)',
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

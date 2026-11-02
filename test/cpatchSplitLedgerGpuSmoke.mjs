// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Engine attribution follows the actual ordered geometry, including primitive peers.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#d433a9" fill-opacity=".4" d="M10 70C10 10 70 10 70 70L70 85L10 85Z"/><circle cx="65" cy="55" r="25" fill="#348bc4" fill-opacity=".5" stroke="#42c452" stroke-opacity=".35" stroke-width="2"/></svg>';
const cases = [{}, { worldMatrix: [0.8, 0.15, 0, -0.1, 0.75, 0, 0.05, -0.03, 1] }].map(
  (drawOptions, i) => ({
    name: i ? 'primitive-affine' : 'primitive-identity',
    size: 128,
    bbox: [0, 0, 100, 100],
    svg,
    drawOptions,
    comparisonBase: 'combined',
    arms: [
      {
        name: 'combined',
        engine: 'cpatch',
        fallbackKernel: 'slug',
        primitives: 'on',
        cpatchAreaSplit: false,
      },
      {
        name: 'fast',
        engine: 'cpatch',
        fallbackKernel: 'slug',
        primitives: 'on',
        requireAreaSplit: true,
        captureDrawCalls: true,
        captureWarmImages: true,
      },
    ],
  }),
);
const dir = mkdtempSync(path.join(tmpdir(), 'mantle-cpatch-ledger-'));
try {
  const input = path.join(dir, 'input.json'),
    output = path.join(dir, 'output.json');
  writeFileSync(
    input,
    JSON.stringify({
      productionShaders: true,
      sdfRecognition: true,
      initialKernel: 'slug',
      forceUnified: true,
      defaults: { rounds: 1, batch: 1, repetitions: 1 },
      cases,
    }),
  );
  execFileSync(process.execPath, [path.join(root, 'probes/analyticArea/gpu.mjs'), input, output], {
    cwd: root,
    env: {
      ...process.env,
      MANTLE_GPU_BASELINE_ROOT: '',
      MANTLE_GPU_BURST_MS: '40',
      MANTLE_GPU_WALL_MS: '90000',
    },
    timeout: 100000,
    stdio: 'pipe',
  });
  const d = JSON.parse(readFileSync(output));
  assert(d.finished && d.sourceStable && d.harnessStable);
  assert(!/software|swiftshader|llvmpipe/i.test(d.device.renderer));
  assert.equal(d.rows.length, 2);
  for (const row of d.rows) {
    assert.equal(row.glError, 0);
    assert(row.comparisons[0].maxByte <= 1, 'ordered primitive output parity');
    const fast = row.arms[1],
      pin = fast.pin;
    assert.equal(pin.drawCalls.length, 2, 'actual area and primitive/stroke runs');
    assert(pin.drawCalls[0].defines.includes('MANTLE_CPATCH_QUADRATIC_AREA_ONLY'));
    assert(pin.drawCalls[1].defines.includes('MANTLE_CPATCH_NO_QUADRATIC_AREA'));
    assert.equal(pin.ledger.cpatch, 1, 'only the area run contains CPatch');
    assert.equal(pin.ledger.sdf, 1, 'only the second run contains SDF');
    assert.equal(pin.ledger.stroke, 1, 'only the second run contains stroke');
    assert(!pin.ledger.lb && !pin.ledger.slug && !pin.ledger.aac, 'no unused fill engine credited');
    assert.equal(pin.routeLedger['cpatch@unified'], 1);
    assert.equal(pin.routeLedger['sdf@unified'], 1);
    assert(
      fast.warmupImages.length && fast.warmupImages.every((f) => f.maxDelta <= 1),
      'first warming frames preserve translucent primitive output',
    );
  }
  console.log(
    'cpatchSplitLedgerGpuSmoke PASS: actual area/SDF/stroke attribution and translucent affine/warming parity on ' +
      d.device.renderer,
  );
} catch (e) {
  if (e.stdout) process.stderr.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  throw e;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

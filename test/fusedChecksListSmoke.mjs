// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The optional fused diagnostic entry point lists the explicit model inventory.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/runFusedChecks.mjs'), '--list'], {
  cwd: ROOT,
  encoding: 'utf8',
});
const list = (r.stdout || '')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.startsWith('test/'));
ok(r.status === 0, `runFusedChecks --list exits 0 (${r.status})`);
ok(list.length >= 60, `it lists development shader diagnostics (${list.length})`);
for (const want of [
  'test/cpatchKernelTwinFidelitySmoke.mjs',
  'test/lbCubicChainSmoke.mjs',
  'test/shaderIdentityHarnessSmoke.mjs',
  'test/slugArcRayPrecisionDiagnostic.mjs',
  'test/bandWindingCubicShaderDiagnostic.mjs',
  'test/slugRotatedFootprintSmoke.mjs',
  'test/strokeArcsJoinScaleSmoke.mjs',
])
  ok(list.includes(want), `...including ${want}`);
ok(
  list.includes('test/coverQuadAaReachSmoke.mjs'),
  '...including the inline JS vertex shader model',
);
ok(!list.includes('test/lbPipeSceneOverflowSmoke.mjs'), '...excluding the CPU stream-format check');
console.log(fail ? `fusedChecksListSmoke FAIL (${fail})` : 'fusedChecksListSmoke PASS');
process.exit(fail ? 1 : 0);

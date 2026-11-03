#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Run CPU validation and browser rendering validation concurrently, with separate logs.
// SMOKE_JOBS sets CPU concurrency (default: half the cores, 2 to 8); RENDER_JOBS sets browser concurrency (default 3).
// A full pass with no retries on a clean committed tree is recorded (scripts/laneStamp.mjs) so a publish of that tree skips
// the lanes.
// Shader models run separately through npm run diagnose:accuracy during development.
// Do not use this validation runner for GPU timing.
// Usage: node scripts/runLanes.mjs [--out DIR]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { snapshot as gitSnapshot, newlyDirty, reportLeaks } from './trackedClean.mjs';
import { cleanTreeId, recordPass } from './laneStamp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const OUT = oi >= 0 ? argv[oi + 1] : path.join(os.tmpdir(), `mantle-lanes-${process.pid}`);
mkdirSync(OUT, { recursive: true });
// Both lanes read committed fixtures. Generate updated examples separately.
spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fetchTestFixtures.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
});
const GIT_BEFORE = gitSnapshot(ROOT);
const TREE = cleanTreeId(ROOT);
const jobs = String(
  Math.max(
    1,
    Math.floor(Number(process.env.SMOKE_JOBS)) ||
      Math.min(8, Math.max(2, Math.floor(os.availableParallelism() / 2))),
  ),
);
const renderJobs = String(Math.max(1, Math.floor(Number(process.env.RENDER_JOBS)) || 3));

const lane = (name, script, env) =>
  new Promise((resolve) => {
    const log = createWriteStream(path.join(OUT, `${name}.log`));
    const t0 = Date.now();
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts', script)], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.pipe(log, { end: false });
    p.stderr.pipe(log, { end: false });
    p.on('error', () => resolve({ name, code: 127, secs: 0 }));
    lanes.add(p);
    p.on('close', (code) => {
      log.end();
      resolve({ name, code, secs: Math.round((Date.now() - t0) / 1000) });
    });
  });

// A stop signal stops both lanes (each then stops its own smokes) before this process exits.
const lanes = new Set();
for (const [sig, code] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
])
  process.on(sig, () => {
    for (const p of lanes) p.kill(sig);
    process.exit(code);
  });
const results = await Promise.all([
  lane('node', 'runSmokes.mjs', { SMOKE_JOBS: jobs }),
  lane('render', 'runRenderSmokes.mjs', { RENDER_JOBS: renderJobs }),
]);
let bad = 0,
  retried = 0;
for (const r of results) {
  const text = readFileSync(path.join(OUT, `${r.name}.log`), 'utf8').split('\n');
  const summary = text.filter((l) =>
    /^(SMOKES|RENDER-SMOKES) (PASS|FAIL)|^FAILED|^PASSED ON RETRY|^SKIPPED|^HUNG|^  test\//.test(l),
  );
  console.log(
    `\n== ${r.name} lane: exit ${r.code} in ${r.secs}s (${path.join(OUT, r.name + '.log')})`,
  );
  for (const l of summary.slice(-30)) console.log(l);
  if (text.some((l) => /^PASSED ON RETRY/.test(l))) retried++;
  if (r.code !== 0) bad++;
}
if (reportLeaks(newlyDirty(ROOT, GIT_BEFORE), 'lanes')) bad++;
if (!bad && !retried && TREE && cleanTreeId(ROOT) === TREE)
  recordPass(ROOT, TREE, Object.fromEntries(results.map((r) => [r.name + 'Secs', r.secs])));
console.log(bad ? `\nLANES FAIL (${bad}/2)` : `\nLANES PASS (node + render)`);
process.exit(bad ? 1 : 0);

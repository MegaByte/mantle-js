#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Run CPU validation and browser rendering validation concurrently, with separate logs.
// SMOKE_JOBS controls CPU concurrency; browser tests remain serial.
// Shader models run separately through npm run diagnose:accuracy during development.
// Do not use this validation runner for GPU timing.
// Usage: node scripts/runLanes.mjs [--out DIR]
import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { snapshot as gitSnapshot, newlyDirty, reportLeaks } from './trackedClean.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const OUT = oi >= 0 ? argv[oi + 1] : path.join(os.tmpdir(), `mantle-lanes-${process.pid}`);
mkdirSync(OUT, { recursive: true });
// Both lanes read committed fixtures. Generate updated examples separately.
const GIT_BEFORE = gitSnapshot(ROOT);
const jobs = String(Math.max(1, Math.floor(Number(process.env.SMOKE_JOBS)) || 2));

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
    p.on('close', (code) => {
      log.end();
      resolve({ name, code, secs: Math.round((Date.now() - t0) / 1000) });
    });
  });

const results = await Promise.all([
  lane('node', 'runSmokes.mjs', { SMOKE_JOBS: jobs }),
  lane('render', 'runRenderSmokes.mjs', { RENDER_SKIP_GEN: '1' }),
]);
let bad = 0;
for (const r of results) {
  const text = readFileSync(path.join(OUT, `${r.name}.log`), 'utf8').split('\n');
  const summary = text.filter((l) =>
    /^(SMOKES|RENDER-SMOKES) (PASS|FAIL)|^FAILED|^PASSED ON RETRY|^SKIPPED|^HUNG|^  test\//.test(l),
  );
  console.log(
    `\n== ${r.name} lane: exit ${r.code} in ${r.secs}s (${path.join(OUT, r.name + '.log')})`,
  );
  for (const l of summary.slice(-30)) console.log(l);
  if (r.code !== 0) bad++;
}
if (reportLeaks(newlyDirty(ROOT, GIT_BEFORE), 'lanes')) bad++;
console.log(bad ? `\nLANES FAIL (${bad}/2)` : `\nLANES PASS (node + render)`);
process.exit(bad ? 1 : 0);

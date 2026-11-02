// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { snapshot as gitSnapshot, newlyDirty, reportLeaks } from './trackedClean.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT_MARK = pathToFileURL(path.join(ROOT, 'scripts', 'exitMark.mjs')).href;

export async function runNodeChecks(
  tests,
  { filters = [], label = 'SMOKES', env = process.env } = {},
) {
  const GIT_BEFORE = gitSnapshot(ROOT);
  const FILTERS = filters;
  const SELECTED = FILTERS.length
    ? tests.filter((rel) => FILTERS.some((f) => rel.toLowerCase().includes(f.toLowerCase())))
    : tests;
  if (FILTERS.length && !SELECTED.length) {
    console.error(
      `no smoke matches ${JSON.stringify(FILTERS)} — filters are substrings of the path`,
    );
    return 1;
  }
  if (FILTERS.length)
    console.log(`FILTERED: ${SELECTED.length}/${tests.length} smokes match ${FILTERS.join(', ')}`);

  const TIMEOUT_MS = Number(env.SMOKE_TIMEOUT_MS) > 0 ? Number(env.SMOKE_TIMEOUT_MS) : 180000;
  const runOne = (abs) =>
    spawnSync(process.execPath, [abs], {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env,
    });
  const why = (r) =>
    r.error && r.error.code === 'ETIMEDOUT'
      ? `timed out after ${TIMEOUT_MS / 1000} s`
      : r.error && r.status === null && r.signal === null
        ? `did not start: ${r.error.code || r.error.message}`
        : `exit ${r.status === null ? 'signal ' + r.signal : r.status}`;

  const SKIP_EXIT = 77;
  const failed = [],
    flaky = [],
    skipped = [];
  const JOBS = Math.max(1, Math.floor(Number(env.SMOKE_JOBS)) || 1);
  const EXIT_GRACE_MS =
    Number(env.SMOKE_EXIT_GRACE_MS) > 0 ? Number(env.SMOKE_EXIT_GRACE_MS) : 30000;
  let exitHangs = 0;
  const runOneAsync = (abs) =>
    new Promise((resolve) => {
      const chunks = [];
      let timedOut = false,
        marked = null,
        hung = false,
        grace = null;
      // (fd 3: the code the smoke passed to process.exit, scripts/exitMark.mjs. A process still here after its grace is Node's exit deadlock, not the smoke: it has given its answer.)
      const p = spawn(process.execPath, [`--import=${EXIT_MARK}`, abs], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        env,
      });
      const timer = setTimeout(() => {
        timedOut = true;
        p.kill('SIGKILL');
      }, TIMEOUT_MS);
      p.stdout.on('data', (d) => chunks.push(d));
      p.stderr.on('data', (d) => chunks.push(d));
      p.stdio[3].on('data', (d) => {
        marked = Number(String(d));
        grace = setTimeout(() => {
          hung = true;
          p.kill('SIGKILL');
        }, EXIT_GRACE_MS);
      });
      p.stdio[3].on('error', () => {});
      p.on('error', (error) => {
        clearTimeout(timer);
        resolve({ status: null, signal: null, error, out: Buffer.concat(chunks) });
      });
      p.on('close', (status, signal) => {
        clearTimeout(timer);
        clearTimeout(grace);
        if (hung) {
          exitHangs++;
          chunks.push(
            Buffer.from(
              `  ⚠ deadlocked in process.exit after asking for ${marked}; ended by the runner\n`,
            ),
          );
          resolve({ status: marked, signal: null, out: Buffer.concat(chunks) });
          return;
        }
        resolve({
          status,
          signal,
          error: timedOut
            ? Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
            : undefined,
          out: Buffer.concat(chunks),
        });
      });
    });
  if (JOBS === 1) {
    for (const rel of SELECTED) {
      const abs = path.join(ROOT, rel);
      process.stdout.write(`\n▶ ${rel}\n`);
      let r = runOne(abs);
      if (r.status !== 0 && r.status !== SKIP_EXIT) {
        process.stdout.write(`  ↻ retrying ${rel} (first attempt: ${why(r)})\n`);
        r = runOne(abs);
        if (r.status === 0) flaky.push(rel);
      }
      if (r.status === SKIP_EXIT) skipped.push(rel);
      else if (r.status !== 0) failed.push(`${rel} (${why(r)})`);
    }
  } else {
    console.log(`PARALLEL: ${JOBS} smokes at a time (SMOKE_JOBS)`);
    const slot = new Array(SELECTED.length);
    let next = 0;
    const worker = async () => {
      while (next < SELECTED.length) {
        const i = next++,
          rel = SELECTED[i],
          abs = path.join(ROOT, rel),
          t0 = Date.now();
        let r = await runOneAsync(abs),
          block = `\n▶ ${rel}\n${r.out}`,
          wasFlaky = false;
        if (r.status !== 0 && r.status !== SKIP_EXIT) {
          block += `  ↻ retrying ${rel} (first attempt: ${why(r)})\n`;
          r = await runOneAsync(abs);
          block += r.out;
          if (r.status === 0) wasFlaky = true;
        }
        block += `  ⧗ ${((Date.now() - t0) / 1000).toFixed(1)}s   [${++doneCount}/${SELECTED.length}]\n`;
        process.stdout.write(block);
        slot[i] = { rel, status: r.status, r, wasFlaky };
      }
    };
    let doneCount = 0;
    await Promise.all(Array.from({ length: JOBS }, worker));
    for (const s of slot) {
      // reported in suite order, whatever order they finished in
      if (s.wasFlaky) flaky.push(s.rel);
      if (s.status === SKIP_EXIT) skipped.push(s.rel);
      else if (s.status !== 0) failed.push(`${s.rel} (${why(s.r)})`);
    }
  }
  if (exitHangs)
    console.log(
      `\nDEADLOCKED IN process.exit (${exitHangs}): Node's exit, after each smoke gave its answer; counted by that answer, not retried.`,
    );
  if (flaky.length) {
    console.log(
      `\nPASSED ON RETRY (${flaky.length}) — cause unestablished; not a clean first-attempt pass:`,
    );
    for (const f of flaky) console.log('  ' + f);
  }
  if (skipped.length) {
    console.log(
      `\nSKIPPED (${skipped.length}) — did not run; an asset was absent (each printed its own pointer above):`,
    );
    for (const s of skipped) console.log('  ' + s);
    console.log('  → `npm run fetch:fixtures` gets everything that is fetchable.');
  }
  const leaked = reportLeaks(newlyDirty(ROOT, GIT_BEFORE), label.toLowerCase());
  if (leaked) failed.push('(tracked tree dirtied by the lane)');
  const failures = failed.length;
  if (failures) {
    console.log('\nFAILED:');
    for (const f of failed) console.log('  ' + f);
  }
  const ran = SELECTED.length - skipped.length;
  const tail = skipped.length ? `, ${skipped.length} SKIPPED` : '';
  console.log(
    failures
      ? `\n${label} FAIL (${failures}/${SELECTED.length}${tail})`
      : `\n${label} PASS (${ran}/${SELECTED.length}${tail})`,
  );
  return failures ? 1 : 0;
}

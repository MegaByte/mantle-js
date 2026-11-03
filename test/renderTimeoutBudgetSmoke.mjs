// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// renderTimeoutBudgetSmoke — a render test must outlive its own wait, or a hang cannot be diagnosed.
//
// `runRenderSmokes` SIGKILLs a test at RENDER_TEST_TIMEOUT_MS (180s by default). A test whose
// in-page wait is LONGER than that cap can never reach the branch after the wait — the one that
// prints the page's console errors and says "page never finished". The kill lands first, and the
// lane reports a bare "HUNG" with no cause: a test with a 280000 ms wait under a 180000 ms cap is
// killed 100 seconds before it can explain itself.
//
// This asserts the budget as a property of the SOURCE, so it holds without running the lane:
//   (a) no render-lane test carries a literal in-page timeout at or above the cap;
//   (b) `pageTimeoutFor` leaves a real reserve under the cap, and is a no-op standalone;
//   (c) the runner actually passes the cap down, or (a) would be checking against a number the
//       tests never see.
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const runnerSrc = readFileSync(path.join(ROOT, 'scripts/runRenderSmokes.mjs'), 'utf8');
const capM = /RENDER_TEST_TIMEOUT_MS \|\| (\d+)/.exec(runnerSrc);
ok(!!capM, `the runner declares a default per-test cap${capM ? ` (${capM[1]} ms)` : ''}`);
const CAP = capM ? +capM[1] : 180000;

// ── (c) the cap reaches the child ───────────────────────────────────────────────────────────────
// Without this the tests would be sizing themselves against a number that only exists in the
// runner, and `pageTimeoutFor` would silently return its fallback for every test in the lane.
ok(
  /env:\s*\{[^}]*RENDER_TEST_TIMEOUT_MS/.test(runnerSrc),
  '(c) the runner passes RENDER_TEST_TIMEOUT_MS down to each test it spawns',
);

// ── (b) the helper's arithmetic ────────────────────────────────────────────────────────────────
const { pageTimeoutFor } = await import('./_laneBudget.mjs');
{
  const saved = process.env.RENDER_TEST_TIMEOUT_MS;
  delete process.env.RENDER_TEST_TIMEOUT_MS;
  ok(
    pageTimeoutFor(280000) === 280000,
    '(b) standalone (no cap in the environment) a test keeps the generous wait it was written with',
  );
  process.env.RENDER_TEST_TIMEOUT_MS = String(CAP);
  const t = pageTimeoutFor(280000);
  ok(t < CAP, `(b) under the lane it waits less than the cap (${t} < ${CAP})`);
  ok(
    CAP - t >= 10000,
    `(b) ...with at least 10s left to print the diagnosis and close down (reserve ${CAP - t} ms)`,
  );
  ok(
    t > CAP / 2,
    `(b) ...and still waits for most of the cap (${t} ms), so this does not turn hangs into false timeouts`,
  );
  process.env.RENDER_TEST_TIMEOUT_MS = '30000';
  ok(
    pageTimeoutFor(280000) === 10000,
    '(b) a very short cap floors at 10s rather than going negative',
  );
  if (saved === undefined) delete process.env.RENDER_TEST_TIMEOUT_MS;
  else process.env.RENDER_TEST_TIMEOUT_MS = saved;
}

// ── (a) no render-lane test out-waits the cap ──────────────────────────────────────────────────
const inLane = [...new Set(runnerSrc.match(/test\/[A-Za-z0-9_]+\.mjs/g) || [])];
ok(inLane.length > 50, `the runner lists ${inLane.length} render tests`);
const offenders = [];
for (const rel of inLane) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) continue;
  const src = readFileSync(abs, 'utf8');
  for (const m of src.matchAll(/timeout:\s*(\d+)/g)) {
    if (+m[1] >= CAP) offenders.push(`${rel} (timeout: ${m[1]})`);
  }
}
ok(
  offenders.length === 0,
  offenders.length
    ? `(a) ${offenders.length} render test(s) wait at or past the ${CAP} ms cap, so their diagnosis is ` +
        `unreachable:\n      ${offenders.join('\n      ')}`
    : `(a) no render-lane test carries a literal in-page timeout at or above the ${CAP} ms cap`,
);

// ── (d) no test may await a BARE requestAnimationFrame ─────────────────────────────────────────
// Headless Chrome stops producing animation frames once a
// page has no visible work left, so `await new Promise(res => requestAnimationFrame(res))` -- an
// rAF used purely to pace a loop -- can simply never fire. The promise never settles, the page
// never assigns its result, and the test hangs until its wait gives up.
//
// A hang like that costs the whole wait on every attempt, and a timeout raced against the rAF
// removes it.
//
// The rule is not "never use rAF" -- it is "never let rAF be the only thing that can settle a
// promise". A site that also arms a setTimeout is fine.
{
  // THE BODY OF each `new Promise(...)`, by balanced parens -- the only scope in which a setTimeout
  // can actually be racing the rAF. A weaker check lets real offenders past: a fixed-width
  // character window would call `occupancyAsync` safe because the NEXT line happens to be
  // `await new Promise((res) => setTimeout(res, 250))`, which is a separate, sequential wait that
  // never runs precisely because the rAF promise above it never settles.
  const promiseBodies = (src) => {
    const out = [];
    let i = -1;
    while ((i = src.indexOf('new Promise(', i + 1)) !== -1) {
      let d = 0,
        j = i + 'new Promise'.length;
      for (; j < src.length; j++) {
        const c = src[j];
        if (c === '(') d++;
        else if (c === ')') {
          d--;
          if (d === 0) {
            j++;
            break;
          }
        }
      }
      out.push(src.slice(i, j));
    }
    return out;
  };
  const offenders = [];
  for (const rel of inLane) {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) continue;
    for (const body of promiseBodies(readFileSync(abs, 'utf8'))) {
      if (!/requestAnimationFrame/.test(body)) continue;
      if (/setTimeout/.test(body)) continue; // raced in the same promise — fine
      offenders.push(`${rel}: ${body.replace(/\s+/g, ' ').slice(0, 92)}`);
    }
  }
  ok(
    offenders.length === 0,
    offenders.length
      ? `(d) ${offenders.length} test(s) await an rAF with nothing else able to settle the promise, ` +
          `so a headless page that stops producing frames hangs them:\n      ${offenders.join('\n      ')}`
      : '(d) no render-lane test awaits a bare requestAnimationFrame — every rAF wait has a timeout racing it',
  );
}

console.log(fail ? `\nRENDER-TIMEOUT-BUDGET FAIL (${fail})` : '\nRENDER-TIMEOUT-BUDGET PASS');
process.exit(fail ? 1 : 0);

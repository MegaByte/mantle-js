// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// exitDeadlockRunnerSmoke -- a smoke deadlocked inside process.exit is counted by the code it asked for, with no timeout and no retry.
//
// Node can deadlock at process.exit with V8's background threads mid-work. A timeout and retry would hide that (180 s, then a pass on the second attempt). A failing smoke must still fail.
import { runNodeChecks } from '../scripts/runNodeChecks.mjs';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const run = async (code) => {
  const lines = [];
  const w = process.stdout.write;
  process.stdout.write = (d) => {
    lines.push(String(d));
    return true;
  };
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  const t0 = Date.now();
  let rc;
  try {
    rc = await runNodeChecks(['test/_exitDeadlockFixture.mjs'], {
      label: 'FIXTURE',
      env: {
        ...process.env,
        SMOKE_JOBS: '2',
        SMOKE_EXIT_GRACE_MS: '500',
        EXIT_FIXTURE_CODE: String(code),
      },
    });
  } finally {
    process.stdout.write = w;
    console.log = log;
  }
  return { rc, ms: Date.now() - t0, out: lines.join('') };
};
const passed = await run(0);
ok(passed.rc === 0, `asked for 0 and deadlocked: the lane passes (rc ${passed.rc})`);
ok(
  passed.ms < 60000 && !/retrying/.test(passed.out),
  `with no retry and no wait for the timeout (${passed.ms} ms)`,
);
ok(/DEADLOCKED IN process\.exit \(1\)/.test(passed.out), 'and it is reported, not hidden');
const failed = await run(1);
ok(failed.rc === 1, `asked for 1 and deadlocked: the lane fails (rc ${failed.rc})`);
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');

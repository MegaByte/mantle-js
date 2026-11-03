// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// renderReaperScopeSmoke -- the render lane's orphan reaper names only its own lane's orphans (scripts/laneProfiles.mjs).
//
// The render runner kills a `Chrome for Testing` process only when its parent is PID 1, its profile is under this run's
// lane root (or the root of a runner that is gone), and the process that launched it is gone. Two checks:
//   (a) a table of `ps -eo pid,ppid,command` lines: a dead launcher's browser and its crash handler (also under the
//       resolved /private path), and the browser a dead runner left, are named; a live launcher's browser, a live
//       lane's orphan, a profile outside any lane root, a helper whose parent is alive, the runner's shared browser, a
//       process that is not Chrome and a root whose name only starts with this lane's are not;
//   (b) real processes: two fake orphans (a sleep whose argv[0] reads like a Chrome command line, reparented to PID 1 when
//       the shell that started it exits), one under this check's lane root with a launcher that is gone and one under
//       another lane's root. From a real `ps` snapshot only the first is named; both are killed by their exact pids after.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLaneRoot, orphanBrowserPids, pidAlive } from '../scripts/laneProfiles.mjs';

let fails = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fails++;
};
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// (a) the decision on a table of command lines
{
  const T = '/var/folders/x/T';
  const L = `${T}/mantle-lane-777-abc123`,
    O = `${T}/mantle-lane-888-def456`,
    GONE = `${T}/mantle-lane-999-ghi789`;
  const DEAD = 4000001,
    LIVE = 4000002,
    RUNNER = 777,
    OTHER_RUNNER = 888;
  const alive = (pid) => pid === LIVE || pid === RUNNER || pid === OTHER_RUNNER;
  const CH =
    '/Users/u/.cache/puppeteer/chrome/mac_arm/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const CP =
    '/Users/u/.cache/puppeteer/chrome/mac_arm/Google Chrome for Testing Framework.framework/Helpers/chrome_crashpad_handler';
  const ps = [
    '  PID  PPID COMMAND',
    `  101     1 ${CH} --headless=new --user-data-dir=${L}/mantle-chrome-${DEAD}-q1w2e3 --remote-debugging-port=0`,
    `  102     1 ${CP} --database=/private${L}/mantle-chrome-${DEAD}-q1w2e3/Crashpad --monitor-self`,
    `  103     1 ${CH} --user-data-dir=${L}/mantle-chrome-${LIVE}-zzzzzz`,
    `  104     1 ${CH} --user-data-dir=${O}/mantle-chrome-${DEAD}-yyyyyy`,
    `  105     1 ${CH} --user-data-dir=${T}/mantle-chrome-AbC123`,
    `  106     1 ${CH} --user-data-dir=${T}/puppeteer_dev_chrome_profile-XXXX`,
    `  107  4242 ${CH} --type=gpu-process --user-data-dir=${L}/mantle-chrome-${DEAD}-q1w2e3`,
    `  108     1 ${CH} --user-data-dir=${L}/mantle-chrome-${RUNNER}-shared-abcdef`,
    `  109     1 /bin/zsh ${L}/mantle-chrome-${DEAD}-q1w2e3`,
    `  110     1 ${CH} --user-data-dir=${L}x/mantle-chrome-${DEAD}-q1w2e3`,
    `  111     1 ${CH} --user-data-dir=${GONE}/mantle-chrome-999-shared-jklmno`,
    `  112     1 ${CH} --user-data-dir=${GONE}/mantle-chrome-${LIVE}-pqrstu`,
  ].join('\n');
  const named = orphanBrowserPids(ps, L, alive);
  ok(
    same(named, [101, 102, 111]),
    `(a) of 12 lines, only the dead launcher's browser, its crash handler and a dead runner's browser are named ` +
      `(${JSON.stringify(named)})`,
  );
}

// (b) real fake orphans
{
  const lane = createLaneRoot();
  const other = mkdtempSync(path.join(os.tmpdir(), 'mantle-lane-1-'));
  const dead = spawnSync('/usr/bin/true').pid;
  const fakes = [];
  try {
    ok(!pidAlive(dead), `(b) the stand-in launcher (pid ${dead}) has exited`);
    const orphan = (root) => {
      // The profile exists on disk, so no other runner's reaper reads this fake as a removed profile's orphan.
      const profile = path.join(root, `mantle-chrome-${dead}-fakeprof`);
      mkdirSync(profile);
      const argv0 = `Google Chrome for Testing --user-data-dir=${profile}`;
      const r = spawnSync(
        '/bin/bash',
        ['-c', `(exec -a "${argv0}" /bin/sleep 600) </dev/null >/dev/null 2>&1 & echo $!`],
        { encoding: 'utf8' },
      );
      const pid = +r.stdout.trim();
      fakes.push(pid);
      return pid;
    };
    const mine = orphan(lane),
      theirs = orphan(other);
    const snap = spawnSync('/bin/ps', ['-eo', 'pid,ppid,command'], { encoding: 'utf8' }).stdout;
    const row = (pid) =>
      snap.split('\n').find((l) => l.trim().startsWith(pid + ' ')) || '(not in the ps snapshot)';
    for (const [name, pid] of [
      ['this lane', mine],
      ['the other lane', theirs],
    ])
      ok(
        /^\d+\s+1\s+Google Chrome for Testing --user-data-dir=/.test(row(pid).trim()),
        `(b) the fake orphan under ${name}'s root runs with parent PID 1: ${row(pid).trim().slice(0, 140)}`,
      );
    const named = orphanBrowserPids(snap, lane);
    ok(
      same(named, [mine]),
      `(b) from the real process table only this lane's orphan is named (${JSON.stringify(named)}; ` +
        `this lane ${mine}, the other lane ${theirs})`,
    );
    ok(!named.includes(theirs), "(b) the other lane's orphan is left alone");
  } finally {
    for (const pid of fakes)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    rmSync(lane, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
}

console.log(fails ? `\nRENDER-REAPER-SCOPE FAIL (${fails})` : '\nRENDER-REAPER-SCOPE PASS');
process.exit(fails ? 1 : 0);

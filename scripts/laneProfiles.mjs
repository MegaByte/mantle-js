// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// laneProfiles.mjs -- where a render lane's browsers keep their profiles, and which Chrome processes are this lane's
// orphans.
//
// The runner makes one LANE ROOT per run, mantle-lane-<runner pid>-XXXXXX in the temp directory, and names it to every
// process it starts in MANTLE_CHROME_PROFILE_ROOT. test/_launch.mjs makes each profile there, named after the process
// that launches the browser: mantle-chrome-<launcher pid>-XXXXXX (a smoke, or a probe a smoke runs), and the runner's
// shared browsers (scripts/sharedBrowsers.mjs) get mantle-chrome-<runner pid>-shared-XXXXXX.
//
// A Chrome process is an orphan to reap only when its parent is PID 1, its command line names a profile under a lane
// root, and the process that launched it (the pid in the profile's name) is gone: a smoke killed at its cap, whose exit
// hook never ran. The root must be this lane's, or one whose runner is gone (a runner killed outright leaves its shared
// browsers so, and nobody else would ever take them). Everything else is left alone: the browsers of another live lane,
// of an agent's job or of a run outside the lane (a live root's, or no root at all); a browser whose launcher is still
// running, and its crash handler, which detaches to PID 1 by design; and the runner's shared browsers, whose launcher is
// the runner itself. Nothing here starts a browser.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROFILE_ROOT_ENV = 'MANTLE_CHROME_PROFILE_ROOT';
const LANE_PREFIX = 'mantle-lane-';

/** Whether a process with this pid exists (one owned by another user counts). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Make this run's lane root. */
export function createLaneRoot() {
  return mkdtempSync(path.join(os.tmpdir(), `${LANE_PREFIX}${process.pid}-`));
}

/** Delete the lane roots of runners that are gone (their browsers are not touched). */
export function removeAbandonedLaneRoots() {
  const tmp = os.tmpdir();
  let names = [];
  try {
    names = readdirSync(tmp);
  } catch {
    return;
  }
  for (const name of names) {
    const m = new RegExp(`^${LANE_PREFIX}(\\d+)-`).exec(name);
    if (!m || pidAlive(+m[1])) continue;
    try {
      rmSync(path.join(tmp, name), { recursive: true, force: true });
    } catch {
      /* in use or gone */
    }
  }
}

/**
 * The pids, from `ps -eo pid,ppid,command` output, of this lane's orphaned Chrome processes.
 * @param {string} psText
 * @param {string} laneRoot
 * @param {(pid: number) => boolean} [alive]
 * @returns {number[]}
 */
export function orphanBrowserPids(psText, laneRoot, alive = pidAlive) {
  // A root's name is unique to its run, and matching names leaves out whether the temp path was resolved (/private).
  const lane = path.basename(laneRoot);
  const profile = new RegExp(`/(${LANE_PREFIX}(\\d+)-[^/\\s]+)/mantle-chrome-(\\d+)-`);
  const pids = [];
  for (const line of psText.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || m[2] !== '1' || !m[3].includes('Chrome for Testing')) continue;
    const p = profile.exec(m[3]);
    if (!p || (p[1] !== lane && alive(+p[2])) || alive(+p[3])) continue;
    pids.push(+m[1]);
  }
  return pids;
}

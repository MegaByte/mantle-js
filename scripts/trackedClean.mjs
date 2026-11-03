// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Detect tracked changes and new generated fixtures introduced by a test lane.
// Compare snapshots so existing changes are preserved. Outside a Git checkout
// there is no check. MANTLE_LANE_ALLOW_DIRTY=1 permits intentional fixture updates.

import { spawnSync } from 'node:child_process';

export const WATCH_UNTRACKED = ['examples/smoke'];

function porcelain(cwd, args) {
  const r = spawnSync('git', ['status', '--porcelain', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.split('\n').filter(Boolean);
}

/** The status lines that exist now: tracked changes under cwd, and untracked files under WATCH_UNTRACKED. null when `cwd` is not in a git checkout. */
export function snapshot(cwd) {
  const tracked = porcelain(cwd, ['--untracked-files=no', '--', '.']);
  if (tracked === null) return null;
  const untracked = (
    porcelain(cwd, ['--untracked-files=all', '--', ...WATCH_UNTRACKED]) || []
  ).filter((l) => l.startsWith('??'));
  return new Set([...tracked, ...untracked]);
}

/** The status lines present now that were not in `before`. [] = clean; null = nothing to check. */
export function newlyDirty(cwd, before) {
  if (before === null || process.env.MANTLE_LANE_ALLOW_DIRTY === '1')
    return before === null ? null : [];
  const after = snapshot(cwd);
  if (after === null) return null;
  return [...after].filter((l) => !before.has(l)).sort();
}

/** Print the verdict the lanes share; true when the lane dirtied the tree. */
export function reportLeaks(leaks, lane) {
  if (!leaks || leaks.length === 0) return false;
  console.log(
    `\n${lane}: THE LANE DIRTIED THE TRACKED TREE (${leaks.length} file${leaks.length === 1 ? '' : 's'}) -- committed copies of derived files are stale:`,
  );
  for (const l of leaks.slice(0, 40)) console.log('  ' + l);
  if (leaks.length > 40) console.log(`  ... and ${leaks.length - 40} more`);
  console.log(
    '  -> run `node scripts/genSmokeAssets.mjs` and commit examples/smoke (MANTLE_LANE_ALLOW_DIRTY=1 skips this check for a run that is meant to change them).',
  );
  return true;
}

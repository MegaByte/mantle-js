// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The committed trees a full lane run passed on, so publishing that same tree does not run the lanes a second time.
// A tree counts only when nothing tracked is modified anywhere in the checkout and nothing untracked sits under src/
// or scripts/ (untracked sources would be packed or run). Internal docs (any docs/internal directory) are left out of
// both the key and the check: no test reads them. The record lives in node_modules/.cache, which git ignores.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 1 << 28 });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : null;
};

const INTERNAL_DOCS = /(^|\/)docs\/internal\//;

/** A hash of the HEAD tree without internal docs when the checkout is clean as above, else null (dirty, or not a git checkout). */
export function cleanTreeId(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  // -z: NUL-separated, untrimmed records (each 'XY path'), so the path starts at a fixed column
  const tracked = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=no'], {
    cwd: top,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1 << 28,
  });
  if (tracked.status !== 0) return null;
  if (tracked.stdout.split('\0').some((l) => l && !INTERNAL_DOCS.test(l.slice(3)))) return null;
  if (git(cwd, ['status', '--porcelain', '--untracked-files=all', '--', 'src', 'scripts']) !== '')
    return null;
  const list = git(top, ['ls-tree', '-r', 'HEAD']);
  if (list === null) return null;
  const kept = list.split('\n').filter((l) => !INTERNAL_DOCS.test(l.slice(l.indexOf('\t') + 1)));
  return createHash('sha1').update(kept.join('\n')).digest('hex');
}

const file = (cwd) => path.join(cwd, 'node_modules', '.cache', 'mantle', 'lanes-pass.json');
const read = (cwd) => {
  try {
    return JSON.parse(readFileSync(file(cwd), 'utf8'));
  } catch {
    return {};
  }
};

/** The record of a passing full run on `tree`, or undefined. */
export const passedOn = (cwd, tree) => read(cwd)[tree];

/** Record that both lanes passed on `tree` (the newest 20 trees are kept). */
export function recordPass(cwd, tree, detail) {
  const all = read(cwd);
  all[tree] = { at: new Date().toISOString(), ...detail };
  const kept = Object.entries(all)
    .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)))
    .slice(0, 20);
  try {
    mkdirSync(path.dirname(file(cwd)), { recursive: true });
    writeFileSync(file(cwd), JSON.stringify(Object.fromEntries(kept), null, 2) + '\n');
  } catch {
    /* only the shortcut is lost */
  }
}

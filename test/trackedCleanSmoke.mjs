// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// trackedCleanSmoke -- scripts/trackedClean.mjs: a lane that dirties the tracked tree is detected, a tree that was already dirty is not blamed, an
// untracked file counts only under examples/smoke, MANTLE_LANE_ALLOW_DIRTY=1 switches the verdict off, and a non-git folder answers null.
import { copyFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { snapshot, newlyDirty, reportLeaks } from '../scripts/trackedClean.mjs';
import { cleanTreeId, passedOn, recordPass } from '../scripts/laneStamp.mjs';
const inheritedAllowDirty = process.env.MANTLE_LANE_ALLOW_DIRTY;
delete process.env.MANTLE_LANE_ALLOW_DIRTY;
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const dir = mkdtempSync(path.join(os.tmpdir(), 'mantle-tc-'));
const nogit = mkdtempSync(path.join(os.tmpdir(), 'mantle-tc-nogit-'));
try {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  mkdirSync(path.join(dir, 'examples', 'smoke'), { recursive: true });
  writeFileSync(path.join(dir, 'examples', 'smoke', 'index.json'), '[]\n');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  writeFileSync(path.join(dir, 'b.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const before = snapshot(dir);
  ok(before instanceof Set && before.size === 0, 'a clean checkout snapshots as empty');
  ok(JSON.stringify(newlyDirty(dir, before)) === '[]', 'nothing changed: nothing reported');
  writeFileSync(path.join(dir, 'examples', 'smoke', 'index.json'), '[1]\n');
  ok(
    newlyDirty(dir, before).some((l) => l.endsWith('examples/smoke/index.json')),
    'a rewritten tracked file is reported',
  );
  writeFileSync(path.join(dir, 'examples', 'smoke', 'new__SVG.svg'), '<svg/>\n');
  ok(
    newlyDirty(dir, before).some((l) => l.startsWith('??') && l.endsWith('new__SVG.svg')),
    'a new untracked file under examples/smoke is reported',
  );
  writeFileSync(path.join(dir, 'scratch.log'), 'x\n');
  ok(
    !newlyDirty(dir, before).some((l) => l.endsWith('scratch.log')),
    'an untracked file elsewhere is not',
  );
  const mid = snapshot(dir);
  writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  const leaks = newlyDirty(dir, mid);
  ok(
    leaks.length === 1 && leaks[0].endsWith('a.txt'),
    'a tree that was already dirty is blamed only for what the lane added',
  );
  process.env.MANTLE_LANE_ALLOW_DIRTY = '1';
  ok(
    JSON.stringify(newlyDirty(dir, before)) === '[]',
    'MANTLE_LANE_ALLOW_DIRTY=1 turns the verdict off',
  );
  delete process.env.MANTLE_LANE_ALLOW_DIRTY;
  ok(
    snapshot(nogit) === null && newlyDirty(nogit, null) === null,
    'a folder outside a git checkout answers null (nothing to check)',
  );
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const leaked = reportLeaks(['M a.txt'], 'x');
  console.log = log;
  ok(
    leaked === true &&
      logs.some((l) => /DIRTIED THE TRACKED TREE/.test(l)) &&
      reportLeaks([], 'x') === false,
    'reportLeaks says so, and says nothing for a clean tree',
  );
  const pkg = path.join(dir, 'package');
  mkdirSync(pkg);
  writeFileSync(path.join(pkg, 'entry.js'), 'export const value = 1;\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'nested package');
  const packageBefore = snapshot(pkg);
  writeFileSync(path.join(dir, 'a.txt'), 'another package changed\n');
  ok(
    newlyDirty(pkg, packageBefore).length === 0,
    'a package lane ignores edits outside its package',
  );
  writeFileSync(path.join(pkg, 'entry.js'), 'export const value = 2;\n');
  const packageLeaks = newlyDirty(pkg, packageBefore);
  ok(
    packageLeaks.length === 1 && packageLeaks[0].endsWith('package/entry.js'),
    'the same lane still detects tracked changes inside its package',
  );

  // Exercise the actual lane coordinator against tiny child lanes in a clean
  // repository. Exit 0 with a skipped test must not authorize a later publish.
  const stampRoot = path.join(nogit, 'lanes');
  const scripts = path.join(stampRoot, 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(path.join(stampRoot, '.gitignore'), 'node_modules/\n');
  for (const f of ['runLanes.mjs', 'trackedClean.mjs', 'laneStamp.mjs'])
    copyFileSync(new URL('../scripts/' + f, import.meta.url), path.join(scripts, f));
  writeFileSync(path.join(scripts, 'fetchTestFixtures.mjs'), '');
  writeFileSync(
    path.join(scripts, 'runSmokes.mjs'),
    `const mode = process.env.MANTLE_STAMP_FIXTURE;
if (mode === 'skip') console.log('SKIPPED (1)');
if (mode === 'retry') console.log('PASSED ON RETRY (1)');
console.log('SMOKES ' + (mode === 'fail' ? 'FAIL (1/1)' : 'PASS (1/1)'));
process.exitCode = mode === 'fail' ? 1 : 0;
`,
  );
  writeFileSync(
    path.join(scripts, 'runRenderSmokes.mjs'),
    "if (process.env.MANTLE_STAMP_FIXTURE === 'render-skip') console.log('SKIPPED (1)');\n" +
      "console.log('RENDER-SMOKES PASS (1/1)');\n",
  );
  git(stampRoot, 'init', '-q');
  git(stampRoot, 'add', '.');
  git(stampRoot, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
  const tree = cleanTreeId(stampRoot);
  ok(!!tree, 'the coordinator fixture has a clean committed tree');
  for (const mode of ['skip', 'render-skip', 'retry', 'fail', 'pass']) {
    rmSync(path.join(stampRoot, 'node_modules'), { recursive: true, force: true });
    const r = spawnSync(
      process.execPath,
      [path.join(scripts, 'runLanes.mjs'), '--out', path.join(stampRoot, 'node_modules', 'lane-logs')],
      {
        cwd: stampRoot,
        encoding: 'utf8',
        env: { ...process.env, MANTLE_STAMP_FIXTURE: mode },
      },
    );
    ok(r.status === (mode === 'fail' ? 1 : 0), `${mode}: the lane exit status is preserved`);
    ok(!!passedOn(stampRoot, tree) === (mode === 'pass'), `${mode}: only a complete pass is cached`);
  }
  recordPass(stampRoot, tree, { nodeSecs: 1, renderSecs: 1 });
  ok(!passedOn(stampRoot, tree), 'legacy records without complete coverage are not reused');
} finally {
  if (inheritedAllowDirty === undefined) delete process.env.MANTLE_LANE_ALLOW_DIRTY;
  else process.env.MANTLE_LANE_ALLOW_DIRTY = inheritedAllowDirty;
  rmSync(dir, { recursive: true, force: true });
  rmSync(nogit, { recursive: true, force: true });
}
if (fail) {
  console.error(`FAIL trackedCleanSmoke: ${fail}`);
  process.exit(1);
}
console.log('trackedCleanSmoke PASS');

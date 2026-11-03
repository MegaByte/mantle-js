#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// prepublishOnly: build the shaders and declarations, check the public types, then run the node and render lanes
// together (scripts/runLanes.mjs). The lanes are skipped when they already passed on this exact committed tree, which
// runLanes records; the build steps still run, and a build that changes a tracked file makes the tree dirty, so the
// lanes run. MANTLE_PUBLISH_RERUN=1 runs the lanes anyway.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cleanTreeId, passedOn } from './laneStamp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const step = (script) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
step('buildShaders.mjs');
step('genTypes.mjs');
step('checkPublicTypes.mjs');

const tree = cleanTreeId(ROOT);
const prior = tree && process.env.MANTLE_PUBLISH_RERUN !== '1' ? passedOn(ROOT, tree) : undefined;
if (prior) {
  console.log(
    `\nprepublish: the node and render lanes passed on this tree (${tree.slice(0, 12)}) at ${prior.at}; ` +
      'not running them again (MANTLE_PUBLISH_RERUN=1 runs them).',
  );
  process.exit(0);
}
if (!tree) console.log('\nprepublish: the checkout has uncommitted changes, so the lanes run now.');
step('runLanes.mjs');

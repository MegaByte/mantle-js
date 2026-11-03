#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Prepare npm pack/publish output: generate missing or stale declarations and
// require generated shader artifacts.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => {
  console.error('prepack: ' + m);
  process.exit(1);
};

// Declarations are regenerated when missing or older than any source file, so concurrent packs (a CI lane runs several
// packaging smokes) do not rewrite types/ under each other, and a pack right after gen:types does not do the work twice.
function newestMtime(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}
const typesIndex = path.join(PKG, 'types/index.d.ts');
const sources = Math.max(
  newestMtime(path.join(PKG, 'src')),
  statSync(path.join(PKG, 'package.json')).mtimeMs,
  statSync(path.join(PKG, 'tsconfig.dts.json')).mtimeMs,
  statSync(path.join(PKG, 'scripts/genTypes.mjs')).mtimeMs,
);
if (!existsSync(typesIndex) || statSync(typesIndex).mtimeMs < sources) {
  const t = spawnSync(process.execPath, [path.join(PKG, 'scripts/genTypes.mjs')], {
    cwd: PKG,
    stdio: 'inherit',
  });
  if (t.status !== 0) fail('gen:types failed, so the tarball would have no declarations.');
}
if (!existsSync(path.join(PKG, 'types/index.d.ts'))) fail('types/index.d.ts was not emitted.');

for (const f of ['src/shaders/bundled.js', 'src/shaders/generated/mantle.frag.glsl']) {
  if (!existsSync(path.join(PKG, f))) fail(`${f} is missing; run \`npm run build:shaders\`.`);
}

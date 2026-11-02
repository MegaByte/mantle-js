// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'mantle-renderer-types-gate-'));
try {
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(
    join(here, '../scripts/checkRendererTypes.mjs'),
    join(dir, 'scripts/checkRendererTypes.mjs'),
  );
  mkdirSync(join(dir, 'node_modules'));
  const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  symlinkSync(dirname(dirname(compiler)), join(dir, 'node_modules/typescript'), 'dir');
  const run = () =>
    spawnSync(process.execPath, ['scripts/checkRendererTypes.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 30000,
    });
  let r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /project file missing/);
  assert.doesNotMatch(r.stdout, /PASS/);
  writeFileSync(join(dir, 'tsconfig.checkjs.json'), '{ "compilerOptions": ');
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /compiler\/project failed/);
  assert.doesNotMatch(r.stdout, /PASS/);
  writeFileSync(
    join(dir, 'tsconfig.checkjs.json'),
    JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true },
      include: ['src/**/*.js'],
    }),
  );
  mkdirSync(join(dir, 'src/font'), { recursive: true });
  mkdirSync(join(dir, 'src/renderer'));
  writeFileSync(join(dir, 'src/font/noise.js'), '/** @type {number} */ const noise="wrong";');
  writeFileSync(join(dir, 'src/renderer/valid.js'), '/** @type {number} */ const valid=1;');
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RENDERER TYPE-CHECK PASS/);
  writeFileSync(
    join(dir, 'src/renderer/invalid.js'),
    '/** @type {number} */ const invalid="wrong";',
  );
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /renderer error/);
  assert.doesNotMatch(r.stdout, /PASS/);
  console.log(
    'PASS missing/invalid project refuses; unrelated source noise stays filtered; real renderer error fails',
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Validate source license headers without modifying the package.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
process.stdout.write(
  execFileSync(process.execPath, ['scripts/addSpdxHeaders.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  }),
);

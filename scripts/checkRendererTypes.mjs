#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Run the renderer's checkJs project. Compiler startup failures and diagnostics in
// src/renderer fail the check. Diagnostics in other imported modules are filtered.
// Resolve TypeScript relative to this package, including hoisted installations.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // <pkg>/scripts
const PKG = path.resolve(HERE, '..'); // <pkg> (this package root)
const PROJECT = path.join(PKG, 'tsconfig.checkjs.json');
if (!existsSync(PROJECT)) {
  console.error('RENDERER TYPE-CHECK FAIL — project file missing: ' + PROJECT);
  process.exit(1);
}

// Resolve the tsc CLI through Node from this file's location — walks up
// node_modules wherever typescript actually lives (package or hoisted parent),
// independent of cwd / repo layout. Run it with the current node binary rather
// than the .bin shim (the shim may be absent in some install layouts).
let tscJs;
try {
  tscJs = createRequire(import.meta.url).resolve('typescript/bin/tsc');
} catch {
  console.error('check:types: TypeScript not found. Install it: `npm install -D typescript`.');
  process.exit(2);
}

const r = spawnSync(process.execPath, [tscJs, '-p', PROJECT], { cwd: PKG, encoding: 'utf8' });
const lines = ((r.stdout || '') + (r.stderr || '')).split('\n');
// Project/startup failures cannot be filtered as unrelated source diagnostics.
// In particular, tsc's missing-project TS5058 has no src/renderer prefix.
const configErrors = lines.filter(
  (l) => /error TS\d+/.test(l) && (/^error TS\d+/.test(l.trim()) || /\.json(?:\(\d|:\s)/.test(l)),
);
if (
  r.error ||
  r.signal ||
  configErrors.length ||
  (r.status !== 0 && !lines.some((l) => /error TS\d+/.test(l)))
) {
  console.error('RENDERER TYPE-CHECK FAIL — compiler/project failed:');
  console.error(r.error?.message || r.signal || configErrors.join('\n') || lines.join('\n'));
  process.exit(1);
}
// Match the renderer dir portably (tsc prints POSIX-style relative paths from cwd).
const RENDERER = 'src/renderer/';
const rendererErrors = lines.filter((l) => l.includes(RENDERER) && /error TS\d+/.test(l));

if (rendererErrors.length) {
  console.error('RENDERER TYPE-CHECK FAIL — checkJs errors in src/renderer:\n');
  for (const l of rendererErrors) console.error('  ' + l.trim());
  console.error(
    `\n${rendererErrors.length} renderer error(s). (Non-renderer type-noise is filtered.)`,
  );
  process.exit(1);
}
console.log(
  'RENDERER TYPE-CHECK PASS — src/renderer is checkJs-clean (bare refs, missing props, JSDoc).',
);
process.exit(0);

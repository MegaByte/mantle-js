// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sourceTextSmoke — every source file is plain text.
//
// One raw NUL byte inside a template literal (a map key separator) is right at runtime, but the file reads as binary
// to `file`, to grep and to other tooling, so every search of the source silently skips that module. A separator
// belongs in an escape sequence (`\0`), not in the file.
//
// No GPU: scans src/, scripts/ and test/ for NUL and other C0 control bytes (tab, newline and carriage return allowed).
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = /\.(m?js|glsl|json|d\.ts|ts)$/;
const bad = [];
let files = 0;
function scan(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      scan(p);
      continue;
    }
    if (!EXT.test(name)) continue;
    files++;
    const b = readFileSync(p);
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c < 32 && c !== 9 && c !== 10 && c !== 13) {
        const line = b.subarray(0, i).toString('latin1').split('\n').length;
        bad.push(`${path.relative(ROOT, p)}:${line} byte 0x${c.toString(16).padStart(2, '0')}`);
        break;
      }
    }
  }
}
for (const d of ['src', 'scripts', 'test']) scan(path.join(ROOT, d));
if (bad.length) {
  for (const b of bad) console.log('FAIL control byte in source: ' + b);
  console.log(`\nSOURCE-TEXT FAIL (${bad.length} of ${files} files)`);
  process.exit(1);
}
console.log(`  ok ${files} source files are plain text\n\nSOURCE-TEXT PASS`);

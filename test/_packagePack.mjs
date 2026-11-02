// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Shared by the packaging smokes: `npm pack` this package (lifecycle scripts RUN, so prepack builds types/ and copies
// PROVENANCE.md exactly as a publish would) into a fresh temp directory and list its files.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function packPackage() {
  const dest = mkdtempSync(path.join(os.tmpdir(), 'mantle-pack-'));
  const r = spawnSync('npm', ['pack', '--json', '--pack-destination', dest], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  if (r.error) throw new Error(`npm pack could not start: ${r.error.message}`);
  if (r.status !== 0)
    throw new Error(`npm pack failed (${r.status}): ${(r.stderr || '').slice(-600)}`);
  const out = r.stdout.slice(r.stdout.indexOf('['));
  const info = JSON.parse(out)[0];
  return {
    dest,
    tgz: path.join(dest, info.filename),
    files: info.files.map((f) => f.path),
    size: info.size,
    unpackedSize: info.unpackedSize,
  };
}

export function packageJson() {
  return JSON.parse(readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'));
}

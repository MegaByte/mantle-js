// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// smokeAssetsFreshSmoke -- the committed examples/smoke/ is what scripts/genSmokeAssets.mjs would derive now.
//
// examples/smoke/ holds three kinds of file (see the header of genSmokeAssets.mjs): static fixtures a smoke reads, fixtures a smoke writes as it
// runs, and fixtures the scanner derives from a smoke's inline SVG. Derive into a temporary copy and compare it byte for byte.
// Shader-model fixtures remain development artifacts and are refreshed explicitly with --include-diagnostics.
// FIX when it fails: `node scripts/genSmokeAssets.mjs` and commit examples/smoke.
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL = path.join(ROOT, 'examples', 'smoke');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'mantle-smoke-assets-'));
let fail = 0;
try {
  cpSync(REAL, tmp, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'genSmokeAssets.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MANTLE_SMOKE_ASSETS_DIR: tmp },
    encoding: 'utf8',
    timeout: 240000,
  });
  if (r.status !== 0) {
    console.error('FAIL genSmokeAssets exited', r.status, (r.stderr || '').slice(-400));
    process.exit(1);
  }
  const names = (d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.svg') || f === 'index.json')
      .sort();
  const a = names(REAL),
    b = names(tmp);
  const added = b.filter((f) => !a.includes(f)),
    gone = a.filter((f) => !b.includes(f));
  const changed = a.filter(
    (f) =>
      b.includes(f) &&
      readFileSync(path.join(REAL, f), 'utf8') !== readFileSync(path.join(tmp, f), 'utf8'),
  );
  const ok = (c, m) => {
    console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
    if (!c) fail++;
  };
  ok(
    added.length === 0,
    `a fresh derivation adds no file the repo lacks${added.length ? ': ' + added.slice(0, 6).join(', ') + (added.length > 6 ? ` (+${added.length - 6})` : '') : ''}`,
  );
  ok(
    gone.length === 0,
    `...and drops none${gone.length ? ': ' + gone.slice(0, 6).join(', ') : ''}`,
  );
  ok(
    changed.length === 0,
    `...and changes none (index.json included)${changed.length ? ': ' + changed.slice(0, 6).join(', ') : ''}`,
  );
  if (fail) console.log('  -> run `node scripts/genSmokeAssets.mjs` and commit examples/smoke');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (fail) {
  console.error(`FAIL smokeAssetsFreshSmoke: ${fail}`);
  process.exit(1);
}
console.log('smokeAssetsFreshSmoke PASS');

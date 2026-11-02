// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The build-time generator (genFeatureEntry.mjs) must emit static
// registrations for both SVG features (side-effect imports) AND font readers
// (named import + call) from one scanned asset dir, and emit nothing for
// unused features. The build-time peer of svg/auto + font/auto.
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..', '..'); // js.kontek.mantle
const GEN = join(PKG_ROOT, 'scripts', 'genFeatureEntry.mjs');

// A system CFF (.otf) font exercises the font side; skip cleanly if absent.
const CFF = ['/System/Library/Fonts/Supplemental/STIXGeneral.otf'].find((p) => existsSync(p));
const GLYF = join(PKG_ROOT, 'test', 'font', 'fixtures', 'roboto-regular.ttf');

let failures = 0;
const fail = (m) => {
  console.error('FAIL', m);
  failures++;
};
const ok = (m) => console.log('ok', m);

const dir = mkdtempSync(join(tmpdir(), 'mantle-gen-'));
const out = join(dir, 'mantle.features.js');
try {
  // blur SVG (→ filterGraph/primitives/blur) + a glyf font (→ nothing) +
  // optionally a CFF font (→ font/formats/cff registerCffReader).
  writeFileSync(
    join(dir, 'blur.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><filter id="b" color-interpolation-filters="sRGB">' +
      '<feGaussianBlur stdDeviation="1"/></filter></defs><rect width="10" height="10" filter="url(#b)"/></svg>',
  );
  if (existsSync(GLYF)) copyFileSync(GLYF, join(dir, 'roboto.ttf'));
  if (CFF) copyFileSync(CFF, join(dir, 'cff.otf'));

  const r = spawnSync('node', [GEN, dir, '--out', out], { encoding: 'utf8' });
  if (r.status !== 0) {
    fail(`generator exited ${r.status}: ${r.stderr}`);
  } else {
    const gen = readFileSync(out, 'utf8');

    // SVG side: blur side-effect import present; an unused primitive absent.
    if (gen.includes("import '@kontek/mantle/filterGraph/primitives/blur';"))
      ok('SVG: blur side-effect import emitted');
    else fail('SVG: missing blur side-effect import');
    if (!gen.includes('primitives/morphology'))
      ok('SVG: unused primitive (morphology) NOT emitted');
    else fail('SVG: emitted morphology for an asset set that never uses it');

    // Font side: CFF named import + call (only when the CFF font was present).
    if (CFF) {
      if (gen.includes("import { registerCffReader } from '@kontek/mantle/font/formats/cff';"))
        ok('FONT: CFF named import emitted');
      else fail('FONT: missing registerCffReader import');
      if (/^registerCffReader\(\);$/m.test(gen)) ok('FONT: registerCffReader() call emitted');
      else fail('FONT: registerCffReader() not called');
      if (!gen.includes('font/scripts/arabic')) ok('FONT: unused shaper (arabic) NOT emitted');
      else fail('FONT: emitted arabic shaper for a non-Arabic asset set');
    } else {
      console.log('skip FONT assertions — no system CFF font found');
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\nFEATURE-ENTRY-GEN FAIL (${failures})` : '\nFEATURE-ENTRY-GEN PASS');
process.exit(failures ? 1 : 0);

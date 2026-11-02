// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shaderVariantCompileSmoke -- every program variant the renderer can build must at least COMPILE: the assembled mantle vertex and
// fragment shaders are validated with glslangValidator under every combination of their main defines (an incoherent combination --
// CPatch without Loop-Blinn, the instanced fill with an LB mesh -- is skipped, as the renderer never builds one). A declaration under
// the wrong #ifdef (an identifier read by every program but declared only by the LB ones) passes the build's default validation and
// fails the classic programs in the browser; this is the net for that class. Skips when glslangValidator is absent.
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (spawnSync('glslangValidator', ['-v'], { stdio: 'ignore' }).error) {
  console.log('shaderVariantCompileSmoke SKIP (no glslangValidator)');
  process.exit(0);
}
const dir = mkdtempSync(path.join(tmpdir(), 'mantle-variants-'));
const SETS = {
  vert: [
    'MANTLE_LB_FILL',
    'MANTLE_LB_CURVE_TEX',
    'MANTLE_CPATCH',
    'MANTLE_LB_MORPH',
    'MANTLE_INSTANCED',
    'MANTLE_NO_BEZOUT',
    'MANTLE_COMPOSED',
    'MANTLE_COVER_KERNEL',
  ],
  frag: [
    'MANTLE_LB_FILL',
    'MANTLE_AAC',
    'MANTLE_NO_STROKE',
    'MANTLE_NO_COVER_FILL',
    'MANTLE_CPATCH',
    'MANTLE_STROKE_EXACT',
    'MANTLE_NO_LINE',
  ],
};
const coherent = (c) =>
  !(c.includes('MANTLE_CPATCH') && !c.includes('MANTLE_LB_FILL')) &&
  !(c.includes('MANTLE_INSTANCED') && c.includes('MANTLE_LB_FILL')) &&
  !(c.includes('MANTLE_NO_COVER_FILL') && !c.includes('MANTLE_LB_FILL'));
let failures = 0,
  n = 0;
for (const stage of ['vert', 'frag']) {
  const src = readFileSync(path.join(ROOT, `src/shaders/generated/mantle.${stage}.glsl`), 'utf8');
  const names = SETS[stage];
  for (let m = 0; m < 1 << names.length; m++) {
    const c = names.filter((_, i) => m & (1 << i));
    if (!coherent(c)) continue;
    const defs = c.map((d) => `#define ${d}\n`).join('');
    const body = src.startsWith('#version') ? src.replace('\n', '\n' + defs) : defs + src;
    const f = path.join(dir, `t.${stage}`);
    writeFileSync(f, body);
    const r = spawnSync('glslangValidator', ['-S', stage, f], { encoding: 'utf8' });
    n++;
    if (r.status !== 0) {
      failures++;
      if (failures <= 8)
        console.error(
          `FAIL ${stage} [${c.join(' ')}]: ${r.stdout.split('\n').slice(1, 3).join(' ').slice(0, 200)}`,
        );
    }
  }
}
if (failures) {
  console.error(`shaderVariantCompileSmoke FAIL (${failures} of ${n})`);
  process.exit(1);
}
console.log(`shaderVariantCompileSmoke PASS (${n} variants compile)`);

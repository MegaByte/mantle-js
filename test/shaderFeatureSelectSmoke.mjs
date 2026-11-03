// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shaderFeatureSelectSmoke.mjs — shaderFilesFor() (the shader peer of
// featuresToModules) must resolve a feature bitfield to exactly the generated
// shaders that feature needs, and every file it names must exist. This is what
// scripts/genFeatureEntry.mjs relies on to emit static, feature-scoped shader
// imports next to the JS handler imports — one feature resolution for both.
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { shaderFilesFor, SHADER_FILENAMES } from '../src/shaders/index.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/shaders');
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

// Feature bits (mirror bundle/featureSet.js / FEATURE_SHADER_KEYS).
const FilterBlur = 1n << 16n;
const FilterConvolve = 1n << 22n;

const keysOf = (spec) => new Set(shaderFilesFor(spec).map(([k]) => k));
const all = shaderFilesFor(null);

// 1. No spec → every shader (the "everything" sentinel).
if (all.length === SHADER_FILENAMES.length) ok(`shaderFilesFor(null) = all ${all.length} shaders`);
else fail(`shaderFilesFor(null) returned ${all.length}, expected ${SHADER_FILENAMES.length}`);

// 2. Core-only (no features) is a strict, smaller subset of everything.
const core = keysOf({ features: 0n });
if (core.size > 0 && core.size < all.length) ok(`core-only selects ${core.size} (< ${all.length})`);
else fail(`core-only selection looks wrong: ${core.size}`);

// 3. FilterBlur adds boxBlurFrag; it does NOT pull convolve.
const blur = keysOf({ features: FilterBlur });
if (blur.has('boxBlurFrag') && !blur.has('convolveFrag'))
  ok('FilterBlur adds boxBlurFrag, not convolveFrag');
else fail('FilterBlur selection wrong: ' + [...blur].join(','));

// 3b. Direct-blit shaders (createImage/drawImage — code-driven base APIs) are
//     CORE: present with ZERO features, so consumers never force-include them.
//     But feImageFrag (asset-driven <feImage>) is NOT core.
const blitKeys = [
  'drawImageVert',
  'drawImageFrag',
  'drawImageInstancedVert',
  'drawImageInstancedFrag',
];
if (blitKeys.every((k) => core.has(k)) && !core.has('feImageFrag'))
  ok('drawImage* shaders are core (no feature needed); feImageFrag stays gated');
else
  fail(
    'drawImage core / feImage gating wrong: core has ' +
      blitKeys.filter((k) => core.has(k)).join(',') +
      ' feImageFrag=' +
      core.has('feImageFrag'),
  );

// 4. Selection is additive over core (every core key still present).
if ([...core].every((k) => blur.has(k))) ok('feature selection is additive over core');
else fail('feature selection dropped a core shader');

// 5. Disjoint features pull disjoint extras (blur ⊅ convolve and vice-versa).
const conv = keysOf({ features: FilterConvolve });
if (
  conv.has('convolveFrag') &&
  !conv.has('boxBlurFrag') &&
  blur.has('boxBlurFrag') &&
  !blur.has('convolveFrag')
)
  ok('disjoint features select disjoint extra shaders');
else fail('disjoint-feature selection leaked across features');

// 6. Every file shaderFilesFor names must actually exist on disk (so the
//    generated entry's static imports resolve).
let miss = 0;
for (const [, sub] of all)
  if (!existsSync(path.join(DIR, sub))) {
    miss++;
    if (miss <= 3) console.error('  missing: ' + sub);
  }
if (miss === 0) ok(`all ${all.length} referenced generated/*.glsl exist on disk`);
else fail(`${miss} referenced generated file(s) missing — run: npm run build:shaders`);

// 7. The subpaths are the GENERATED ones (so downstream gets minifiable files).
if (all.every(([, sub]) => sub.startsWith('generated/')))
  ok('shaderFilesFor points at generated/*.glsl');
else fail('shaderFilesFor returned a non-generated path');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nSHADER-FEATURE-SELECT PASS');
process.exit(failures ? 1 : 0);

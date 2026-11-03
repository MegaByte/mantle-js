// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shaderIdentityHarnessSmoke -- a fast slice of the shader-identity harness (test/_shaderIdentity.mjs), run on the SHIPPED
// generated shaders, so the harness cannot rot while nobody is A/B-ing a change through it, and two contracts the lean
// variants rest on are held on every run.
//
// The harness compiles a whole fragment main() from the generated text to float32 C++ (test/_glslMainEmu.mjs) and holds
// two texts to each other fragment for fragment, which proves a shader gate output-identical without a GPU.
// Here, on three synthetic sheets and two small assets:
//   (a) the shipped mantle.frag against itself, under Slug, AAC and the Loop-Blinn unified program's cover quads: every
//       fragment identical, with painted and discarded fragments both present (a harness that only discards proves
//       nothing);
//   (b) THE LEAN VARIANTS ARE THE FULL PROGRAM WITH A FEATURE OFF: MANTLE_NO_EXTCLIP equals the full program with no
//       setNodeClip, and MANTLE_NO_RECOLOR the full program with channel lerp, palette and color matrix disabled, bit for
//       bit. The fill-feature selector (renderer/fillOmit.js) swaps these programs in on exactly that promise;
//   (c) the harness is not vacuous: scaling one multiply by 0.999 is detected at each of the clip, single-fill mask,
//       fill-gradient, pattern, ext-clip and baked-mask sites;
//   (d) maskBake.frag against itself, and a scaled bake output detected;
//   (e) sampleStops alone against itself on wrapped stop LUTs (to 4097 stops here; the full A/B runs to 65536), and an
//       8-bit read of a 24-bit stop offset detected;
//   (f) every fill define set compiles and links, and the two stages agree on each varying's interpolation qualifier
//       (test/_shaderVariantLink.mjs; skipped without glslangValidator).
// SKIPs (exit 77) without a C++ compiler and clang. Before an A/B of a real change, run the full harness:
//   node test/_shaderIdentity.mjs main <before.frag.glsl> <after.frag.glsl>
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasMainEmu } from './_glslMainEmu.mjs';
import {
  compareMain,
  compareBake,
  compareStops,
  defaultAssets,
  SVG_NESTED_CLIPS,
  SVG_PATTERN_MASK_STROKES,
  svgGradientSheet,
} from './_shaderIdentity.mjs';
import { hasLinker, linkVariants } from './_shaderVariantLink.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasMainEmu()) {
  console.log('SKIP shaderIdentityHarnessSmoke: needs a C++17 compiler and clang');
  process.exit(77);
}
const t0 = Date.now();
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const FRAG = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const BAKE = readFileSync(path.join(ROOT, 'src/shaders/generated/maskBake.frag.glsl'), 'utf8');
const small = defaultAssets().filter((a) =>
  ['clipCoverage__CLIP.svg', 'bundleInstanced__MASK_SVG.svg'].includes(a.name),
);
const ASSETS = [
  { name: 'nested_clips', svg: SVG_NESTED_CLIPS },
  { name: 'pattern_mask_strokes', svg: SVG_PATTERN_MASK_STROKES },
  { name: 'gradients', svg: svgGradientSheet({ counts: [3, 16, 1000] }) },
  ...small,
];
const GRID = 8;
const sum = (res, k) => res.reduce((s, r) => s + r[k], 0);

// (a) A/A.
{
  const res = await compareMain(FRAG, FRAG, {
    variants: ['slug', 'aac', 'lbcover'],
    assets: ASSETS,
    grid: GRID,
  });
  const fr = sum(res, 'fragments'),
    disc = sum(res, 'discarded');
  ok(
    sum(res, 'differ') === 0,
    `(a) the shipped mantle.frag equals itself under Slug, AAC and LB cover quads (${fr} fragments)`,
  );
  ok(
    disc > 0 && disc < fr,
    `(a) ...with fragments both painted (${fr - disc}) and discarded (${disc})`,
  );
}

// (b) the lean variants.
{
  const [ext] = await compareMain(FRAG, FRAG, {
    variants: [{ name: 'noExtClip', a: [], b: ['MANTLE_NO_EXTCLIP'] }],
    assets: ASSETS,
    grid: GRID,
    uniforms: (U) => {
      U.set('uExtClipMode', 0);
      return U;
    },
  });
  ok(
    ext.differ === 0,
    `(b) MANTLE_NO_EXTCLIP is the full program with no setNodeClip, bit for bit (${ext.differ} of ${ext.fragments} differ)`,
  );
  const [rec] = await compareMain(FRAG, FRAG, {
    variants: [{ name: 'noRecolor', a: [], b: ['MANTLE_NO_RECOLOR'] }],
    assets: ASSETS,
    grid: GRID,
    uniforms: (U) => {
      U.set('uChannelLerpEnabled', 0);
      U.set('uPaletteEnabled', 0);
      U.set('uColorMatrixEnabled', 0);
      return U;
    },
  });
  ok(
    rec.differ === 0,
    `(b) MANTLE_NO_RECOLOR is the full program with recolor off, bit for bit (${rec.differ} of ${rec.fragments} differ)`,
  );
}

// (c) non-vacuity: each site, scaled, is detected. A hinge that is missing from the text is a FAIL that names it, so a
// rewrite of that code updates this list rather than silently dropping the check.
{
  const hinges = [
    ['clip multiply', '    color *= evalClipCoverage(emCoord, invPx, clipId - 1);\n'],
    ['single-fill mask multiply', '        color *= mCov * w;\n'],
    [
      'fill gradient paint',
      '? sampleGradient(vFillGradId, emCoord, vShapeBBox, emDx, emDy) * vFill',
    ],
    // The composite reads accMean: the mean of the sub-cell samples, which is `acc` itself on the unminified path.
    ['pattern composite', '    color = accMean * fCov * vec4(vFill.rgb * vFill.a, vFill.a);\n'],
    // The two screen multipliers, at the sites that apply them (an early-out tests them for 0 at the top of main).
    [
      'ext-clip multiply',
      '    color *= (uExtClipMode == 2) ? (1.0 - em) : em;\n',
      '    color *= ((uExtClipMode == 2) ? (1.0 - em) : em) * 0.999;\n',
    ],
    ['baked-mask multiply', '        color *= clamp(maskA, 0.0, 1.0);\n'],
  ];
  const scale = (h) => (h.endsWith(';\n') ? h.replace(/;\n$/, ' * 0.999;\n') : h + ' * 0.999');
  for (const [name, h, scaled] of hinges) {
    const n = FRAG.split(h).length - 1;
    if (n !== 1) {
      ok(
        false,
        `(c) the ${name} hinge is in the shipped text exactly once (found ${n}) -- update this smoke`,
      );
      continue;
    }
    const mut = FRAG.replace(h, scaled || scale(h));
    const [r] = await compareMain(FRAG, mut, {
      variants: ['slug'],
      assets: ASSETS,
      grid: GRID,
      opt: '-O0',
    });
    ok(r.differ > 0, `(c) scaling the ${name} by 0.999 is detected (${r.differ} fragments)`);
  }
}

// (d) the bake.
{
  const aa = await compareBake(BAKE, BAKE, { assets: ASSETS.slice(0, 3), grid: GRID });
  ok(
    aa.differ === 0 && aa.fragments > 0,
    `(d) the shipped maskBake.frag equals itself (${aa.fragments} fragments)`,
  );
  const h = 'fragColor = uMaskFullColor != 0 ? vec4(paint.rgb * a, a) : vec4(v, v, v, a);';
  const n = BAKE.split(h).length - 1;
  if (n !== 1)
    ok(
      false,
      `(d) the bake output hinge is in the shipped text exactly once (found ${n}) -- update this smoke`,
    );
  else {
    const r = await compareBake(
      BAKE,
      BAKE.replace(
        h,
        'fragColor = (uMaskFullColor != 0 ? vec4(paint.rgb * a, a) : vec4(v, v, v, a)) * 0.999;',
      ),
      { assets: ASSETS.slice(0, 3), grid: GRID, opt: '-O0' },
    );
    ok(r.differ > 0, `(d) scaling the bake output by 0.999 is detected (${r.differ} fragments)`);
  }
}

// (e) the stop lookup alone.
{
  const counts = [1, 2, 3, 17, 256, 257, 2049, 4097];
  const aa = compareStops(FRAG, FRAG, { counts });
  ok(
    aa.differ === 0 && aa.evaluations > 0,
    `(e) sampleStops equals itself on wrapped LUTs of 1..4097 stops (${aa.evaluations} evaluations)`,
  );
  const h = 'float curOff = oneTexel ? hiT.a : gradStopOffset(hiT);';
  const n = FRAG.split(h).length - 1;
  if (n !== 1)
    ok(
      false,
      `(e) the stop-offset hinge is in the shipped text exactly once (found ${n}) -- update this smoke`,
    );
  else {
    const r = compareStops(FRAG, FRAG.replace(h, 'float curOff = oneTexel ? hiT.a : hiT.x;'), {
      counts,
    });
    ok(
      r.differ > 0,
      `(e) reading a 24-bit stop offset as 8 bits is detected (${r.differ} evaluations)`,
    );
  }
}

// (f) every define set links, qualifiers agree.
if (!hasLinker()) console.log('  skip (f): no glslangValidator');
else {
  const res = linkVariants();
  const bad = res.filter((r) => !r.ok);
  ok(
    bad.length === 0,
    `(f) all ${res.length} fill define sets compile, link and agree on interpolation qualifiers` +
      (bad.length
        ? `: ${bad.map((r) => `[${r.defs.join(' ')}] ${r.errors[0] || ''}`).join('; ')}`
        : ''),
  );
}

console.log(
  `${fail ? 'shaderIdentityHarnessSmoke FAIL' : 'shaderIdentityHarnessSmoke: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);

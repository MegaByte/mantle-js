// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Guard the JS (GLSL) ↔ C# (HLSL) shader constants that MUST stay identical
// for pixel parity. The two coverage/filter shaders are hand-maintained ports
// of each other; a constant changed on one side and not the other silently
// breaks cross-runtime rendering (e.g. coverage-solver Newton iteration count,
// feMorphology kernel cap). Source lint — no GPU, so it runs in CI where the
// Unity batchmode render harness can't.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const GLSL = resolve(here, '../src/shaders/_coverage.glsl');
const HLSL = resolve(here, '../../net.kontek.mantle/Runtime/Shaders/MantleSlug.hlsl');
const MORPH_GLSL = resolve(here, '../src/shaders/morph.frag.glsl');
const MORPH_HLSL = resolve(
  here,
  '../../net.kontek.mantle/Runtime/Shaders/MantleFilterFeMorphology.shader',
);

// Cross-package parity test: it compares this JS package's GLSL against the C#
// package's HLSL, so it needs the net.kontek.mantle sibling. Present in the
// monorepo; ABSENT when this package is split into its own repo — skip cleanly
// there (the parity check only has meaning where both packages coexist).
if (!existsSync(HLSL)) {
  console.log(
    'SHADER-PARITY SKIP — net.kontek.mantle sibling not present (split JS repo); parity is checked in the monorepo.',
  );
  process.exit(0);
}

const glsl = readFileSync(GLSL, 'utf8');
const hlsl = readFileSync(HLSL, 'utf8');
const mGlsl = readFileSync(MORPH_GLSL, 'utf8');
const mHlsl = readFileSync(MORPH_HLSL, 'utf8');

let fails = 0;
const check = (name, a, b) => {
  if (String(a) === String(b)) console.log(`  ok ${name}: ${a}`);
  else {
    console.log(`  FAIL ${name}: GLSL=${a} HLSL=${b}`);
    fails++;
  }
};

// The coverage-solver Newton loop sits just after the `0.5 * (lo + hi)`
// bracket midpoint; capture its iteration count.
//
// The bound may be a #define rather than a literal, so resolve macros. Without
// that, the regex skips the real loop and matches the next one further down the
// file that happens to use a literal — reporting 32 for a loop that runs 5,
// which is worse than no check at all. Anything it cannot resolve is returned
// as a marker string so it fails loudly instead of comparing a wrong number.
function coverageNewtonIters(src) {
  // the GLSL's secant seed divides by sden with no midpoint fallback; the HLSL still seeds at the midpoint
  const anchors = ['float sden = yHi - yLo;', 'float sden = fHi - fLo;', '0.5 * (lo + hi)'];
  const i = anchors.map((a) => src.indexOf(a)).find((k) => k >= 0) ?? -1;
  if (i < 0) return 'missing-seed';
  const m =
    src.slice(i).match(/for\s*\(\s*int\s+k\s*=\s*0;\s*k\s*<\s*([A-Za-z_0-9]+)/) ||
    src.slice(i).match(/\[unroll\(([A-Za-z_0-9]+)\)\]/);
  if (!m) return 'no-loop';
  if (/^\d+$/.test(m[1])) return m[1];
  const def = src.match(new RegExp(`#\\s*define\\s+${m[1]}\\s+(\\d+)`));
  return def ? def[1] : `unresolved:${m[1]}`;
}

// These two DO differ, and legitimately: the counts are not comparable on
// their own because the two solvers seed differently. The GLSL seeds the
// clamped Newton from a SECANT step, which lands close enough that 5 iterations
// converge; the HLSL still seeds from the bracket midpoint, which can start far
// from the root and needs 8 (its own comment records 3 -> ~800px error, 8 ->
// ~0.02px at 4096). Same result, different starting point.
//
// So this pins the understood pair rather than demanding equality — it fires if
// either side moves, which is what would need attention. Porting the secant
// seed to the HLSL is what lets it drop to 5 and makes these equal again.
{
  const g = coverageNewtonIters(glsl),
    h = coverageNewtonIters(hlsl);
  if (g === '5' && h === '8') {
    console.log(
      '  ok coverage-solver Newton iters: GLSL=5 (secant-seeded), HLSL=8 (midpoint-seeded) — known, explained',
    );
  } else if (g === h) {
    console.log(`  ok coverage-solver Newton iters match: ${g}`);
  } else {
    console.log(
      `  FAIL coverage-solver Newton iters: GLSL=${g} HLSL=${h} — not the known 5/8 pair. ` +
        `Either a seed strategy changed or one side drifted; they must converge to the same root.`,
    );
    fails++;
  }
}

// Apex-on-ray rule in the coverage solver. These differ, and knowingly: the GLSL has NO on-the-ray
// tolerance (0 counts as non-negative, as in the line walker, with the segment's ends read
// exactly), the HLSL still has the absolute 1e-6 apex rule the GLSL replaced. Pinned as that pair so
// either side moving fires; porting the rule to MantleSlug.hlsl makes them equal again.
{
  const apexEps = (src) =>
    /bool sLo = yLo >= 0\.0;|\(yLo >= 0\.0\) != sHi/.test(src)
      ? 'none (0 is non-negative)'
      : (src.match(/const float EPS = (1e-6)/) || [])[1] || 'missing';
  const g = apexEps(glsl),
    h = apexEps(hlsl);
  if (g === h) console.log(`  ok coverage apex EPS: ${g}`);
  else if (g === 'none (0 is non-negative)' && h === '1e-6') {
    console.log(
      '  ok coverage apex EPS: GLSL=none, 0 counts as non-negative, HLSL=1e-6 (absolute) — known, HLSL twin pending',
    );
  } else {
    console.log(`  FAIL coverage apex EPS: GLSL=${g} HLSL=${h} — not the known pair`);
    fails++;
  }
}

// feMorphology kernel cap (px/axis) — must match AND use ceil rounding.
const morphCap = (src) => (/\bmin\b[\s\S]{0,40}\b64\.0\b/.test(src) ? '64' : '?');
check('feMorphology cap', morphCap(mGlsl), morphCap(mHlsl));
const morphCeil = (src) => (/\bceil\b/.test(src) ? 'ceil' : 'other');
check('feMorphology rounding', morphCeil(mGlsl), morphCeil(mHlsl));

// Gradient stop sampler: the lower_bound binary search must use the same
// iteration budget in the GLSL helper and both HLSL ports. Too few iters
// silently mis-brackets large gradients on one runtime only. The budget is
// the `for (int it = 0; it < N; ...)` right after the lo/hi seed.
const GRAD_GLSL = resolve(here, '../src/shaders/_gradientHelpers.glsl');
const GRAD_HLSL_COLR = resolve(
  here,
  '../../net.kontek.mantle/Runtime/Shaders/MantleColrHelpers.hlsl',
);
const GRAD_HLSL_SVG = resolve(here, '../../net.kontek.mantle/Runtime/Shaders/MantleCommon.hlsl');
const gradIters = (src) => {
  const i = src.indexOf('int lo = 0, hi = count - 1');
  if (i < 0) return 'missing-binary-search';
  const m = src.slice(i).match(/for\s*\(\s*int\s+it\s*=\s*0;\s*it\s*<\s*(\d+)/);
  return m ? m[1] : 'no-loop';
};
const glslGrad = readFileSync(GRAD_GLSL, 'utf8');
const colrGrad = readFileSync(GRAD_HLSL_COLR, 'utf8');
const svgGrad = readFileSync(GRAD_HLSL_SVG, 'utf8');
const gGlsl = gradIters(glslGrad);
// KNOWN PAIR: the GLSL search is bounded at 16 probes for the 65536-stop cap and reads a
// row-wrapped LUT (i & 2047, i >> 11) with a 24-bit offset for gradients over 256 stops; both
// HLSL samplers stop at 9 probes on a one-row LUT, which is exact for the 256 stops their C#
// packer (MantleSvgGradient.PackStops) caps at. Pinned as that pair so either side moving fires;
// the same sampler in both HLSL files makes them equal.
for (const [name, h] of [
  ['HLSL-COLR', colrGrad],
  ['HLSL-SVG', svgGrad],
]) {
  const hi = gradIters(h);
  if (gGlsl === hi)
    console.log(`  ok gradient binary-search iters match (GLSL vs ${name}): ${gGlsl}`);
  else if (gGlsl === '16' && hi === '9')
    console.log(
      `  ok gradient binary-search iters: GLSL=16 (65536-stop cap), ${name}=9 (256-stop cap) — the known 16/9 pair`,
    );
  else {
    console.log(
      `  FAIL gradient binary-search iters: GLSL=${gGlsl} ${name}=${hi} — not the known 16/9 pair`,
    );
    fails++;
  }
}

// Stop texel layout: all three samplers MUST implement the SIGNED-count fast
// path — negative stopsCount = 1-texel opaque (rgb, offset); positive = 2-texel
// straight RGBA + separate offset. A side on an unconditional 2-texel layout
// (or the premult/offset-in-alpha 1-texel layout) breaks JS↔C# parity AND either
// drops per-stop alpha or mis-reads the stride. The tell is the
// `oneTexel = stopsCount < 0` branch that only the signed layout has.
const fastPath = (src) =>
  /oneTexel\s*=\s*stopsCount\s*<\s*0/.test(src) ? 'signed-fast-path' : 'STALE';
check('gradient stop layout (GLSL)', 'signed-fast-path', fastPath(glslGrad));
check('gradient stop layout (HLSL-COLR)', 'signed-fast-path', fastPath(colrGrad));
check('gradient stop layout (HLSL-SVG)', 'signed-fast-path', fastPath(svgGrad));

if (fails === 0) {
  console.log('SHADER-PARITY PASS');
  process.exit(0);
}
console.log(`SHADER-PARITY FAIL (${fails})`);
process.exit(1);

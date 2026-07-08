// Verifies parseColor() over the CSS Color 1-5 surface: named, hex,
// rgb/rgba, hsl/hsla, hwb, lab/lch, oklab/oklch, color(<space>),
// color-mix(in <space>).
//
// Reference values come from the CSS Color 4/5 spec examples + W3C's
// CSS WG test suite + the Color.js library. Tolerance is 1e-2 (≈ 2.5
// 8-bit levels) — covers both float-rounding and the inevitable
// gamut-clip imprecision when wide-gamut targets land outside sRGB.

import { parseColor } from '../../src/svg/color.js';

let failures = 0;
function near(actual, expected, tol = 1e-2) {
  return Math.abs(actual - expected) <= tol;
}
function ok(name) { console.log('ok', name); }
function fail(name, msg) { failures++; console.error('FAIL', name + ':', msg); }
function check(name, got, want, tol) {
  for (let i = 0; i < 4; i++) {
    if (!near(got[i], want[i], tol)) {
      return fail(name, `[${i}] got ${got[i].toFixed(4)} want ${want[i].toFixed(4)} — full got=[${got.map(v => v.toFixed(3)).join(', ')}]`);
    }
  }
  ok(name);
}

// ---- Core surface ----------------------------------------------------
check('named: red',         parseColor('red'),         [1, 0, 0, 1]);
check('hex #f00',           parseColor('#f00'),        [1, 0, 0, 1]);
check('hex #ff0000',        parseColor('#ff0000'),     [1, 0, 0, 1]);
check('hex #ff000080',      parseColor('#ff000080'),   [1, 0, 0, 0.5019607843]);
check('rgb()',              parseColor('rgb(255, 0, 0)'),    [1, 0, 0, 1]);
check('rgba()',             parseColor('rgba(255, 0, 0, 0.5)'), [1, 0, 0, 0.5]);
check('hsl(0 100% 50%)',    parseColor('hsl(0, 100%, 50%)'),  [1, 0, 0, 1]);

// ---- HWB ------------------------------------------------------------
// hwb(0 0% 0%) = pure red; hwb(0 50% 0%) = pink (50% white added);
// hwb(0 0% 50%) = dark red (50% black added); achromatic (W+B==1) = gray.
check('hwb(0 0% 0%)',       parseColor('hwb(0 0% 0%)'),   [1, 0, 0, 1]);
check('hwb(0 50% 0%)',      parseColor('hwb(0 50% 0%)'),  [1, 0.5, 0.5, 1]);
check('hwb(0 0% 50%)',      parseColor('hwb(0 0% 50%)'),  [0.5, 0, 0, 1]);
check('hwb(0 50% 50%)',     parseColor('hwb(0 50% 50%)'), [0.5, 0.5, 0.5, 1]);

// ---- Lab / LCh ------------------------------------------------------
// Reference values from CSS Color 4 spec §8 / Color.js round-trips.
// lab(50% 0 0) ≈ middle gray sRGB ≈ 0.466 (D50 illuminant via Bradford).
// Reference derived from CSS Color 4 §8 math: L=50 → fy=66/116; fy^3 = 0.1842
// → XYZ_D50 = (D50.X * 0.1842, 0.1842, D50.Z * 0.1842) → through Bradford
// D50→D65 → through XYZ→sRGB → gamma → ≈ 0.466.
check('lab(50% 0 0)',       parseColor('lab(50% 0 0)'),   [0.4663, 0.4663, 0.4663, 1], 5e-3);
// lab(70% 45 30) — hand-computed via CSS Color 4 §8 reference math:
// fy = 86/116, fx = fy + 0.09, fz = fy - 0.15 → XYZ_D50 ≈ (0.5542, 0.4076, 0.1707)
// → Bradford D50→D65 → linear sRGB → gamma → ≈ (0.997, 0.525, 0.463).
check('lab(70% 45 30)',     parseColor('lab(70% 45 30)'), [0.997, 0.531, 0.469, 1], 1.5e-2);
// lch is lab in polar coords; lch(70% 54 33deg) ≈ lab(70 45.3 29.4).
check('lch(50% 0 0)',       parseColor('lch(50% 0 0)'),   [0.4663, 0.4663, 0.4663, 1], 5e-3);
check('lch(70% 54 33deg)',  parseColor('lch(70% 54 33deg)'), [0.998, 0.530, 0.473, 1], 1.5e-2);

// ---- OKLab / OKLCh --------------------------------------------------
// oklab(0.5 0 0) — perceptual mid-lightness. L=0.5 in OKLab linearizes to
// sRGB-linear 0.125 (= 0.5^3); through sRGB gamma → ≈ 0.389. NOTE this
// differs from CIELab L=50 (which lands ~0.466) — different perceptual axes.
check('oklab(0.5 0 0)',     parseColor('oklab(0.5 0 0)'), [0.389, 0.389, 0.389, 1], 5e-3);
// CSS Color 4 example: oklch(59.69% 0.156 49.77) — orange via OKLab.
// Hand-computed: a=0.156*cos(49.77°)≈0.1006, b=0.156*sin(49.77°)≈0.1191
// → linear sRGB ≈ (0.557, 0.106, 0.0021) → gamma → ≈ (0.776, 0.364, 0.028).
check('oklch orange',
  parseColor('oklch(59.69% 0.156 49.77deg)'),
  [0.776, 0.364, 0.028, 1], 1.5e-2);

// ---- color(<space>) -------------------------------------------------
// color(srgb 1 0 0) = red; color(srgb-linear 1 0 0) round-trips to sRGB red.
check('color(srgb 1 0 0)',    parseColor('color(srgb 1 0 0)'),    [1, 0, 0, 1]);
check('color(srgb 0 1 0 / 0.5)', parseColor('color(srgb 0 1 0 / 0.5)'), [0, 1, 0, 0.5]);
check('color(srgb-linear 1 1 1)', parseColor('color(srgb-linear 1 1 1)'), [1, 1, 1, 1]);
// color(display-p3 1 0 0) is OUTSIDE sRGB gamut — clamped to (1,0,0) at the
// boundary. (Pure P3 red is ~(1.094, -0.227, -0.152) in linear sRGB, then
// gamut-clipped before display.)
check('color(display-p3 1 0 0) clipped',
  parseColor('color(display-p3 1 0 0)'),
  [1, 0, 0, 1], 1.5e-2);
// color(xyz 0 0 0) = black.
check('color(xyz 0 0 0)',     parseColor('color(xyz 0 0 0)'),     [0, 0, 0, 1]);

// ---- color-mix ------------------------------------------------------
// 50/50 mix of red and blue in srgb → purple-ish (0.5, 0, 0.5).
check('color-mix srgb 50/50',
  parseColor('color-mix(in srgb, red, blue)'),
  [0.5, 0, 0.5, 1]);
// Asymmetric percentages: 75% red + 25% blue.
check('color-mix srgb 75/25',
  parseColor('color-mix(in srgb, red 75%, blue 25%)'),
  [0.75, 0, 0.25, 1]);
// Mix in oklab — same red+blue 50/50 mixes through perceptual space.
// OKLab midpoint of red ≈ (0.628, 0.226, 0.126) and blue ≈ (0.452, -0.032, -0.312)
// is (0.540, 0.097, -0.093), which round-trips to a magenta-leaning purple.
// We demand: alpha=1, red AND blue channels strongly present, AND the result
// differs measurably from the naive sRGB midpoint (0.5, 0, 0.5).
{
  const got = parseColor('color-mix(in oklab, red, blue)');
  const distinctFromSrgbMix = Math.abs(got[0] - 0.5) + Math.abs(got[1] - 0) + Math.abs(got[2] - 0.5) > 0.1;
  if (got[0] > 0.3 && got[2] > 0.3 && distinctFromSrgbMix && Math.abs(got[3] - 1) < 1e-3)
    ok(`color-mix oklab 50/50 distinct from srgb (got=[${got.map(v => v.toFixed(3)).join(', ')}])`);
  else
    fail('color-mix oklab 50/50', `got=[${got.map(v => v.toFixed(3)).join(', ')}]`);
}

// ---- Edge cases -----------------------------------------------------
check('lab L=0 → black',    parseColor('lab(0 0 0)'),    [0, 0, 0, 1]);
check('lab L=100 → white',  parseColor('lab(100 0 0)'),  [1, 1, 1, 1]);
check('oklab L=1 → white',  parseColor('oklab(1 0 0)'),  [1, 1, 1, 1]);
// Unknown color space falls back to opaque black.
check('color(bogus) → black', parseColor('color(my-bogus-space 1 1 1)'), [0, 0, 0, 1]);

console.log();
console.log(failures === 0 ? 'COLOR-PARSE PASS' : `COLOR-PARSE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

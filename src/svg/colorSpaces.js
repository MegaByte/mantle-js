// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/colorSpaces.js — the color spaces of CSS Color 4 and the conversions between them.
//
// Every space converts through LINEAR-LIGHT sRGB (unclamped, so a wide-gamut or out-of-gamut color keeps its value until the
// final gamut clip): toLinSrgb(space, c) and fromLinSrgb(space, lin). A color is [c1, c2, c3] in the space's own units
// (rgb-like spaces 0..1, hsl / hwb with s l w b in 0..1 and the hue in degrees, lab L 0..100, oklab L 0..1, lch / oklch hue in
// degrees). NaN stands for a missing (`none`) component and is never produced here except for a powerless hue.
//
// Pure functions, no state.

/// Convert hsl(h, s, l) → rgb [0..1] floats. h in degrees, s/l in [0,1].
export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0,
    g1 = 0,
    b1 = 0;
  if (h < 60) {
    r1 = c;
    g1 = x;
  } else if (h < 120) {
    r1 = x;
    g1 = c;
  } else if (h < 180) {
    g1 = c;
    b1 = x;
  } else if (h < 240) {
    g1 = x;
    b1 = c;
  } else if (h < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  return [r1 + m, g1 + m, b1 + m];
}

/// HWB → RGB. h in degrees, w/b in [0,1]. Per CSS Color 4 §6.
export function hwbToRgb(h, w, b) {
  if (w + b >= 1) {
    const g = w / (w + b);
    return [g, g, g];
  }
  const [r0, g0, b0] = hslToRgb(h, 1, 0.5);
  const f = 1 - w - b;
  return [r0 * f + w, g0 * f + w, b0 * f + w];
}

/// sRGB [0..1] → [h degrees (NaN when powerless), s, l] in 0..1.
export function rgbToHsl(r, g, b) {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  const l = (mx + mn) / 2;
  let h = NaN,
    s = 0;
  if (Math.abs(d) > 1e-9) {
    s = l === 0 || l === 1 ? 0 : (mx - l) / Math.min(l, 1 - l);
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

/// sRGB [0..1] → [h degrees (NaN when powerless), w, b] in 0..1.
export function rgbToHwb(r, g, b) {
  const [h] = rgbToHsl(r, g, b);
  const w = Math.min(r, g, b),
    bl = 1 - Math.max(r, g, b);
  return [w + bl >= 1 - 1e-9 ? NaN : h, w, bl];
}

// The sRGB transfer function, extended odd-symmetrically below zero (CSS Color 4 §10.1) so an out-of-gamut channel keeps its sign.
export function srgbToLin(c) {
  const a = Math.abs(c);
  return a <= 0.04045 ? c / 12.92 : Math.sign(c) * Math.pow((a + 0.055) / 1.055, 2.4);
}
export function linToSrgb(c) {
  const a = Math.abs(c);
  return a <= 0.0031308 ? c * 12.92 : Math.sign(c) * (1.055 * Math.pow(a, 1 / 2.4) - 0.055);
}

/// Linear-light sRGB (D65) ↔ CIE XYZ (D65). IEC 61966-2-1.
function linSrgbToXyzD65(r, g, b) {
  return [
    0.4123907992659593 * r + 0.3575843393838779 * g + 0.1804807884018343 * b,
    0.2126390058715102 * r + 0.7151686787677559 * g + 0.0721923153607338 * b,
    0.0193308187155918 * r + 0.1191947797946259 * g + 0.9505321522496608 * b,
  ];
}
function xyzD65ToLinSrgb(x, y, z) {
  return [
    3.2409699419045226 * x - 1.5373831775700935 * y - 0.4986107602930033 * z,
    -0.9692436362808796 * x + 1.8759675015077202 * y + 0.04155505740717561 * z,
    0.05563007969699366 * x - 0.20397695888897652 * y + 1.0569715142428786 * z,
  ];
}

// Bradford-adapted D50↔D65 (CSS Color 4 reference).
function xyzD50ToD65(x, y, z) {
  return [
    0.9554734527042182 * x - 0.0230985368742614 * y + 0.0632593086610217 * z,
    -0.0283697069452221 * x + 1.0099954580058226 * y + 0.0210413976932351 * z,
    0.0123140016883199 * x - 0.0205076964334786 * y + 1.3303659730912839 * z,
  ];
}
function xyzD65ToD50(x, y, z) {
  return [
    1.0479298208405488 * x + 0.0229467933410191 * y - 0.0501922295005383 * z,
    0.0296278156881013 * x + 0.9904344075599996 * y - 0.0170491933179229 * z,
    -0.0092430581525912 * x + 0.0150569503031266 * y + 0.7518742899580008 * z,
  ];
}

// CIELab (D50) ↔ XYZ (D50). CSS Color 4 §8.
const LAB_EPS = 216 / 24389,
  LAB_KAPPA = 24389 / 27;
// The D50 white of Lab IS sRGB white carried through the D65 → D50 adaptation above, so white is exactly (100, 0, 0) and every gray has
// zero chroma (CSS Color 4 names x = 0.3457, y = 0.3585 = [0.9643, 1, 0.8251]; the rounded matrices here agree with it to 4e-5, which
// alone would give white a chroma of 0.005 and a powerless hue a direction).
const D50_WHITE = xyzD65ToD50(...linSrgbToXyzD65(1, 1, 1));
function labToXyzD50(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const f3x = fx * fx * fx,
    f3z = fz * fz * fz;
  const xr = f3x > LAB_EPS ? f3x : (116 * fx - 16) / LAB_KAPPA;
  const yr = L > LAB_KAPPA * LAB_EPS ? Math.pow(fy, 3) : L / LAB_KAPPA;
  const zr = f3z > LAB_EPS ? f3z : (116 * fz - 16) / LAB_KAPPA;
  return [xr * D50_WHITE[0], yr * D50_WHITE[1], zr * D50_WHITE[2]];
}
function xyzD50ToLab(x, y, z) {
  const f = (t) => (t > LAB_EPS ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116);
  const fx = f(x / D50_WHITE[0]),
    fy = f(y / D50_WHITE[1]),
    fz = f(z / D50_WHITE[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function polarToRect(L, C, h) {
  const rad = ((Number.isNaN(h) ? 0 : h) * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}
function rectToPolar(L, a, b, eps) {
  const C = Math.hypot(a, b);
  const h = C <= eps ? NaN : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return [L, C, h];
}

// OKLab ↔ linear sRGB (Björn Ottosson). Skips XYZ: the matrices go straight from linear sRGB.
function oklabToLinSrgb(L, a, b) {
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l * l * l,
    m3 = m * m * m,
    s3 = s * s * s;
  return [
    +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}
function linSrgbToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// Wide-gamut RGB spaces: linear → XYZ matrices (CSS Color 4) and transfer functions. The inverse matrices are computed once.
const mulv = (m, x, y, z) => [
  m[0] * x + m[1] * y + m[2] * z,
  m[3] * x + m[4] * y + m[5] * z,
  m[6] * x + m[7] * y + m[8] * z,
];
function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h,
    B = f * g - d * i,
    C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    C / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
}
const M_P3 = [
  0.4865709486482162, 0.26566769316909306, 0.1982172852343625, 0.2289745640697488,
  0.6917385218365064, 0.079286914093745, 0, 0.04511338185890264, 1.043944368900976,
];
const M_A98 = [
  0.5766690429101305, 0.1855582379065463, 0.1882286462349947, 0.29734497525053605,
  0.6273635662554661, 0.07529145849399788, 0.02703136138004471, 0.07068885253582722,
  0.9913375368376388,
];
const M_PRO = [
  0.7977604896723027, 0.13518583717574031, 0.0313493495815248, 0.2880711282292934,
  0.7118432178101014, 0.00008565396060525902, 0, 0, 0.8251046025104601,
];
const M_2020 = [
  0.6369580483012914, 0.14461690358620832, 0.1688809751641721, 0.2627002120112671,
  0.6779980715188708, 0.05930171646986196, 0, 0.028072693049087428, 1.060985057710791,
];
let INV = null;
const inv = () =>
  INV ||
  (INV = { p3: invert3(M_P3), a98: invert3(M_A98), pro: invert3(M_PRO), r2020: invert3(M_2020) });

const sgn = Math.sign;
const decodeA98 = (c) => sgn(c) * Math.pow(Math.abs(c), 563 / 256);
const encodeA98 = (c) => sgn(c) * Math.pow(Math.abs(c), 256 / 563);
const decodePro = (c) => (Math.abs(c) < 16 / 512 ? c / 16 : sgn(c) * Math.pow(Math.abs(c), 1.8));
const encodePro = (c) => (Math.abs(c) < 1 / 512 ? c * 16 : sgn(c) * Math.pow(Math.abs(c), 1 / 1.8));
const R2020_A = 1.09929682680944,
  R2020_B = 0.018053968510807;
const decode2020 = (c) =>
  Math.abs(c) < R2020_B * 4.5
    ? c / 4.5
    : sgn(c) * Math.pow((Math.abs(c) + R2020_A - 1) / R2020_A, 1 / 0.45);
const encode2020 = (c) =>
  Math.abs(c) < R2020_B
    ? 4.5 * c
    : sgn(c) * (R2020_A * Math.pow(Math.abs(c), 0.45) - (R2020_A - 1));

/// The spaces a CSS color can be in. `keys` are the component names relative-color syntax and color-mix analogy use; `hue` is the
/// index of the hue component (-1 for none); `polar` spaces take a hue interpolation method.
export const SPACES = {
  srgb: { keys: ['r', 'g', 'b'], hue: -1 },
  'srgb-linear': { keys: ['r', 'g', 'b'], hue: -1 },
  'display-p3': { keys: ['r', 'g', 'b'], hue: -1 },
  'a98-rgb': { keys: ['r', 'g', 'b'], hue: -1 },
  'prophoto-rgb': { keys: ['r', 'g', 'b'], hue: -1 },
  rec2020: { keys: ['r', 'g', 'b'], hue: -1 },
  xyz: { keys: ['x', 'y', 'z'], hue: -1 },
  'xyz-d65': { keys: ['x', 'y', 'z'], hue: -1 },
  'xyz-d50': { keys: ['x', 'y', 'z'], hue: -1 },
  lab: { keys: ['l', 'a', 'b'], hue: -1 },
  oklab: { keys: ['l', 'a', 'b'], hue: -1 },
  lch: { keys: ['l', 'c', 'h'], hue: 2 },
  oklch: { keys: ['l', 'c', 'h'], hue: 2 },
  hsl: { keys: ['h', 's', 'l'], hue: 0 },
  hwb: { keys: ['h', 'w', 'b'], hue: 0 },
};

const OKLCH_EPS = 4e-6,
  LCH_EPS = 0.0015;

/// A color's components in linear-light sRGB (unclamped). NaN (missing) components count as 0.
export function toLinSrgb(space, c) {
  const x = Number.isNaN(c[0]) ? 0 : c[0],
    y = Number.isNaN(c[1]) ? 0 : c[1],
    z = Number.isNaN(c[2]) ? 0 : c[2];
  switch (space) {
    case 'srgb':
      return [srgbToLin(x), srgbToLin(y), srgbToLin(z)];
    case 'srgb-linear':
      return [x, y, z];
    case 'display-p3': {
      const [X, Y, Z] = mulv(M_P3, srgbToLin(x), srgbToLin(y), srgbToLin(z));
      return xyzD65ToLinSrgb(X, Y, Z);
    }
    case 'a98-rgb': {
      const [X, Y, Z] = mulv(M_A98, decodeA98(x), decodeA98(y), decodeA98(z));
      return xyzD65ToLinSrgb(X, Y, Z);
    }
    case 'prophoto-rgb': {
      const [X, Y, Z] = mulv(M_PRO, decodePro(x), decodePro(y), decodePro(z));
      const [X6, Y6, Z6] = xyzD50ToD65(X, Y, Z);
      return xyzD65ToLinSrgb(X6, Y6, Z6);
    }
    case 'rec2020': {
      const [X, Y, Z] = mulv(M_2020, decode2020(x), decode2020(y), decode2020(z));
      return xyzD65ToLinSrgb(X, Y, Z);
    }
    case 'xyz':
    case 'xyz-d65':
      return xyzD65ToLinSrgb(x, y, z);
    case 'xyz-d50': {
      const [X, Y, Z] = xyzD50ToD65(x, y, z);
      return xyzD65ToLinSrgb(X, Y, Z);
    }
    case 'lab': {
      const [X, Y, Z] = labToXyzD50(x, y, z);
      const [X6, Y6, Z6] = xyzD50ToD65(X, Y, Z);
      return xyzD65ToLinSrgb(X6, Y6, Z6);
    }
    case 'lch': {
      const [L, a, b] = polarToRect(x, y, z);
      const [X, Y, Z] = labToXyzD50(L, a, b);
      const [X6, Y6, Z6] = xyzD50ToD65(X, Y, Z);
      return xyzD65ToLinSrgb(X6, Y6, Z6);
    }
    case 'oklab':
      return oklabToLinSrgb(x, y, z);
    case 'oklch': {
      const [L, a, b] = polarToRect(x, y, z);
      return oklabToLinSrgb(L, a, b);
    }
    case 'hsl': {
      const [r, g, b] = hslToRgb(x, y, z);
      return [srgbToLin(r), srgbToLin(g), srgbToLin(b)];
    }
    case 'hwb': {
      const [r, g, b] = hwbToRgb(x, y, z);
      return [srgbToLin(r), srgbToLin(g), srgbToLin(b)];
    }
    default:
      return [0, 0, 0];
  }
}

/// Linear-light sRGB → the components of `space`. A hue that is powerless there (zero chroma, zero saturation, w + b >= 1) is NaN.
export function fromLinSrgb(space, lin) {
  const [r, g, b] = lin;
  switch (space) {
    case 'srgb':
      return [linToSrgb(r), linToSrgb(g), linToSrgb(b)];
    case 'srgb-linear':
      return [r, g, b];
    case 'display-p3': {
      const [X, Y, Z] = linSrgbToXyzD65(r, g, b);
      const q = mulv(inv().p3, X, Y, Z);
      return [linToSrgb(q[0]), linToSrgb(q[1]), linToSrgb(q[2])];
    }
    case 'a98-rgb': {
      const [X, Y, Z] = linSrgbToXyzD65(r, g, b);
      const q = mulv(inv().a98, X, Y, Z);
      return [encodeA98(q[0]), encodeA98(q[1]), encodeA98(q[2])];
    }
    case 'prophoto-rgb': {
      const [X, Y, Z] = linSrgbToXyzD65(r, g, b);
      const [X5, Y5, Z5] = xyzD65ToD50(X, Y, Z);
      const q = mulv(inv().pro, X5, Y5, Z5);
      return [encodePro(q[0]), encodePro(q[1]), encodePro(q[2])];
    }
    case 'rec2020': {
      const [X, Y, Z] = linSrgbToXyzD65(r, g, b);
      const q = mulv(inv().r2020, X, Y, Z);
      return [encode2020(q[0]), encode2020(q[1]), encode2020(q[2])];
    }
    case 'xyz':
    case 'xyz-d65':
      return linSrgbToXyzD65(r, g, b);
    case 'xyz-d50': {
      const [X, Y, Z] = linSrgbToXyzD65(r, g, b);
      return xyzD65ToD50(X, Y, Z);
    }
    case 'lab':
    case 'lch': {
      const [X, Y, Z] = linSrgbToXyzD65(r, g, b);
      const [X5, Y5, Z5] = xyzD65ToD50(X, Y, Z);
      const [L, a, bb] = xyzD50ToLab(X5, Y5, Z5);
      return space === 'lab' ? [L, a, bb] : rectToPolar(L, a, bb, LCH_EPS);
    }
    case 'oklab':
      return linSrgbToOklab(r, g, b);
    case 'oklch': {
      const [L, a, bb] = linSrgbToOklab(r, g, b);
      return rectToPolar(L, a, bb, OKLCH_EPS);
    }
    case 'hsl':
      return rgbToHsl(linToSrgb(r), linToSrgb(g), linToSrgb(b));
    case 'hwb':
      return rgbToHwb(linToSrgb(r), linToSrgb(g), linToSrgb(b));
    default:
      return [0, 0, 0];
  }
}

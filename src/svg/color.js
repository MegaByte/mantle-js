// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/color.js — CSS color parsing for SVG.
//
// Pure-function leaf module (with colorSpaces.js for the conversions and colorMath.js for math functions inside a color). It parses
// the CSS Color 4 / 5 grammar STRICTLY: a string that is not a valid <color> is INVALID, which is what lets the cascade drop the
// declaration and fall back to the inherited value (cssDecl.js isColorValue, style.js getStyleProp), exactly as a browser does.
//
// parseColorStrict(s) → [r, g, b, a] in [0, 1] (un-premultiplied sRGB) or null when `s` is not a valid color. Accepted:
//   - keywords: the named colors, `transparent`, the CSS system colors (a light color scheme), `currentcolor` (see below)
//   - #hex of 3, 4, 6 or 8 digits
//   - rgb() / rgba(), hsl() / hsla(): the legacy comma form (all-number or all-percentage channels; hsl saturation and lightness
//     percentages; an optional alpha after a comma) and the modern space form (numbers, percentages and `none`; `/ alpha`)
//   - hwb(), lab(), lch(), oklab(), oklch() (modern form), color(<space> c1 c2 c3 [/ a]) for srgb, srgb-linear, display-p3,
//     a98-rgb, prophoto-rgb, rec2020, xyz, xyz-d50, xyz-d65
//   - color-mix(in <space> [<hue method> hue], c1 [p1], c2 [p2]) in every CSS Color 4 space, premultiplied, with the hue
//     methods, the percentage normalization (a sum under 100% scales the alpha) and missing / powerless components
//   - light-dark(a, b): the light color scheme's value, `a`
//   - relative color syntax: rgb(from <color> r g b / alpha), likewise hsl, hwb, lab, lch, oklab, oklch and color(from <color> <space> ...)
//   - calc(), min(), max(), clamp(), round(), mod(), rem(), abs(), sign(), sqrt(), pow(), hypot(), log(), exp() and the trigonometric
//     functions in place of any channel, hue or alpha
//   - `none` as a channel
// Not supported (reported as invalid, never as black): a `color(--name ...)` custom color space (needs @color-profile), the
// `device-cmyk()` function, and `env()`/`var()` (resolved before this module, by style.js).
// `currentcolor` inside color-mix(), light-dark() or a relative color is resolved by style.js BEFORE parsing; given to this module
// it reads as opaque black with a one-time warning.
//
// Wide-gamut results are gamut-clipped (each sRGB channel clamped to [0, 1]) at the boundary, as a browser does for an sRGB
// canvas. `resolveCurrentColor` (which walks the element tree for inherited `color:`) lives in svg/style.js.

import {
  SPACES,
  hslToRgb,
  hwbToRgb,
  toLinSrgb,
  fromLinSrgb,
  linToSrgb,
  rgbToHsl,
} from './colorSpaces.js';
import { evalColorMath, isMathFunction } from './colorMath.js';
import { mantleWarn } from '../core/diagnostics.js';

export { hslToRgb, hwbToRgb };

export const CSS_NAMED_COLORS = {
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  black: '#000000',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  cyan: '#00ffff',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  darkgreen: '#006400',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  gray: '#808080',
  grey: '#808080',
  green: '#008000',
  greenyellow: '#adff2f',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  lightgreen: '#90ee90',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  magenta: '#ff00ff',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  red: '#ff0000',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  white: '#ffffff',
  whitesmoke: '#f5f5f5',
  yellow: '#ffff00',
  yellowgreen: '#9acd32',
  none: 'transparent',
  transparent: 'transparent',
};

/// The CSS system colors in a light color scheme, [r, g, b, a] in 0..255: the values Chrome gives an SVG document (the keyword names
/// are CSS Color 4 §6.2 and the deprecated set). The names are the validity set cssDecl.js judges a color by.
export const SYSTEM_COLORS = {
  activeborder: [0, 0, 0, 1],
  activecaption: [255, 255, 255, 1],
  appworkspace: [255, 255, 255, 1],
  background: [255, 255, 255, 1],
  buttonface: [239, 239, 239, 1],
  buttonhighlight: [239, 239, 239, 1],
  buttonshadow: [239, 239, 239, 1],
  buttontext: [0, 0, 0, 1],
  captiontext: [0, 0, 0, 1],
  graytext: [128, 128, 128, 1],
  highlight: [128, 188, 253, 0.6],
  highlighttext: [0, 0, 0, 1],
  inactiveborder: [0, 0, 0, 1],
  inactivecaption: [255, 255, 255, 1],
  inactivecaptiontext: [128, 128, 128, 1],
  infobackground: [255, 255, 255, 1],
  infotext: [0, 0, 0, 1],
  menu: [255, 255, 255, 1],
  menutext: [0, 0, 0, 1],
  scrollbar: [255, 255, 255, 1],
  threeddarkshadow: [0, 0, 0, 1],
  threedface: [239, 239, 239, 1],
  threedhighlight: [0, 0, 0, 1],
  threedlightshadow: [0, 0, 0, 1],
  threedshadow: [0, 0, 0, 1],
  window: [255, 255, 255, 1],
  windowframe: [0, 0, 0, 1],
  windowtext: [0, 0, 0, 1],
  activetext: [255, 0, 0, 1],
  buttonborder: [0, 0, 0, 1],
  canvas: [255, 255, 255, 1],
  canvastext: [0, 0, 0, 1],
  field: [255, 255, 255, 1],
  fieldtext: [0, 0, 0, 1],
  linktext: [0, 0, 238, 1],
  mark: [255, 255, 0, 1],
  marktext: [0, 0, 0, 1],
  selecteditem: [179, 215, 255, 1],
  selecteditemtext: [0, 0, 0, 1],
  visitedtext: [85, 26, 139, 1],
};

/// CSS Color 4 §6.2 also defines AccentColor and AccentColorText (the UA's accent color for form controls and the color that contrasts with
/// it); their values are the user agent's. Chrome (the reference, 147) rejects both keywords, so they are valid only by default:
/// setColorCompat('chrome') leaves them out. The values are the common default accent (Chrome's #0075ff) and white.
export const ACCENT_COLORS = { accentcolor: [0, 117, 255, 1], accentcolortext: [255, 255, 255, 1] };
let colorCompatChrome = false;
/// importSvg's `compat` for color parsing, held for the duration of an import like the active stylesheet is (importer.js sets it and
/// puts it back in `finally`). The parse cache is per mode.
export function setColorCompat(mode) {
  colorCompatChrome = mode === 'chrome';
  COLOR_CACHE = colorCompatChrome ? COLOR_CACHE_CHROME : COLOR_CACHE_SPEC;
}
/// The [r, g, b, a] (0..255, 0..1) of a CSS system color keyword (lower case) in the current mode, or undefined.
export function systemColorOf(name) {
  if (Object.prototype.hasOwnProperty.call(SYSTEM_COLORS, name)) return SYSTEM_COLORS[name];
  return colorCompatChrome || !Object.prototype.hasOwnProperty.call(ACCENT_COLORS, name)
    ? undefined
    : ACCENT_COLORS[name];
}

// ---- the parsed form ---------------------------------------------------------------------------------------------------------
// A color mid-parse is { s: space, c: [c1, c2, c3], a }. NaN is a missing (`none`) component or alpha. Spaces are colorSpaces.js's.
const col = (s, c, a = 1) => ({ s, c, a });
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const isNaNv = Number.isNaN;

// The key by which a component of a space is "analogous" to one of another space (CSS Color 4 §12.2): a missing component carries
// into a conversion only where the target space has a component with the same key. As Chrome applies it: the three components of
// every rgb-like space and xyz pair by position; lightness is shared by Lab, LCH, OKLab, OKLCH and HSL; a / b by Lab and OKLab;
// chroma by LCH, OKLCH and HSL saturation; hue by HSL, HWB, LCH and OKLCH, except that LCH / OKLCH hue does not reach HWB.
const ANALOGUE = {
  lab: ['L', 'a', 'b'],
  oklab: ['L', 'a', 'b'],
  lch: ['L', 'C', 'H'],
  oklch: ['L', 'C', 'H'],
  hsl: ['H', 'C', 'L'],
  hwb: ['H', 'W', 'K'],
};
const analogue = (space, i) => (ANALOGUE[space] || ['R', 'G', 'B'])[i];

/// `col` expressed in `to`. Exact shortcuts for hsl / hwb ↔ sRGB; everything else goes through linear sRGB. A powerless hue
/// comes out NaN (missing); a missing component of `col` stays missing where `to` has an analogous one, and reads 0 elsewhere.
function convert(c, to) {
  if (c.s === to) return c;
  let out;
  if (to === 'srgb' && c.s === 'hsl')
    out = hslToRgb(
      isNaNv(c.c[0]) ? 0 : c.c[0],
      isNaNv(c.c[1]) ? 0 : c.c[1],
      isNaNv(c.c[2]) ? 0 : c.c[2],
    );
  else if (to === 'srgb' && c.s === 'hwb')
    out = hwbToRgb(
      isNaNv(c.c[0]) ? 0 : c.c[0],
      isNaNv(c.c[1]) ? 0 : c.c[1],
      isNaNv(c.c[2]) ? 0 : c.c[2],
    );
  else if (to === 'hsl' && c.s === 'srgb') out = rgbToHsl(c.c[0], c.c[1], c.c[2]);
  else out = fromLinSrgb(to, toLinSrgb(c.s, c.c));
  for (let i = 0; i < 3; i++) {
    if (!isNaNv(c.c[i])) continue;
    const key = analogue(c.s, i);
    if (key === 'H' && to === 'hwb' && (c.s === 'lch' || c.s === 'oklch')) continue;
    for (let j = 0; j < 3; j++) if (analogue(to, j) === key) out[j] = NaN;
  }
  // A missing chroma / saturation leaves the hue powerless, so it is missing too.
  if ((to === 'lch' || to === 'oklch') && isNaNv(out[1])) out[2] = NaN;
  if (to === 'hsl' && isNaNv(out[1])) out[0] = NaN;
  return col(to, out, c.a);
}

/// The final sRGB [r, g, b, a] in [0, 1]: missing components read 0, the gamut is clipped.
function toRgba(c) {
  const v = c.c.map((x) => (isNaNv(x) ? 0 : x));
  const a = isNaNv(c.a) ? 0 : clamp01(c.a);
  let r;
  switch (c.s) {
    case 'srgb':
      r = v;
      break;
    case 'hsl':
      r = hslToRgb(v[0], v[1], v[2]);
      break;
    case 'hwb':
      r = hwbToRgb(v[0], v[1], v[2]);
      break;
    default: {
      const lin = toLinSrgb(c.s, v);
      r = [linToSrgb(lin[0]), linToSrgb(lin[1]), linToSrgb(lin[2])];
    }
  }
  return [clamp01(r[0]), clamp01(r[1]), clamp01(r[2]), a];
}

// ---- tokens and channels -----------------------------------------------------------------------------------------------------
const NUM_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/;
const PCT_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?%$/;
const ANGLE_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)$/;
const FN_RE = /^([a-z][a-z0-9-]*)\(/;

/// The top-level pieces of a function's argument text: whitespace separates, `,` and `/` stand alone, parentheses nest. null when
/// unbalanced.
function splitArgs(s) {
  const out = [];
  let depth = 0,
    start = -1;
  const flush = (end) => {
    if (start >= 0) {
      out.push(s.slice(start, end));
      start = -1;
    }
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (depth === 0 && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      flush(i);
      continue;
    }
    if (depth === 0 && (ch === ',' || ch === '/')) {
      flush(i);
      out.push(ch);
      continue;
    }
    if (start < 0) start = i;
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return null;
  }
  if (depth !== 0) return null;
  flush(s.length);
  return out;
}

/// One channel token → a value in the channel's internal unit, NaN for `none`, undefined when invalid.
/// spec: d = divisor of a plain number (255 for rgb, 100 for hsl s / l), p = the value of 100% (null: no percentage), h = a hue (an
/// angle is allowed, a percentage is not), none = `none` is allowed. `env` holds a relative color's channel keywords.
function channel(tok, spec, env) {
  if (tok === 'none') return spec.none ? NaN : undefined;
  if (NUM_RE.test(tok)) return spec.n === false ? undefined : parseFloat(tok) / spec.d;
  if (PCT_RE.test(tok)) return spec.p == null ? undefined : (parseFloat(tok) / 100) * spec.p;
  const ang = spec.h ? ANGLE_RE.exec(tok) : null;
  if (ang) return angleDeg(parseFloat(ang[1]), ang[2]);
  if (env && Object.prototype.hasOwnProperty.call(env, tok))
    return spec.n === false ? undefined : env[tok] / spec.d;
  const fn = FN_RE.exec(tok);
  if (fn && isMathFunction(fn[1])) {
    const r = evalColorMath(tok, env);
    if (!r) return undefined;
    if (r.k === 'n') return spec.n === false ? undefined : r.v / spec.d;
    if (r.k === 'p') return spec.p == null ? undefined : (r.v / 100) * spec.p;
    return spec.h ? r.v : undefined;
  }
  return undefined;
}
function angleDeg(v, unit) {
  // 'grad' before 'rad': 'grad'.endsWith('rad') is true.
  return unit === 'grad'
    ? (v * 360) / 400
    : unit === 'rad'
      ? (v * 180) / Math.PI
      : unit === 'turn'
        ? v * 360
        : v;
}

const S_RGB = { d: 255, p: 1, none: true },
  S_SL = { d: 100, p: 1, none: true },
  S_HUE = { d: 1, p: null, h: true, none: true };
const S_ALPHA = { d: 1, p: 1, none: true };
const S_ONE = { d: 1, p: 1, none: true };
const lab = (pa) => ({ d: 1, p: pa, none: true });
const noNone = (sp) => ({ ...sp, none: false });

// Per function: the space of the result, the three channel specs, how a channel is stored, and the scale of the relative-color keywords.
const FN = {
  rgb: {
    space: 'srgb',
    specs: [S_RGB, S_RGB, S_RGB],
    keys: ['r', 'g', 'b'],
    scale: [255, 255, 255],
  },
  hsl: { space: 'hsl', specs: [S_HUE, S_SL, S_SL], keys: ['h', 's', 'l'], scale: [1, 100, 100] },
  hwb: { space: 'hwb', specs: [S_HUE, S_SL, S_SL], keys: ['h', 'w', 'b'], scale: [1, 100, 100] },
  lab: {
    space: 'lab',
    specs: [lab(100), lab(125), lab(125)],
    keys: ['l', 'a', 'b'],
    scale: [1, 1, 1],
  },
  lch: {
    space: 'lch',
    specs: [lab(100), lab(150), S_HUE],
    keys: ['l', 'c', 'h'],
    scale: [1, 1, 1],
  },
  oklab: {
    space: 'oklab',
    specs: [lab(1), lab(0.4), lab(0.4)],
    keys: ['l', 'a', 'b'],
    scale: [1, 1, 1],
  },
  oklch: {
    space: 'oklch',
    specs: [lab(1), lab(0.4), S_HUE],
    keys: ['l', 'c', 'h'],
    scale: [1, 1, 1],
  },
};
FN.rgba = FN.rgb;
FN.hsla = FN.hsl;
const COLOR_FN_SPACES = new Set([
  'srgb',
  'srgb-linear',
  'display-p3',
  'a98-rgb',
  'prophoto-rgb',
  'rec2020',
  'xyz',
  'xyz-d50',
  'xyz-d65',
]);

/// Clamp what the grammar clamps at parse time (CSS Color 4): rgb to the sRGB cube; hsl / hwb saturation, lightness, whiteness and
/// blackness to [0, 1]; lightness of lab / lch / oklab / oklch; chroma to >= 0.
function limit(space, c) {
  const lo = (x, a, b) => (isNaNv(x) ? x : x < a ? a : x > b ? b : x);
  switch (space) {
    case 'srgb':
      return c.map((x) => lo(x, 0, 1));
    case 'hsl':
      return [c[0], lo(c[1], 0, Infinity), lo(c[2], 0, Infinity)]; // >= 0; a larger value overshoots and is clipped at the end
    case 'hwb':
      return [c[0], lo(c[1], 0, Infinity), lo(c[2], 0, Infinity)]; // w + b >= 1 is the achromatic gray w / (w + b)
    case 'lab':
      return [lo(c[0], 0, 100), c[1], c[2]];
    case 'lch':
      return [lo(c[0], 0, 100), lo(c[1], 0, Infinity), c[2]];
    case 'oklab':
      return [lo(c[0], 0, 1), c[1], c[2]];
    case 'oklch':
      return [lo(c[0], 0, 1), lo(c[1], 0, Infinity), c[2]];
    default:
      return c;
  }
}

// ---- the grammar -------------------------------------------------------------------------------------------------------------------
// st carries one flag out of the parse: `current` is set when a nested currentcolor was read as black.
function parseTree(s, st) {
  s = s.trim();
  if (s === '') return null;
  if (s === 'transparent') return col('srgb', [0, 0, 0], 0);
  if (s === 'currentcolor') {
    st.current = true;
    return col('srgb', [0, 0, 0], 1);
  }
  if (s[0] === '#') return parseHex(s);
  const sys = systemColorOf(s);
  if (sys) return col('srgb', [sys[0] / 255, sys[1] / 255, sys[2] / 255], sys[3]);
  if (s !== 'none' && Object.hasOwn(CSS_NAMED_COLORS, s)) return parseHex(CSS_NAMED_COLORS[s]);
  const fn = FN_RE.exec(s);
  if (!fn || s[s.length - 1] !== ')') return null;
  // The function must span the whole string: its first paren closes at the end.
  let depth = 0;
  for (let i = fn[0].length - 1; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0 && i !== s.length - 1) return null;
  }
  const inner = s.slice(fn[0].length, -1);
  switch (fn[1]) {
    case 'color-mix':
      return parseMix(inner, st);
    case 'light-dark':
      return parseLightDark(inner, st);
    case 'color':
      return parseColorFn(inner, st);
    default:
      return Object.hasOwn(FN, fn[1]) ? parseChannels(fn[1], inner, st) : null;
  }
}

function parseHex(s) {
  let hex = s.slice(1);
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  // Expand short forms: #rgb → #rrggbb, #rgba → #rrggbbaa.
  if (hex.length === 3 || hex.length === 4)
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  if (hex.length !== 6 && hex.length !== 8) return null;
  const r = parseInt(hex.substr(0, 2), 16) / 255;
  const g = parseInt(hex.substr(2, 2), 16) / 255;
  const b = parseInt(hex.substr(4, 2), 16) / 255;
  const a = hex.length === 8 ? parseInt(hex.substr(6, 2), 16) / 255 : 1;
  return col('srgb', [r, g, b], a);
}

/// The relative-color keyword table of `origin` seen through `space`: r g b (0..255 for rgb()), h s l, ..., plus alpha. A missing
/// component reads 0.
function relativeEnv(origin, space, keys, scale) {
  // A missing component of the origin is 0 in ITS space before the conversion: it is not carried into the target (Chrome, and
  // CSS Color 5's "missing components resolve to 0").
  const c = convert(
    col(
      origin.s,
      origin.c.map((x) => (isNaNv(x) ? 0 : x)),
      origin.a,
    ),
    space,
  ).c;
  const env = { alpha: isNaNv(origin.a) ? 0 : origin.a };
  for (let i = 0; i < 3; i++) env[keys[i]] = isNaNv(c[i]) ? 0 : c[i] * scale[i];
  return env;
}

/// rgb() / hsl() / hwb() / lab() / lch() / oklab() / oklch(), legacy or modern or relative. `T` is the split argument text.
function parseChannels(name, inner, st) {
  const f = FN[name];
  const T = splitArgs(inner);
  if (!T) return null;
  let i = 0,
    env = null,
    origin = null;
  if (T[0] === 'from') {
    origin = T.length > 1 ? parseTree(T[1], st) : null;
    if (!origin) return null;
    env = relativeEnv(origin, f.space, f.keys, f.scale);
    i = 2;
  }
  const R = T.slice(i);
  const legacy = R.includes(',');
  let tok,
    alphaTok = null;
  if (legacy) {
    if (env || (f.space !== 'srgb' && f.space !== 'hsl')) return null;
    if (
      (R.length !== 5 && R.length !== 7) ||
      R[1] !== ',' ||
      R[3] !== ',' ||
      (R.length === 7 && R[5] !== ',')
    )
      return null;
    tok = [R[0], R[2], R[4]];
    if (R.length === 7) alphaTok = R[6];
  } else {
    if (R.length !== 3 && !(R.length === 5 && R[3] === '/')) return null;
    tok = R.slice(0, 3);
    if (R.length === 5) alphaTok = R[4];
  }
  if (tok.includes('/') || alphaTok === '/') return null;
  let v;
  if (legacy && f.space === 'srgb') {
    // All three channels are numbers or all three are percentages.
    v = tok.map((t) => channel(t, { d: 255, p: null, none: false }, null));
    if (v.some((x) => x === undefined))
      v = tok.map((t) => channel(t, { d: 255, n: false, p: 1, none: false }, null));
  } else if (legacy) {
    v = [
      channel(tok[0], noNone(S_HUE), null),
      channel(tok[1], { d: 1, n: false, p: 1, none: false }, null),
      channel(tok[2], { d: 1, n: false, p: 1, none: false }, null),
    ];
  } else {
    v = tok.map((t, k) => channel(t, f.specs[k], env));
  }
  if (v.some((x) => x === undefined)) return null;
  let a = origin ? origin.a : 1; // a relative color keeps the origin's alpha unless it names one
  if (alphaTok != null) {
    a = channel(alphaTok, legacy ? noNone(S_ALPHA) : S_ALPHA, env);
    if (a === undefined) return null;
  }
  // A relative color's channels are not clamped (they are computed values); an authored one is, as the grammar says.
  // The legacy hsl() clamps saturation and lightness to 0..100%.
  let c = origin ? v : limit(f.space, v);
  if (f.space === 'hsl' && !legacy && !origin && PCT_RE.test(tok[1]))
    c = [c[0], Math.min(c[1], 1), c[2]]; // a percentage saturation stops at 100%, a number does not
  if (legacy && f.space === 'hsl') c = [c[0], clamp01(c[1]), clamp01(c[2])];
  return col(f.space, c, isNaNv(a) ? a : clamp01(a));
}

/// color(<space> c1 c2 c3 [/ a]) and color(from <color> <space> c1 c2 c3 [/ a]).
function parseColorFn(inner, st) {
  const T = splitArgs(inner);
  if (!T) return null;
  let i = 0,
    origin = null;
  if (T[0] === 'from') {
    origin = T.length > 1 ? parseTree(T[1], st) : null;
    if (!origin) return null;
    i = 2;
  }
  const space = T[i];
  if (!COLOR_FN_SPACES.has(space)) return null;
  const R = T.slice(i + 1);
  if (R.length !== 3 && !(R.length === 5 && R[3] === '/')) return null;
  const env = origin ? relativeEnv(origin, space, SPACES[space].keys, [1, 1, 1]) : null;
  const v = R.slice(0, 3).map((t) => channel(t, S_ONE, env));
  if (v.some((x) => x === undefined)) return null;
  let a = origin ? origin.a : 1;
  if (R.length === 5) {
    a = channel(R[4], S_ALPHA, env);
    if (a === undefined) return null;
  }
  return col(space, v, isNaNv(a) ? a : clamp01(a));
}

/// light-dark(<color>, <color>): the light color scheme's value, the first. Both must be valid colors.
function parseLightDark(inner, st) {
  const parts = splitCommas(inner);
  if (!parts || parts.length !== 2) return null;
  const light = parseTree(parts[0], st),
    dark = parseTree(parts[1], st);
  return light && dark ? light : null;
}

/// The comma-separated parts at the top level, or null when unbalanced.
function splitCommas(s) {
  const parts = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      if (--depth < 0) return null;
    } else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  parts.push(s.slice(start));
  return parts;
}

// ---- color-mix ---------------------------------------------------------------------------------------------------------------------
const HUE_METHODS = new Set(['shorter', 'longer', 'increasing', 'decreasing']);

/// Mix two colors in `space` (CSS Color 4 §12): premultiplied, with the hue method, missing components and the alpha multiplier.
/// w1 + w2 = 1.
function mixIn(space, method, c1, c2, w1, w2, alphaMul) {
  const A = convert(c1, space),
    B = convert(c2, space);
  let a1 = A.a,
    a2 = B.a;
  if (isNaNv(a1) && !isNaNv(a2)) a1 = a2;
  else if (isNaNv(a2) && !isNaNv(a1)) a2 = a1;
  const alpha = isNaNv(a1) ? NaN : a1 * w1 + a2 * w2;
  const p1 = isNaNv(a1) ? 1 : a1,
    p2 = isNaNv(a2) ? 1 : a2;
  const hue = SPACES[space].hue;
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let x1 = A.c[i],
      x2 = B.c[i];
    if (isNaNv(x1) && isNaNv(x2)) {
      out[i] = NaN;
      continue;
    }
    if (isNaNv(x1)) x1 = x2;
    else if (isNaNv(x2)) x2 = x1;
    if (i === hue) {
      x1 = ((x1 % 360) + 360) % 360;
      x2 = ((x2 % 360) + 360) % 360;
      const d = x2 - x1;
      if (method === 'longer') {
        if (d > 0 && d < 180) x1 += 360;
        else if (d > -180 && d <= 0) x2 += 360;
      } else if (method === 'increasing') {
        if (x2 < x1) x2 += 360;
      } else if (method === 'decreasing') {
        if (x1 < x2) x1 += 360;
      } else if (d > 180) x1 += 360;
      else if (d < -180) x2 += 360;
      out[i] = x1 * w1 + x2 * w2;
    } else {
      const m = x1 * p1 * w1 + x2 * p2 * w2;
      out[i] = isNaNv(alpha) || alpha === 0 ? m : m / alpha;
    }
  }
  return col(space, out, isNaNv(alpha) ? alpha : alpha * alphaMul);
}

/// One color-mix operand: `<color>`, `<color> <pct>` or `<pct> <color>`. { c, pct } with pct in [0, 1] or null; null when invalid.
function mixOperand(part, st) {
  const T = splitArgs(part);
  if (!T || T.length < 1 || T.length > 2 || T.includes(',') || T.includes('/')) return null;
  let pct = null,
    colorTok = T[0];
  if (T.length === 2) {
    const isPct = (t) =>
      PCT_RE.test(t) ||
      (FN_RE.test(t) && isMathFunction(FN_RE.exec(t)[1]) && evalColorMath(t, null)?.k === 'p');
    let pTok;
    if (isPct(T[1])) {
      pTok = T[1];
      colorTok = T[0];
    } else if (isPct(T[0])) {
      pTok = T[0];
      colorTok = T[1];
    } else return null;
    pct = PCT_RE.test(pTok) ? parseFloat(pTok) : evalColorMath(pTok, null).v;
    if (!(pct >= 0 && pct <= 100)) return null;
    pct /= 100;
  }
  const c = parseTree(colorTok, st);
  return c ? { c, pct } : null;
}

function parseMix(inner, st) {
  let parts = splitCommas(inner);
  if (!parts) return null;
  // The interpolation method is optional (CSS Color 5, 2024): without `in <space>` the mix is in oklab.
  if (parts.length === 2) parts = ['in oklab', parts[0], parts[1]];
  if (parts.length !== 3) return null;
  const head = parts[0].trim().split(/\s+/);
  if (head[0] !== 'in' || !SPACES[head[1]] || head.length === 3 || head.length > 4) return null;
  const space = head[1];
  let method = 'shorter';
  if (head.length === 4) {
    if (!HUE_METHODS.has(head[2]) || head[3] !== 'hue' || SPACES[space].hue < 0) return null;
    method = head[2];
  }
  const a = mixOperand(parts[1], st),
    b = mixOperand(parts[2], st);
  if (!a || !b) return null;
  let p1 = a.pct,
    p2 = b.pct;
  if (p1 == null && p2 == null) {
    p1 = 0.5;
    p2 = 0.5;
  } else if (p1 == null) p1 = 1 - p2;
  else if (p2 == null) p2 = 1 - p1;
  const sum = p1 + p2;
  if (!(sum > 0)) return null;
  return mixIn(space, method, a.c, b.c, p1 / sum, p2 / sum, sum < 1 ? sum : 1);
}

// ---- entry points ------------------------------------------------------------------------------------------------------------------
const COLOR_TRANSPARENT = [0, 0, 0, 0];
const COLOR_OPAQUE_BLACK = [0, 0, 0, 1];
const COLOR_CACHE_SPEC = new Map(); // raw string → { rgba | null, current }, one per compat mode
const COLOR_CACHE_CHROME = new Map();
let COLOR_CACHE = COLOR_CACHE_SPEC;
const COLOR_CACHE_MAX = 256;
const warned = new Set();

/// CSS Syntax 3 §5: a function still open at the end of the input is closed by it, so `rgb(255,0,0` is the color `rgb(255,0,0)`.
function autoClose(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
  }
  return depth > 0 ? s + ')'.repeat(depth) : s;
}

function lookup(s) {
  let e = COLOR_CACHE.get(s);
  if (e !== undefined) return e;
  const st = { current: false };
  const tree = parseTree(autoClose(s.toLowerCase()), st);
  e = { rgba: tree ? toRgba(tree) : null, current: st.current };
  if (COLOR_CACHE.size >= COLOR_CACHE_MAX) COLOR_CACHE.delete(COLOR_CACHE.keys().next().value);
  COLOR_CACHE.set(s, e);
  return e;
}

/// Whether `s` is a valid CSS <color> (the grammar above), and its [r, g, b, a] in [0, 1] (un-premultiplied sRGB) or null. A nested
/// `currentcolor` reads as black here (see the file header). The result is shared: callers that mutate it MUST `.slice()` first.
export function parseColorStrict(s) {
  return s ? lookup(s).rgba : null;
}

/// Parse a CSS color string. Returns [r, g, b, a] in [0, 1] (un-premultiplied); the result is cached by raw input string, so callers
/// that mutate it MUST `.slice()` first (style.js does; gradient.js reads fields then constructs a new array).
/// `none` / `transparent` → [0, 0, 0, 0]. Inheritance sentinels (`currentColor` / `inherit` / `unset` / `initial`) → opaque
/// black — callers needing real inheritance use resolveCurrentColor (style.js) upstream. A string that is not a valid color
/// is opaque black too (callers hand this paint text such as `url(#g)`, which is opaque by design), with a one-time warning when it
/// is a color function that did not parse: a requested color must work or fail loudly.
export function parseColor(s) {
  if (!s) return COLOR_TRANSPARENT;
  const e = lookup(s);
  if (e.rgba) {
    if (e.current && !warned.has(s))
      warnOnce(
        s,
        `color '${s}': currentcolor inside a color function was not substituted (the caller did not resolve it); using black`,
      );
    return e.rgba;
  }
  const t = s.trim().toLowerCase();
  if (t === 'none') return COLOR_TRANSPARENT;
  if (t === 'inherit' || t === 'unset' || t === 'initial') return COLOR_OPAQUE_BLACK;
  const fn = FN_RE.exec(t);
  if (fn && (FN[fn[1]] || fn[1] === 'color' || fn[1] === 'color-mix' || fn[1] === 'light-dark')) {
    warnOnce(s, `color '${s}' is not a valid CSS color; painting black`);
  }
  return COLOR_OPAQUE_BLACK;
}

function warnOnce(key, message) {
  if (warned.size > 64 || warned.has(key)) return;
  warned.add(key);
  mantleWarn(message);
}

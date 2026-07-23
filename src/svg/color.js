// svg/color.js — CSS color parsing for SVG.
//
// Pure-function leaf module. parseColor accepts:
//   - CSS3: named, #hex {3,4,6,8}, rgb(), rgba(), hsl(), hsla()
//   - CSS Color 4: hwb(), lab(), lch(), oklab(), oklch()
//   - CSS Color 4: color(<space> c1 c2 c3 / a) for srgb, srgb-linear,
//                  display-p3, a98-rgb, prophoto-rgb, rec2020, xyz,
//                  xyz-d50, xyz-d65
//   - CSS Color 5: color-mix(in <space>, c1 [pct], c2 [pct])
//   - Modern slash-alpha syntax across all of the above.
//
// All outputs are sRGB in [0,1] (un-premultiplied). Wide-gamut inputs
// (display-p3, rec2020, etc.) are gamut-clipped to sRGB at the boundary
// — the renderer's output is sRGB throughout. Out-of-gamut components
// are clamped to [0,1]; no fancy gamut-map.
//
// `resolveCurrentColor` (which walks the element tree for inherited
// `color:`) lives in svg/style.js — it depends on the style stack.

export const CSS_NAMED_COLORS = {
  aliceblue:'#f0f8ff', antiquewhite:'#faebd7', aqua:'#00ffff', aquamarine:'#7fffd4',
  azure:'#f0ffff', beige:'#f5f5dc', bisque:'#ffe4c4', black:'#000000',
  blanchedalmond:'#ffebcd', blue:'#0000ff', blueviolet:'#8a2be2', brown:'#a52a2a',
  burlywood:'#deb887', cadetblue:'#5f9ea0', chartreuse:'#7fff00', chocolate:'#d2691e',
  coral:'#ff7f50', cornflowerblue:'#6495ed', cornsilk:'#fff8dc', crimson:'#dc143c',
  cyan:'#00ffff', darkblue:'#00008b', darkcyan:'#008b8b', darkgoldenrod:'#b8860b',
  darkgray:'#a9a9a9', darkgrey:'#a9a9a9', darkgreen:'#006400', darkkhaki:'#bdb76b',
  darkmagenta:'#8b008b', darkolivegreen:'#556b2f', darkorange:'#ff8c00', darkorchid:'#9932cc',
  darkred:'#8b0000', darksalmon:'#e9967a', darkseagreen:'#8fbc8f', darkslateblue:'#483d8b',
  darkslategray:'#2f4f4f', darkslategrey:'#2f4f4f', darkturquoise:'#00ced1', darkviolet:'#9400d3',
  deeppink:'#ff1493', deepskyblue:'#00bfff', dimgray:'#696969', dimgrey:'#696969',
  dodgerblue:'#1e90ff', firebrick:'#b22222', floralwhite:'#fffaf0', forestgreen:'#228b22',
  fuchsia:'#ff00ff', gainsboro:'#dcdcdc', ghostwhite:'#f8f8ff', gold:'#ffd700',
  goldenrod:'#daa520', gray:'#808080', grey:'#808080', green:'#008000',
  greenyellow:'#adff2f', honeydew:'#f0fff0', hotpink:'#ff69b4', indianred:'#cd5c5c',
  indigo:'#4b0082', ivory:'#fffff0', khaki:'#f0e68c', lavender:'#e6e6fa',
  lavenderblush:'#fff0f5', lawngreen:'#7cfc00', lemonchiffon:'#fffacd', lightblue:'#add8e6',
  lightcoral:'#f08080', lightcyan:'#e0ffff', lightgoldenrodyellow:'#fafad2', lightgray:'#d3d3d3',
  lightgrey:'#d3d3d3', lightgreen:'#90ee90', lightpink:'#ffb6c1', lightsalmon:'#ffa07a',
  lightseagreen:'#20b2aa', lightskyblue:'#87cefa', lightslategray:'#778899', lightslategrey:'#778899',
  lightsteelblue:'#b0c4de', lightyellow:'#ffffe0', lime:'#00ff00', limegreen:'#32cd32',
  linen:'#faf0e6', magenta:'#ff00ff', maroon:'#800000', mediumaquamarine:'#66cdaa',
  mediumblue:'#0000cd', mediumorchid:'#ba55d3', mediumpurple:'#9370db', mediumseagreen:'#3cb371',
  mediumslateblue:'#7b68ee', mediumspringgreen:'#00fa9a', mediumturquoise:'#48d1cc',
  mediumvioletred:'#c71585', midnightblue:'#191970', mintcream:'#f5fffa', mistyrose:'#ffe4e1',
  moccasin:'#ffe4b5', navajowhite:'#ffdead', navy:'#000080', oldlace:'#fdf5e6',
  olive:'#808000', olivedrab:'#6b8e23', orange:'#ffa500', orangered:'#ff4500',
  orchid:'#da70d6', palegoldenrod:'#eee8aa', palegreen:'#98fb98', paleturquoise:'#afeeee',
  palevioletred:'#db7093', papayawhip:'#ffefd5', peachpuff:'#ffdab9', peru:'#cd853f',
  pink:'#ffc0cb', plum:'#dda0dd', powderblue:'#b0e0e6', purple:'#800080',
  rebeccapurple:'#663399', red:'#ff0000', rosybrown:'#bc8f8f', royalblue:'#4169e1',
  saddlebrown:'#8b4513', salmon:'#fa8072', sandybrown:'#f4a460', seagreen:'#2e8b57',
  seashell:'#fff5ee', sienna:'#a0522d', silver:'#c0c0c0', skyblue:'#87ceeb',
  slateblue:'#6a5acd', slategray:'#708090', slategrey:'#708090', snow:'#fffafa',
  springgreen:'#00ff7f', steelblue:'#4682b4', tan:'#d2b48c', teal:'#008080',
  thistle:'#d8bfd8', tomato:'#ff6347', turquoise:'#40e0d0', violet:'#ee82ee',
  wheat:'#f5deb3', white:'#ffffff', whitesmoke:'#f5f5f5', yellow:'#ffff00',
  yellowgreen:'#9acd32',
  none:'transparent', transparent:'transparent',
};

/// Convert hsl(h, s%, l%) or hsla(...) → rgb [0..1] floats.
/// h in degrees, s/l in [0,1].
export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if      (h <  60) { r1 = c; g1 = x; }
  else if (h < 120) { r1 = x; g1 = c; }
  else if (h < 180) { g1 = c; b1 = x; }
  else if (h < 240) { g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; b1 = c; }
  else              { r1 = c; b1 = x; }
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

// Linearize an sRGB channel (gamma → linear).
function srgbToLin(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/// Linear-light sRGB (D65) → CIE XYZ (D65). Per IEC 61966-2-1.
function linSrgbToXyzD65(r, g, b) {
  return [
    0.4123907992659593  * r + 0.3575843393838779 * g + 0.1804807884018343 * b,
    0.2126390058715102  * r + 0.7151686787677559 * g + 0.0721923153607338 * b,
    0.0193308187155918  * r + 0.1191947797946259 * g + 0.9505321522496608 * b,
  ];
}
function xyzD65ToLinSrgb(x, y, z) {
  return [
     3.2409699419045226  * x - 1.5373831775700935  * y - 0.4986107602930033  * z,
    -0.9692436362808796  * x + 1.8759675015077202  * y + 0.04155505740717561 * z,
     0.05563007969699366 * x - 0.20397695888897652 * y + 1.0569715142428786  * z,
  ];
}

// Bradford-adapted D50↔D65 conversion matrices (CSS Color 4 reference).
function xyzD50ToD65(x, y, z) {
  return [
     0.9554734527042182  * x - 0.0230985368742614 * y + 0.0632593086610217 * z,
    -0.0283697069452221  * x + 1.0099954580058226 * y + 0.0210413976932351 * z,
     0.0123140016883199  * x - 0.0205076964334786 * y + 1.3303659730912839 * z,
  ];
}
function xyzD65ToD50(x, y, z) {
  return [
     1.0479298208405488  * x + 0.0229467933410191 * y - 0.0501922295005383 * z,
     0.0296278156881013  * x + 0.9904344075599996 * y - 0.0170491933179229 * z,
    -0.0092430581525912  * x + 0.0150569503031266 * y + 0.7518742899580008 * z,
  ];
}

// CIELab (D50) ↔ XYZ (D50). Per CSS Color 4 §8.
const LAB_EPS = 216 / 24389, LAB_KAPPA = 24389 / 27;
const D50_WHITE = [0.96422, 1.0, 0.82521];
function labToXyzD50(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const f3x = fx * fx * fx, f3z = fz * fz * fz;
  const xr = f3x > LAB_EPS ? f3x : (116 * fx - 16) / LAB_KAPPA;
  const yr = L > LAB_KAPPA * LAB_EPS ? Math.pow(fy, 3) : L / LAB_KAPPA;
  const zr = f3z > LAB_EPS ? f3z : (116 * fz - 16) / LAB_KAPPA;
  return [xr * D50_WHITE[0], yr * D50_WHITE[1], zr * D50_WHITE[2]];
}
function lchToLab(L, C, h) {
  const rad = h * Math.PI / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}

// OKLab ↔ linear sRGB. Per Björn Ottosson "A perceptual color space for
// image processing" (CSS Color 4 §9). Skips XYZ entirely — the matrices
// go straight from linear sRGB.
function oklabToLinSrgb(L, a, b) {
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.2914855480 * b;
  const l3 = l*l*l, m3 = m*m*m, s3 = s*s*s;
  return [
    +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
  ];
}
function linSrgbToOklab(r, g, b) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

// Generic <space> linear ↔ linear sRGB. Source matrices from CSS
// Color 4. All three channels in [0,1] (or wider for HDR).
function displayP3ToLinSrgb(r, g, b) {
  // Both spaces use sRGB transfer function, so caller must pass *linear*
  // P3 (already-decoded). XYZ D65 round-trip via P3's primaries.
  const [x, y, z] = [
    0.4865709486482162 * r + 0.26566769316909306 * g + 0.1982172852343625  * b,
    0.2289745640697488 * r + 0.6917385218365064  * g + 0.079286914093745   * b,
    0.0000000000000000 * r + 0.04511338185890264 * g + 1.043944368900976   * b,
  ];
  return xyzD65ToLinSrgb(x, y, z);
}
function a98RgbToLinSrgb(r, g, b) {
  // A98 RGB uses gamma 2.19921875; caller passes linear.
  const [x, y, z] = [
    0.5766690429101305  * r + 0.1855582379065463 * g + 0.1882286462349947  * b,
    0.29734497525053605 * r + 0.6273635662554661 * g + 0.07529145849399788 * b,
    0.02703136138004471 * r + 0.07068885253582722* g + 0.9913375368376388  * b,
  ];
  return xyzD65ToLinSrgb(x, y, z);
}
function prophotoToLinSrgb(r, g, b) {
  // ProPhoto is D50 referenced; need a D50→D65 swing.
  const [x, y, z] = [
    0.7977604896723027  * r + 0.13518583717574031 * g + 0.0313493495815248  * b,
    0.2880711282292934  * r + 0.7118432178101014  * g + 0.00008565396060525902 * b,
    0.0                 * r + 0.0                 * g + 0.8251046025104601 * b,
  ];
  const [x65, y65, z65] = xyzD50ToD65(x, y, z);
  return xyzD65ToLinSrgb(x65, y65, z65);
}
function rec2020ToLinSrgb(r, g, b) {
  const [x, y, z] = [
    0.6369580483012914 * r + 0.14461690358620832 * g + 0.1688809751641721  * b,
    0.2627002120112671 * r + 0.6779980715188708  * g + 0.05930171646986196 * b,
    0.0                * r + 0.028072693049087428 * g + 1.060985057710791   * b,
  ];
  return xyzD65ToLinSrgb(x, y, z);
}

// Decode the gamma transfer function for spaces that use one.
function rec709Inverse(c) { return srgbToLin(c); }                   // sRGB shares
function prophotoInverse(c) {
  // ProPhoto uses gamma 1.8 with a 16-segment linear toe.
  return Math.abs(c) < 16 / 512 ? c / 16 : Math.sign(c) * Math.pow(Math.abs(c), 1.8);
}
function a98Inverse(c)     { return Math.sign(c) * Math.pow(Math.abs(c), 563 / 256); }
function rec2020Inverse(c) {
  const a = 1.09929682680944, b = 0.018053968510807;
  return Math.abs(c) < b * 4.5
    ? c / 4.5
    : Math.sign(c) * Math.pow((Math.abs(c) + a - 1) / a, 1 / 0.45);
}

/// Convert a `color(<space> c1 c2 c3)` triplet (gamma-encoded for RGB
/// spaces, scaled 0..1 for XYZ) into sRGB in [0,1]. Returns null if the
/// color space is not recognized.
function colorSpaceToSrgb(space, c1, c2, c3) {
  let lin;
  switch (space) {
    case 'srgb':
      return [c1, c2, c3];
    case 'srgb-linear':
      lin = [c1, c2, c3]; break;
    case 'display-p3':
      lin = displayP3ToLinSrgb(rec709Inverse(c1), rec709Inverse(c2), rec709Inverse(c3));
      break;
    case 'a98-rgb':
      lin = a98RgbToLinSrgb(a98Inverse(c1), a98Inverse(c2), a98Inverse(c3));
      break;
    case 'prophoto-rgb':
      lin = prophotoToLinSrgb(prophotoInverse(c1), prophotoInverse(c2), prophotoInverse(c3));
      break;
    case 'rec2020':
      lin = rec2020ToLinSrgb(rec2020Inverse(c1), rec2020Inverse(c2), rec2020Inverse(c3));
      break;
    case 'xyz':
    case 'xyz-d65':
      lin = xyzD65ToLinSrgb(c1, c2, c3); break;
    case 'xyz-d50': {
      const [x65, y65, z65] = xyzD50ToD65(c1, c2, c3);
      lin = xyzD65ToLinSrgb(x65, y65, z65); break;
    }
    default:
      return null;
  }
  return [linToSrgb(lin[0]), linToSrgb(lin[1]), linToSrgb(lin[2])];
}

// Linearly interpolate two colors in a chosen mixing space. `t` is the
// fraction toward c2 (c1 at t=0, c2 at t=1). Inputs are sRGB [r,g,b,a]
// from parseColor; output is the same. Honors `in <space>` from
// color-mix() — implemented: srgb, srgb-linear, oklab, oklch, hsl,
// hwb. Any other space (lab, lch, xyz, …) falls back to srgb mixing.
function mixIn(space, c1, c2, t) {
  const a = c1[3] * (1 - t) + c2[3] * t;
  const lerp3 = (x, y) => [x[0] * (1 - t) + y[0] * t,
                           x[1] * (1 - t) + y[1] * t,
                           x[2] * (1 - t) + y[2] * t];
  const wrapHueLerp = (h1, h2) => {
    let d = h2 - h1;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    return ((h1 + d * t) % 360 + 360) % 360;
  };
  if (space === 'srgb' || !space) {
    return [...lerp3(c1, c2), a];
  }
  if (space === 'srgb-linear') {
    const l1 = [srgbToLin(c1[0]), srgbToLin(c1[1]), srgbToLin(c1[2])];
    const l2 = [srgbToLin(c2[0]), srgbToLin(c2[1]), srgbToLin(c2[2])];
    const m  = lerp3(l1, l2);
    return [linToSrgb(m[0]), linToSrgb(m[1]), linToSrgb(m[2]), a];
  }
  if (space === 'oklab' || space === 'oklch') {
    const o1 = linSrgbToOklab(srgbToLin(c1[0]), srgbToLin(c1[1]), srgbToLin(c1[2]));
    const o2 = linSrgbToOklab(srgbToLin(c2[0]), srgbToLin(c2[1]), srgbToLin(c2[2]));
    let m;
    if (space === 'oklch') {
      // Convert to LCh, interpolate hue with wrap, then back.
      const C1 = Math.hypot(o1[1], o1[2]), h1 = (Math.atan2(o1[2], o1[1]) * 180 / Math.PI + 360) % 360;
      const C2 = Math.hypot(o2[1], o2[2]), h2 = (Math.atan2(o2[2], o2[1]) * 180 / Math.PI + 360) % 360;
      const L  = o1[0] * (1 - t) + o2[0] * t;
      const C  = C1 * (1 - t) + C2 * t;
      const H  = wrapHueLerp(h1, h2);
      const rad = H * Math.PI / 180;
      m = [L, C * Math.cos(rad), C * Math.sin(rad)];
    } else {
      m = lerp3(o1, o2);
    }
    const lin = oklabToLinSrgb(m[0], m[1], m[2]);
    return [linToSrgb(lin[0]), linToSrgb(lin[1]), linToSrgb(lin[2]), a];
  }
  if (space === 'hsl' || space === 'hwb') {
    // Convert through HSL. HSL ↔ RGB is invertible enough for hue mixing.
    const rgbToHsl = (r, g, b) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      const l = (mx + mn) / 2;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      let h = 0;
      if (d !== 0) {
        if (mx === r) h = ((g - b) / d) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60; if (h < 0) h += 360;
      }
      return [h, s, l];
    };
    const [h1, s1, l1] = rgbToHsl(c1[0], c1[1], c1[2]);
    const [h2, s2, l2] = rgbToHsl(c2[0], c2[1], c2[2]);
    const h = wrapHueLerp(h1, h2);
    const s = s1 * (1 - t) + s2 * t;
    const l = l1 * (1 - t) + l2 * t;
    const [r, g, b] = hslToRgb(h, s, l);
    return [r, g, b, a];
  }
  // Fallback to sRGB.
  return [...lerp3(c1, c2), a];
}

/// Parse a CSS color string. Returns [r, g, b, a] in [0, 1] (un-premultiplied).
/// `none` / `transparent` → [0, 0, 0, 0]. Inheritance sentinels
/// (`currentColor` / `inherit` / `unset` / `initial`) → opaque black —
/// callers needing real inheritance use resolveCurrentColor (style.js)
/// upstream.
///
/// Result is cached by raw input string. Callers that mutate the
/// returned array MUST `.slice()` first (style.js does; gradient.js
/// reads fields then constructs a new array). Cache is bounded to
/// 256 entries (LRU-ish via Map insertion order — typical SVG asset
/// has < 50 distinct colors).
const COLOR_TRANSPARENT = [0, 0, 0, 0];
const COLOR_OPAQUE_BLACK = [0, 0, 0, 1];
const COLOR_CACHE = new Map();
const COLOR_CACHE_MAX = 256;
export function parseColor(s) {
  if (!s) return COLOR_TRANSPARENT;
  const cached = COLOR_CACHE.get(s);
  if (cached !== undefined) return cached;
  const out = _parseColorUncached(s);
  if (COLOR_CACHE.size >= COLOR_CACHE_MAX) {
    const k = COLOR_CACHE.keys().next().value;
    COLOR_CACHE.delete(k);
  }
  COLOR_CACHE.set(s, out);
  return out;
}

function _parseColorUncached(s) {
  s = s.trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return COLOR_TRANSPARENT;
  if (s === 'currentcolor' || s === 'inherit' || s === 'unset' || s === 'initial') {
    return COLOR_OPAQUE_BLACK;
  }
  if (CSS_NAMED_COLORS[s]) s = CSS_NAMED_COLORS[s];
  if (s === 'transparent') return COLOR_TRANSPARENT;
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    // Expand short forms: #rgb → #rrggbb, #rgba → #rrggbbaa.
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.split('').map(c => c + c).join('');
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.substr(0, 2), 16) / 255;
      const g = parseInt(hex.substr(2, 2), 16) / 255;
      const b = parseInt(hex.substr(4, 2), 16) / 255;
      const a = hex.length === 8 ? parseInt(hex.substr(6, 2), 16) / 255 : 1;
      return [r, g, b, a];
    }
    return [0, 0, 0, 1];
  }
  // rgb(r, g, b) / rgba(r, g, b, a). r/g/b can be 0..255 ints or N% percentages.
  const rgb = s.match(/^rgba?\s*\(([^)]+)\)$/);
  if (rgb) {
    const p = rgb[1].split(/[,\s/]+/).map(t => t.trim()).filter(t => t);
    if (p.length < 3) return [0, 0, 0, 1];
    const parseChan = (t) => {
      const isPct = t.endsWith('%');
      const v = parseFloat(t);
      return isPct ? v / 100 : v / 255;
    };
    const parseAlpha = (t) => {
      const isPct = t.endsWith('%');
      const v = parseFloat(t);
      return isPct ? v / 100 : v;
    };
    return [parseChan(p[0]), parseChan(p[1]), parseChan(p[2]),
            p.length > 3 ? parseAlpha(p[3]) : 1];
  }
  // hsl(h, s%, l%) / hsla(h, s%, l%, a). Also accepts hsl(h s% l% / a).
  const hsl = s.match(/^hsla?\s*\(([^)]+)\)$/);
  if (hsl) {
    const p = hsl[1].split(/[,\s/]+/).map(t => t.trim()).filter(t => t);
    if (p.length < 3) return [0, 0, 0, 1];
    let h = parseFloat(p[0]);
    // 'grad' before 'rad': 'grad'.endsWith('rad') is true.
    if (p[0].endsWith('grad')) h = h * 360 / 400;
    else if (p[0].endsWith('rad')) h = h * 180 / Math.PI;
    else if (p[0].endsWith('turn')) h = h * 360;
    const sat = (parseFloat(p[1]) || 0) / 100;
    const lit = (parseFloat(p[2]) || 0) / 100;
    const [r, g, b] = hslToRgb(h, sat, lit);
    let a = 1;
    if (p.length > 3) {
      a = p[3].endsWith('%') ? (parseFloat(p[3]) / 100) : parseFloat(p[3]);
    }
    return [r, g, b, a];
  }
  // hwb(H W% B% [/ A])
  const hwb = s.match(/^hwb\s*\(([^)]+)\)$/);
  if (hwb) {
    const p = hwb[1].split(/[,\s/]+/).map(t => t.trim()).filter(t => t);
    if (p.length < 3) return [0, 0, 0, 1];
    const h = parseHue(p[0]);
    const w = (parseFloat(p[1]) || 0) / 100;
    const bw = (parseFloat(p[2]) || 0) / 100;
    const [r, g, b] = hwbToRgb(h, w, bw);
    let a = 1;
    if (p.length > 3) a = parseAlphaTok(p[3]);
    return [clamp01(r), clamp01(g), clamp01(b), a];
  }
  // lab(L a b [/ A]) — D50; L 0..100 (or 0..100%); a/b ±125 (or ±100%).
  const lab = s.match(/^lab\s*\(([^)]+)\)$/);
  if (lab) {
    const p = lab[1].split(/[,\s/]+/).map(t => t.trim()).filter(t => t);
    if (p.length < 3) return [0, 0, 0, 1];
    const L  = parseLightness(p[0], 100);
    const aa = parsePctOrNum(p[1], 125);
    const bb = parsePctOrNum(p[2], 125);
    const [x50, y50, z50] = labToXyzD50(L, aa, bb);
    const [x65, y65, z65] = xyzD50ToD65(x50, y50, z50);
    const [r, g, b] = xyzD65ToLinSrgb(x65, y65, z65);
    const al = p.length > 3 ? parseAlphaTok(p[3]) : 1;
    return [clamp01(linToSrgb(r)), clamp01(linToSrgb(g)), clamp01(linToSrgb(b)), al];
  }
  // lch(L C H [/ A])
  const lch = s.match(/^lch\s*\(([^)]+)\)$/);
  if (lch) {
    const p = lch[1].split(/[,\s/]+/).map(t => t.trim()).filter(t => t);
    if (p.length < 3) return [0, 0, 0, 1];
    const L = parseLightness(p[0], 100);
    const C = parsePctOrNum(p[1], 150);
    const H = parseHue(p[2]);
    const [Ll, aa, bb] = lchToLab(L, C, H);
    const [x50, y50, z50] = labToXyzD50(Ll, aa, bb);
    const [x65, y65, z65] = xyzD50ToD65(x50, y50, z50);
    const [r, g, b] = xyzD65ToLinSrgb(x65, y65, z65);
    const al = p.length > 3 ? parseAlphaTok(p[3]) : 1;
    return [clamp01(linToSrgb(r)), clamp01(linToSrgb(g)), clamp01(linToSrgb(b)), al];
  }
  // oklab(L a b [/ A]) — L 0..1 (or 0..100%); a/b ±0.4 (or ±100%).
  const oklab = s.match(/^oklab\s*\(([^)]+)\)$/);
  if (oklab) {
    const p = oklab[1].split(/[,\s/]+/).map(t => t.trim()).filter(t => t);
    if (p.length < 3) return [0, 0, 0, 1];
    const L  = parseLightness(p[0], 1);
    const aa = parsePctOrNum(p[1], 0.4);
    const bb = parsePctOrNum(p[2], 0.4);
    const [r, g, b] = oklabToLinSrgb(L, aa, bb);
    const al = p.length > 3 ? parseAlphaTok(p[3]) : 1;
    return [clamp01(linToSrgb(r)), clamp01(linToSrgb(g)), clamp01(linToSrgb(b)), al];
  }
  // oklch(L C H [/ A])
  const oklch = s.match(/^oklch\s*\(([^)]+)\)$/);
  if (oklch) {
    const p = oklch[1].split(/[,\s/]+/).map(t => t.trim()).filter(t => t);
    if (p.length < 3) return [0, 0, 0, 1];
    const L = parseLightness(p[0], 1);
    const C = parsePctOrNum(p[1], 0.4);
    const H = parseHue(p[2]);
    const [Ll, aa, bb] = lchToLab(L, C, H);
    const [r, g, b] = oklabToLinSrgb(Ll, aa, bb);
    const al = p.length > 3 ? parseAlphaTok(p[3]) : 1;
    return [clamp01(linToSrgb(r)), clamp01(linToSrgb(g)), clamp01(linToSrgb(b)), al];
  }
  // color(<space> c1 c2 c3 [/ A])
  const colorFn = s.match(/^color\s*\(([^)]+)\)$/);
  if (colorFn) {
    const p = colorFn[1].split(/[,\s/]+/).map(t => t.trim()).filter(t => t);
    if (p.length < 4) return [0, 0, 0, 1];
    const space = p[0];
    const c1 = parsePctOrNum(p[1], 1);
    const c2 = parsePctOrNum(p[2], 1);
    const c3 = parsePctOrNum(p[3], 1);
    const rgb = colorSpaceToSrgb(space, c1, c2, c3);
    if (!rgb) return [0, 0, 0, 1];
    const al = p.length > 4 ? parseAlphaTok(p[4]) : 1;
    return [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2]), al];
  }
  // color-mix(in <space>[ <hue-mode>], c1[ pct], c2[ pct])
  // We don't honor hue-interpolation-mode beyond "shorter" (the default).
  if (s.startsWith('color-mix(')) return parseColorMix(s);
  return [0, 0, 0, 1];
}

// ---- small helpers used by the new parsers --------------------------
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function parseHue(t) {
  let h = parseFloat(t);
  // 'grad' before 'rad': 'grad'.endsWith('rad') is true.
  if (t.endsWith('grad')) h = h * 360 / 400;
  else if (t.endsWith('rad')) h = h * 180 / Math.PI;
  else if (t.endsWith('turn')) h = h * 360;
  return h;
}
function parseAlphaTok(t) {
  return t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t);
}
function parsePctOrNum(t, pct100) {
  return t.endsWith('%') ? (parseFloat(t) / 100) * pct100 : parseFloat(t);
}
// Lightness scaling: lab/lch is L 0..100 (pct100=100), oklab/oklch is
// L 0..1 (pct100=1). Percentages always scale to the full range.
function parseLightness(t, pct100) {
  return t.endsWith('%') ? (parseFloat(t) / 100) * pct100 : parseFloat(t);
}

// Tokenizer for color-mix. Format:
//   color-mix(in <space>, c1 [pct%], c2 [pct%])
// The two colors can themselves be any CSS color (nested parens). The
// top-level commas separate `in <space>` from c1 from c2. Use a
// depth-aware tokenizer instead of String.split because nested
// `rgb(1, 2, 3)` would otherwise tear apart.
function parseColorMix(s) {
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < open) return [0, 0, 0, 1];
  const inner = s.slice(open + 1, close);
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(inner.slice(start).trim());
  if (parts.length !== 3) return [0, 0, 0, 1];
  const inToks = parts[0].split(/\s+/).filter(t => t);
  if (inToks[0] !== 'in') return [0, 0, 0, 1];
  const space = inToks[1] || 'srgb';

  // Each color part is "<color>[ <pct>]". Strip the trailing pct if any.
  function splitColorAndPct(seg) {
    // Match the trailing percentage (or none).
    const m = seg.match(/^(.*?)(\s+(\d+(?:\.\d+)?)\s*%)?$/);
    if (!m) return { c: seg, pct: null };
    const c = (m[1] || seg).trim();
    const pct = m[2] ? parseFloat(m[3]) / 100 : null;
    return { c, pct };
  }
  const sa = splitColorAndPct(parts[1]);
  const sb = splitColorAndPct(parts[2]);
  // Normalize percentages: if neither given, 50/50; if one given, the
  // other is its complement; if both given, normalize to sum=1 (per CSS
  // Color 5).
  let pa = sa.pct, pb = sb.pct;
  if (pa == null && pb == null) { pa = 0.5; pb = 0.5; }
  else if (pa == null) pa = 1 - pb;
  else if (pb == null) pb = 1 - pa;
  const sum = pa + pb;
  if (sum > 1e-9) { pa /= sum; pb /= sum; }
  const c1 = parseColor(sa.c);
  const c2 = parseColor(sb.c);
  return mixIn(space, c1, c2, pb);
}

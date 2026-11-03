// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/filter.js — <filter> defs parser.
//
// Produces a per-id record:
//   { kind, matrix?, sigmaX?, sigmaY?, ... }
// for the single-kind heuristic (color matrix / blur — what the
// renderer's filter-region dispatch can handle directly), OR a
// `graph: { nodes, rootOut }` DAG for chains too rich to collapse to a
// single kind. Graph nodes match the filterGraph schema; the renderer's
// COLR + SVG dispatch tables both consume the same shape.
//
// Supported single-kind chains (the kind heuristic):
//   - feColorMatrix (type=matrix|saturate|hueRotate|luminanceToAlpha)
//   - feGaussianBlur
//   - feFlood + feComposite operator="in" → tint matrix
// feDropShadow and any richer chain expand to a filter graph instead.
//
// Anything richer (multi-blur, feMerge, feTurbulence, feLighting,
// feComponentTransfer non-identity, etc.) flips `supported = false`
// and the graph-builder takes over. Recognized primitives match the
// dispatch tables in filterGraphSvg.js + filterGraphColr.js.

import { svgElementName, elementChildren, isFirstWithId } from './utils.js';
import { parseColor } from './color.js';
import { parseLength, parseLengthOr } from './length.js';
import {
  getNonInheritedProp,
  getStyleProp,
  parseAlphaOr,
  withCurrentColor,
  domFontSize,
} from './style.js';
import { featherDropShadowGraph } from './effectsSynth.js';
import { mantleWarn } from '../core/diagnostics.js';

/// Node types whose numeric parameters are lengths of the primitive's units (stdDeviation, dx / dy, radius, scale, a light's
/// x / y / z): an objectBoundingBox primitiveUnits makes them fractions of the referencing element's box. surfaceScale, the
/// k1..k4 of feComposite, the kernel and every exponent are unitless and stay as written.
const OBB_SCALED = new Set([
  'feGaussianBlur',
  'feOffset',
  'feMorphology',
  'feDisplacementMap',
  'feDiffuseLighting',
  'feSpecularLighting',
]);

/// The primitives whose result depends on the color space they operate in (color-interpolation-filters): the ones that read, make or mix color.
/// feOffset and feTile only move pixels and feImage draws sRGB bitmap data, so they carry nothing (the graph keeps the tag of their input).
const SPACE_TYPES = new Set([
  'feGaussianBlur',
  'feMorphology',
  'feColorMatrix',
  'feComposite',
  'feBlend',
  'feMerge',
  'feComponentTransfer',
  'feConvolveMatrix',
  'feDisplacementMap',
  'feDiffuseLighting',
  'feSpecularLighting',
  'feTurbulence',
]);

/// The color-interpolation-filters of an element, 1 for linearRGB (the initial value, Filter Effects 1 §15.8) and 0 for sRGB. An INHERITED
/// property, found as every other: this element's presentation attribute, style or rule, else its parent's, up to the root. `auto` lets the
/// user agent choose and Chrome chooses sRGB. A value that does not parse is dropped by the declaration reader and the next level applies.
export function colorInterpolationFilters(el) {
  for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentNode) {
    const v = getStyleProp(cur, 'color-interpolation-filters', null);
    if (v == null) continue;
    const t = v.trim().toLowerCase();
    if (t === 'linearrgb' || t === 'initial') return 1;
    if (t === 'srgb' || t === 'auto') return 0;
    // inherit / unset / revert, or a var() that did not resolve: this level states nothing
  }
  return 1;
}

/// Whether a 4x5 color matrix gives the same picture whatever space it runs in: its color rows are the identity or zero with no offset and no
/// alpha term, and the alpha row reads no color. (luminanceToAlpha, a tint matrix with an offset or a saturate do not.)
function matrixCommutesWithGamma(m) {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 5; c++) {
      const want = c === r ? m[r * 5 + c] : 0; // the diagonal may be 0 (the channel is dropped) or 1 (kept)
      if (m[r * 5 + c] !== want) return false;
    }
    if (m[r * 5 + r] !== 0 && m[r * 5 + r] !== 1) return false;
  }
  return m[15] === 0 && m[16] === 0 && m[17] === 0;
}

export function parseFilters(root, imageResolver, opts = {}) {
  const chromeLighting = opts.compat === 'chrome';
  // compat: 'chrome' also truncates a linearRGB feComponentTransfer table to 8 bits as Chrome does (the spec's table functions are exact; see below).
  const chromeTables = chromeLighting;
  // kernelUnitLength is accepted and ignored (Chrome ignores it too: the convolution always runs on device pixels). Said once.
  let warnedKernelUnit = false;
  const warnKernelUnitLength = () => {
    if (warnedKernelUnit) return;
    warnedKernelUnit = true;
    mantleWarn(
      'bundle exporter: feConvolveMatrix kernelUnitLength is not supported; the kernel runs on one device pixel per cell (as in Chrome).',
    );
  };
  let warnedConvolveOrder = false;
  const warnConvolveOrder = (order) => {
    if (warnedConvolveOrder) return;
    warnedConvolveOrder = true;
    mantleWarn(
      `bundle exporter: feConvolveMatrix order ${order} is above the supported 5x5; the filter is passed through.`,
    );
  };
  const filters = Object.create(null); // keyed by authored ids
  const groupGraphs = new Map();
  // The root viewport in user units, for userSpaceOnUse percentages (SVG 2: a percentage length is of the viewport's
  // width for x/width and its height for y/height): the viewBox size when there is one, else width/height, else 0.
  const _vpRoot = (() => {
    const attr = (n) => (root && root.getAttribute ? root.getAttribute(n) : null);
    const vb = String(attr('viewBox') || '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return [vb[2], vb[3]];
    const w = parseLengthOr(attr('width'), NaN),
      h = parseLengthOr(attr('height'), NaN);
    return [w > 0 ? w : 0, h > 0 ? h : 0];
  })();
  // flood-color, flood-opacity and lighting-color are CSS properties, so a style attribute, a stylesheet rule, currentColor
  // and var() set them as the presentation attribute does. None inherits: `inherit` takes the parent element's value.
  // currentColor is the primitive's own `color`, found down its DOM ancestors (a filter is never instantiated in place).
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const colorProp = (k, name, initial) => {
    const raw = getNonInheritedProp(k, name, initial);
    return withCurrentColor(k, raw);
  };
  /// [r, g, b, a] of a primitive's flood-color with its flood-opacity (clamped to [0, 1], a percentage a fraction) multiplied in.
  const floodRgba = (k) => {
    const rgba = parseColor(colorProp(k, 'flood-color', 'black'));
    const opacity = clamp01(parseAlphaOr(getNonInheritedProp(k, 'flood-opacity', '1'), 1));
    return [rgba[0], rgba[1], rgba[2], opacity * (rgba[3] !== undefined ? rgba[3] : 1)];
  };
  /// The LAST child of `k` named `tag` (lower case): a repeated feFuncR / G / B / A is overridden by the later one.
  const lastChildNamed = (k, tag) => {
    const kids = elementChildren(k);
    for (let i = kids.length - 1; i >= 0; i--) if (svgElementName(kids[i]) === tag) return kids[i];
    return undefined;
  };
  // Helpers: build common color matrices.
  const identity = () => [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
  const saturate = (s) => {
    // Standard SVG saturate matrix (luminance weights 0.2126, 0.7152, 0.0722).
    const r = 0.2126,
      g = 0.7152,
      b = 0.0722;
    return [
      r + s * (1 - r),
      g - s * g,
      b - s * b,
      0,
      0,
      r - s * r,
      g + s * (1 - g),
      b - s * b,
      0,
      0,
      r - s * r,
      g - s * g,
      b + s * (1 - b),
      0,
      0,
      0,
      0,
      0,
      1,
      0,
    ];
  };
  const hueRotate = (deg) => {
    const rad = (deg * Math.PI) / 180;
    const cs = Math.cos(rad),
      sn = Math.sin(rad);
    return [
      0.213 + cs * 0.787 - sn * 0.213,
      0.715 - cs * 0.715 - sn * 0.715,
      0.072 - cs * 0.072 + sn * 0.928,
      0,
      0,
      0.213 - cs * 0.213 + sn * 0.143,
      0.715 + cs * 0.285 + sn * 0.14,
      0.072 - cs * 0.072 - sn * 0.283,
      0,
      0,
      0.213 - cs * 0.213 - sn * 0.787,
      0.715 - cs * 0.715 + sn * 0.715,
      0.072 + cs * 0.928 + sn * 0.072,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
    ];
  };
  const luminanceToAlpha = () => [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2125, 0.7154, 0.0721, 0, 0,
  ];
  // Multiply two 4×5 color matrices (treating fifth column as offset).
  // Result = A · B applied to [r,g,b,a,1]^T meaning B applied first then A.
  const matMul45 = (A, B) => {
    const out = new Array(20);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 5; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += A[r * 5 + k] * B[k * 5 + c];
        if (c === 4) s += A[r * 5 + 4]; // add A's offset column
        out[r * 5 + c] = s;
      }
    }
    return out;
  };

  // Build a CPU-side filter DAG matching filterGraph.js's schema.
  // Returns { nodes, rootOut } or null if any primitive in the chain
  // isn't in the supported set. The graph dispatch handles a strict
  // subset of <fe*> elements today (matching the handlers registered
  // in filterGraphSvg.js); unsupported primitives bail to null so the
  // single-kind heuristic remains the fallback.
  //
  // Source sentinels (per filterGraph.js):
  //   -1 SourceGraphic / -2 SourceAlpha / -3 BackgroundImage
  //   -4 BackgroundAlpha / -5 FillPaint / -6 StrokePaint
  const colorMatrixFor = (element) => {
    const type = (element.getAttribute('type') || 'matrix').trim().toLowerCase();
    if (type === 'luminancetoalpha') return luminanceToAlpha();
    if (!['matrix', 'saturate', 'huerotate'].includes(type)) return null;
    const text = (element.getAttribute('values') || '').trim();
    if (!text) return identity();
    const tokens = text.split(/[\s,]+/);
    const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
    const values = tokens.map(Number),
      count = type === 'matrix' ? 20 : 1;
    if (
      tokens.length !== count ||
      tokens.some((token, i) => !number.test(token) || !Number.isFinite(values[i]))
    )
      return identity();
    return type === 'matrix'
      ? values
      : type === 'saturate'
        ? saturate(values[0])
        : hueRotate(values[0]);
  };

  const SRC = Object.assign(Object.create(null), {
    SourceGraphic: -1,
    SourceAlpha: -2,
    BackgroundImage: -3,
    BackgroundAlpha: -4,
    FillPaint: -5,
    StrokePaint: -6,
  });
  function buildFilterGraph(el) {
    const nodes = [];
    const byName = Object.create(null); // result-name → node index
    let inLast = SRC.SourceGraphic;
    // primitiveUnits: the system a primitive's x/y/width/height are in (userSpaceOnUse, the default:
    // lengths, a percentage of the root viewport; objectBoundingBox: fractions of the element's box).
    // null when the attribute is unstated, so the subregion falls back to the filter region's.
    const primOBB = (el.getAttribute('primitiveUnits') || '').trim() === 'objectBoundingBox';
    const primLength = (k, name) => {
      const raw = k.getAttribute(name);
      if (raw === null || raw === undefined || String(raw).trim() === '') return null;
      const t = String(raw).trim();
      if (t.endsWith('%')) {
        const v = parseFloat(t);
        if (!Number.isFinite(v)) return null;
        if (primOBB) return v / 100;
        const vp = name === 'x' || name === 'width' ? _vpRoot[0] : _vpRoot[1];
        return vp > 0 ? (v / 100) * vp : null;
      }
      const v = primOBB ? parseFloat(t) : parseLengthOr(t, NaN);
      return Number.isFinite(v) ? v : null;
    };
    /// The primitive subregion a primitive STATES (x / y / width / height, each null where unstated), in the filter's
    /// primitiveUnits, or null when it states none -- so a primitive that states nothing carries nothing and an asset that uses
    /// no subregion imports exactly as it did. The renderer resolves the defaults (the union of the inputs' subregions, or the
    /// filter region) and the units (filterDraw.js _primSubregions); an objectBoundingBox subregion is turned into user units
    /// against the referencing element's box at finalize (bundleFinalize.js).
    const primSub = (k) => {
      const v = ['x', 'y', 'width', 'height'].map((a) => primLength(k, a));
      return v.some((x) => x !== null) ? { v, u: primOBB ? 1 : 0 } : null;
    };
    function resolveInput(name) {
      if (!name) return inLast;
      if (Object.hasOwn(SRC, name)) return SRC[name];
      if (name in byName) return byName[name];
      // A reference to no earlier result -- unknown, or one a LATER primitive defines -- is treated as if no `in` was
      // given (Filter Effects 1 §15.2 / SVG 1.1 §15.7.2): the previous primitive's result, SourceGraphic for the first.
      return inLast;
    }
    const kids = elementChildren(el);
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const kt = svgElementName(k);
      let nodeType = null;
      let params = null;
      let inputs = null;
      let dropShadowBase = -1;
      if (kt === 'fegaussianblur') {
        nodeType = 'feGaussianBlur';
        const sd = (k.getAttribute('stdDeviation') || '0').trim();
        const parts = sd
          .split(/[\s,]+/)
          .map(parseFloat)
          .filter(Number.isFinite);
        const sx = parts.length >= 1 ? Math.max(0, parts[0]) : 0;
        const sy = parts.length >= 2 ? Math.max(0, parts[1]) : sx;
        params = { sigmaX: sx, sigmaY: sy };
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'femorphology') {
        nodeType = 'feMorphology';
        const op = (k.getAttribute('operator') || 'erode').trim().toLowerCase();
        const operator = op === 'dilate' ? 1 : 0;
        const r = (k.getAttribute('radius') || '0').trim();
        const parts = r
          .split(/[\s,]+/)
          .map(parseFloat)
          .filter(Number.isFinite);
        const rx = parts.length >= 1 ? Math.max(0, parts[0]) : 0;
        const ry = parts.length >= 2 ? Math.max(0, parts[1]) : rx;
        params = { operator, radiusX: rx, radiusY: ry };
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'feoffset') {
        nodeType = 'feOffset';
        const dx = parseLengthOr(k.getAttribute('dx') || '0', 0);
        const dy = parseLengthOr(k.getAttribute('dy') || '0', 0);
        params = { dx, dy };
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'feflood') {
        nodeType = 'feFlood';
        params = { rgba: floodRgba(k) };
        inputs = []; // feFlood is a source primitive — no inputs
      } else if (kt === 'fecolormatrix') {
        nodeType = 'feColorMatrix';
        const mat = colorMatrixFor(k);
        if (!mat) return null;
        params = { matrix: mat };
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'fecomposite') {
        nodeType = 'feComposite';
        const opName = (k.getAttribute('operator') || 'over').trim().toLowerCase();
        const opMap = { over: 0, in: 1, out: 2, atop: 3, xor: 4, arithmetic: 5, lighter: 5 };
        const op = Object.hasOwn(opMap, opName) ? opMap[opName] : 0;
        // `lighter` (Filter Effects 1) is the clamped sum of the premultiplied inputs: the arithmetic operator with k2 = k3 = 1, whatever
        // k1..k4 are authored (they only apply to `arithmetic`).
        const lighter = opName === 'lighter';
        const k1 = lighter ? 0 : parseLengthOr(k.getAttribute('k1') || '0', 0);
        const k2 = lighter ? 1 : parseLengthOr(k.getAttribute('k2') || '0', 0);
        const k3 = lighter ? 1 : parseLengthOr(k.getAttribute('k3') || '0', 0);
        const k4 = lighter ? 0 : parseLengthOr(k.getAttribute('k4') || '0', 0);
        params = { op, k: [k1, k2, k3, k4] };
        inputs = [resolveInput(k.getAttribute('in')), resolveInput(k.getAttribute('in2'))];
      } else if (kt === 'fediffuselighting' || kt === 'fespecularlighting') {
        nodeType = kt === 'fespecularlighting' ? 'feSpecularLighting' : 'feDiffuseLighting';
        const surfaceScale = parseLengthOr(k.getAttribute('surfaceScale') || '1', 1);
        const diffuseConstant = parseLengthOr(k.getAttribute('diffuseConstant') || '1', 1);
        const specularConstant = parseLengthOr(k.getAttribute('specularConstant') || '1', 1);
        const specularExponent = parseLengthOr(k.getAttribute('specularExponent') || '1', 1);
        const lrgba = parseColor(colorProp(k, 'lighting-color', 'white'));
        // Look at first <fe*Light> child for light source params.
        let lightType = 0; // distant default
        let lightPos = [0, 0, 0];
        let spotAt = [0, 0, 0];
        let spotExp = 1;
        let spotCosCone = 2.0; // > 1 → no cone
        for (const lc of elementChildren(k)) {
          const lt = svgElementName(lc);
          if (lt === 'fedistantlight') {
            lightType = 0;
            const azDeg = parseLengthOr(lc.getAttribute('azimuth') || '0', 0);
            const elDeg = parseLengthOr(lc.getAttribute('elevation') || '0', 0);
            const az = (azDeg * Math.PI) / 180;
            const el = (elDeg * Math.PI) / 180;
            // Spec §18.1: distant-light direction
            //   Lx = cos(elevation) * cos(azimuth)
            //   Ly = cos(elevation) * sin(azimuth)
            //   Lz = sin(elevation)
            lightPos = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
            break;
          } else if (lt === 'fepointlight') {
            lightType = 1;
            lightPos = [
              parseLengthOr(lc.getAttribute('x') || '0', 0),
              parseLengthOr(lc.getAttribute('y') || '0', 0),
              parseLengthOr(lc.getAttribute('z') || '0', 0),
            ];
            break;
          } else if (lt === 'fespotlight') {
            lightType = 2;
            lightPos = [
              parseLengthOr(lc.getAttribute('x') || '0', 0),
              parseLengthOr(lc.getAttribute('y') || '0', 0),
              parseLengthOr(lc.getAttribute('z') || '0', 0),
            ];
            spotAt = [
              parseLengthOr(lc.getAttribute('pointsAtX') || '0', 0),
              parseLengthOr(lc.getAttribute('pointsAtY') || '0', 0),
              parseLengthOr(lc.getAttribute('pointsAtZ') || '0', 0),
            ];
            spotExp = parseLengthOr(lc.getAttribute('specularExponent') || '1', 1);
            const limitAttr = lc.getAttribute('limitingConeAngle');
            if (limitAttr) {
              const ang = parseLengthOr(limitAttr, 0);
              spotCosCone = Math.cos((ang * Math.PI) / 180);
            }
            break;
          }
        }
        params = {
          surfaceScale,
          diffuseConstant,
          specularConstant,
          specularExponent,
          lightColor: [lrgba[0], lrgba[1], lrgba[2], 1],
          lightType,
          lightPos,
          spotAt,
          spotExp,
          spotCosCone,
        };
        // Only under compat: 'chrome', so a default import's graph is unchanged.
        if (chromeLighting && nodeType === 'feSpecularLighting') params.chromeSpecular = true;
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'fedisplacementmap') {
        nodeType = 'feDisplacementMap';
        const scale = parseLengthOr(k.getAttribute('scale') || '0', 0);
        const chMap = { R: 0, G: 1, B: 2, A: 3 };
        const xCh = k.getAttribute('xChannelSelector') || 'A';
        const yCh = k.getAttribute('yChannelSelector') || 'A';
        const xChan = Object.hasOwn(chMap, xCh) ? chMap[xCh] : 3;
        const yChan = Object.hasOwn(chMap, yCh) ? chMap[yCh] : 3;
        params = { scale, xChan, yChan };
        inputs = [resolveInput(k.getAttribute('in')), resolveInput(k.getAttribute('in2'))];
      } else if (kt === 'feturbulence') {
        nodeType = 'feTurbulence';
        const bfStr = (k.getAttribute('baseFrequency') || '0').trim();
        const bfParts = bfStr
          .split(/[\s,]+/)
          .map(parseFloat)
          .filter(Number.isFinite);
        const bx = bfParts.length >= 1 ? Math.max(0, bfParts[0]) : 0;
        const by = bfParts.length >= 2 ? Math.max(0, bfParts[1]) : bx;
        const oc = Math.max(1, Math.min(6, parseInt(k.getAttribute('numOctaves') || '1', 10) || 1));
        const seed = parseLengthOr(k.getAttribute('seed') || '0', 0);
        const typeStr = (k.getAttribute('type') || 'turbulence').trim().toLowerCase();
        const kind = typeStr === 'fractalnoise' ? 1 : 0;
        const stitchStr = (k.getAttribute('stitchTiles') || 'noStitch').trim().toLowerCase();
        const stitch = stitchStr === 'stitch' ? 1 : 0;
        params = { baseFreqX: bx, baseFreqY: by, numOctaves: oc, seed, kind, stitch };
        inputs = []; // source primitive — no inputs
      } else if (kt === 'feconvolvematrix') {
        // feConvolveMatrix — 2D NxM kernel convolution (capped at 5×5
        // by the shader). Parser computes divisor / target / edgeMode
        // defaults per the SVG Filter Effects spec. The graph holds
        // the raw kernel; the renderer interns it into bundle.kernelTab
        // (or, here, into a per-eval texture if the graph is the path).
        const orderRaw = (k.getAttribute('order') || '3').trim();
        const orderParts = orderRaw
          .split(/[\s,]+/)
          .map((s) => parseInt(s, 10))
          .filter(Number.isFinite);
        // Above the shader's 5x5 the whole filter passes through: keeping the first 25 values reads a different kernel, not a cropped one.
        if ((orderParts[0] || 3) > 5 || (orderParts.length > 1 && orderParts[1] > 5)) {
          warnConvolveOrder(orderRaw);
          return null;
        }
        const orderX = Math.max(1, Math.min(5, orderParts[0] || 3));
        const orderY = Math.max(1, Math.min(5, orderParts.length > 1 ? orderParts[1] : orderX));
        const km = (k.getAttribute('kernelMatrix') || '').trim();
        const kvalsAll = km
          .split(/[\s,]+/)
          .map(parseFloat)
          .filter(Number.isFinite);
        const need = orderX * orderY;
        if (kvalsAll.length < need) {
          // A kernelMatrix shorter than orderX * orderY is an error (Filter Effects 1 §15.9): the filter cannot be built.
          return null;
        } else {
          const kvals = kvalsAll.slice(0, need);
          // Pack into a 25-float buffer (the shader unrolls to 5×5).
          const kernel = new Float32Array(25);
          for (let kk = 0; kk < kvals.length; kk++) kernel[kk] = kvals[kk];
          const divAttr = parseFloat(k.getAttribute('divisor'));
          let divisor;
          if (Number.isFinite(divAttr) && divAttr !== 0) divisor = divAttr;
          else {
            let s = 0;
            for (const v of kvals) s += v;
            divisor = s !== 0 ? s : 1;
          }
          const bias = parseLengthOr(k.getAttribute('bias') || '0', 0);
          const targetX = Number.isFinite(parseInt(k.getAttribute('targetX'), 10))
            ? parseInt(k.getAttribute('targetX'), 10)
            : Math.floor(orderX / 2);
          const targetY = Number.isFinite(parseInt(k.getAttribute('targetY'), 10))
            ? parseInt(k.getAttribute('targetY'), 10)
            : Math.floor(orderY / 2);
          const edgeStr = (k.getAttribute('edgeMode') || 'duplicate').trim().toLowerCase();
          const edgeMode = edgeStr === 'wrap' ? 1 : edgeStr === 'none' ? 2 : 0;
          const preserveAlpha =
            (k.getAttribute('preserveAlpha') || 'false').trim().toLowerCase() === 'true' ? 1 : 0;
          nodeType = 'feConvolveMatrix';
          params = {
            orderX,
            orderY,
            targetX,
            targetY,
            divisor,
            bias,
            edgeMode,
            preserveAlpha,
            kernel, // 25 floats; renderer uploads as needed
          };
          inputs = [resolveInput(k.getAttribute('in'))];
        }
      } else if (kt === 'feimage') {
        // Source primitive: bring a bitmap into the filter graph. "#imgId" names an in-document <image>
        // whose atlas slot is already claimed; any other href is an EXTERNAL raster (a data: URL, or a URL
        // the browser can load), which the importer preloaded against this element before parsing.
        const href = (k.getAttribute('href') || k.getAttribute('xlink:href') || '').trim();
        const resolved = imageResolver ? imageResolver(href, k) : null;
        // An href that did not resolve draws TRANSPARENT BLACK, as a failed feImage load does in a
        // browser: a source node with no image (the handler clears for imageId 0), with a type and
        // inputs the node-rect pass can iterate.
        if (!resolved) {
          nodeType = 'feImage';
          params = { imageId: 0 };
          inputs = [];
        } else {
          nodeType = 'feImage';
          const par = (
            (resolved.box ? resolved.par : k.getAttribute('preserveAspectRatio')) || 'xMidYMid meet'
          )
            .trim()
            .toLowerCase();
          const preserveAR = par === 'none' ? 0 : 1;
          params = {
            imageId: resolved.imageId,
            imgW: resolved.w,
            imgH: resolved.h,
            preserveAR,
          };
          if (resolved.external) {
            // Placed per spec (filterGraph/feImagePlace.js): fitted by preserveAspectRatio into the
            // primitive subregion, x/y/width/height in the filter's primitiveUnits (null = the filter
            // region's own). The "#id" form keeps its older placement, the image fitted to the region.
            const [alignStr, meetStr] = par.split(/\s+/);
            const ax = /^xmin/.test(alignStr) ? 0 : /^xmax/.test(alignStr) ? 2 : 1;
            const ay = /ymin$/.test(alignStr) ? 0 : /ymax$/.test(alignStr) ? 2 : 1;
            params.external = 1;
            params.align = [ax, ay];
            params.fit = alignStr === 'none' ? 2 : meetStr === 'slice' ? 1 : 0;
            params.subUnits = primOBB ? 1 : 0;
            params.sub = ['x', 'y', 'width', 'height'].map((a) => primLength(k, a));
            // The subregion the feImage STATES (so the primitives that read it default to it: Filter Effects 1 §15.3).
            if (params.sub.some((v) => v !== null)) params.subStated = 1;
            // A referenced <image> element: its own box in the referencing element's user space (a placement, not a stated subregion).
            if (resolved.box) {
              params.subUnits = 0;
              params.sub = resolved.box.slice();
              delete params.subStated;
            }
          }
          inputs = []; // source primitive
        }
      } else if (kt === 'fedropshadow') {
        // blur(in) -> offset -> flood "in" that alpha -> merge over `in`: the chain
        // effectsSynth.featherDropShadowGraph builds for the single-primitive shorthand. Only the
        // merge is this primitive's own node (its result name and `inLast` slot); the three before it are
        // helpers. Without this case a feDropShadow on a <g>, or in a chain, would produce no graph and
        // draw no shadow.
        const src = resolveInput(k.getAttribute('in'));
        const sd = (k.getAttribute('stdDeviation') || '2').trim();
        const sdParts = sd
          .split(/[\s,]+/)
          .map(parseFloat)
          .filter(Number.isFinite);
        const dsx = sdParts.length >= 1 ? Math.max(0, sdParts[0]) : 0;
        const dsy = sdParts.length >= 2 ? Math.max(0, sdParts[1]) : dsx;
        const dx = parseLengthOr(k.getAttribute('dx') || '2', 2);
        const dy = parseLengthOr(k.getAttribute('dy') || '2', 2);
        const base = nodes.length;
        dropShadowBase = base;
        nodes.push({
          type: 'feGaussianBlur',
          inputs: [src],
          params: primOBB ? { sigmaX: dsx, sigmaY: dsy, obb: 1 } : { sigmaX: dsx, sigmaY: dsy },
        });
        nodes.push({
          type: 'feOffset',
          inputs: [base],
          params: primOBB ? { dx, dy, obb: 1 } : { dx, dy },
        });
        nodes.push({ type: 'feFlood', inputs: [], params: { rgba: floodRgba(k) } });
        nodes.push({
          type: 'feComposite',
          inputs: [base + 2, base + 1],
          params: { op: 1, k: [0, 0, 0, 0] },
        });
        nodeType = 'feMerge';
        params = {};
        inputs = [base + 3, src];
      } else if (kt === 'fetile') {
        nodeType = 'feTile';
        params = {};
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'feblend') {
        nodeType = 'feBlend';
        const modeName = (k.getAttribute('mode') || 'normal').trim().toLowerCase();
        const modeMap = {
          normal: 0,
          multiply: 1,
          screen: 2,
          overlay: 3,
          darken: 4,
          lighten: 5,
          'color-dodge': 6,
          'color-burn': 7,
          'hard-light': 8,
          'soft-light': 9,
          difference: 10,
          exclusion: 11,
          hue: 12,
          saturation: 13,
          color: 14,
          luminosity: 15,
        };
        const mode = Object.hasOwn(modeMap, modeName) ? modeMap[modeName] : 0;
        params = { mode };
        inputs = [resolveInput(k.getAttribute('in')), resolveInput(k.getAttribute('in2'))];
      } else if (kt === 'femerge') {
        nodeType = 'feMerge';
        // mergeNode children carry per-input `in` attrs.
        const mergeKids = elementChildren(k);
        const ins = [];
        for (const mk of mergeKids) {
          if (svgElementName(mk) !== 'femergenode') continue;
          ins.push(resolveInput(mk.getAttribute('in')));
        }
        if (!ins.length) return null;
        params = {};
        inputs = ins;
      } else if (kt === 'fecomponenttransfer') {
        nodeType = 'feComponentTransfer';
        // Reuse the same per-channel transfer-function logic as the
        // kind path — produces 4 closures `(x) → y` on [0,1]; bake
        // each into a 256-byte ramp row and pack into a 256×4 LUT.
        const fnFor = (chanTag) => {
          const fn = lastChildNamed(k, chanTag);
          if (!fn) return (x) => x;
          const type = (fn.getAttribute('type') || 'identity').toLowerCase();
          const valStr = fn.getAttribute('tableValues') || '';
          const slope = parseLengthOr(fn.getAttribute('slope') || '1', 1);
          const intercept = parseLengthOr(fn.getAttribute('intercept') || '0', 0);
          const amplitude = parseLengthOr(fn.getAttribute('amplitude') || '1', 1);
          const exponent = parseLengthOr(fn.getAttribute('exponent') || '1', 1);
          const offset = parseLengthOr(fn.getAttribute('offset') || '0', 0);
          const tableVals = valStr
            .trim()
            .split(/[\s,]+/)
            .map(parseFloat)
            .filter(Number.isFinite);
          return (x) => {
            if (type === 'linear') return slope * x + intercept;
            if (type === 'gamma') return amplitude * Math.pow(x, exponent) + offset;
            if (type === 'table' && tableVals.length === 1) return tableVals[0]; // one value: a constant
            if (type === 'table' && tableVals.length >= 2) {
              const n = tableVals.length - 1;
              const t = Math.max(0, Math.min(1, x)) * n;
              const i = Math.floor(t);
              const f = t - i;
              if (i >= n) return tableVals[n];
              return tableVals[i] * (1 - f) + tableVals[i + 1] * f;
            }
            if (type === 'discrete' && tableVals.length >= 1) {
              const idx = Math.min(
                tableVals.length - 1,
                Math.floor(Math.max(0, Math.min(1, x)) * tableVals.length),
              );
              return tableVals[idx];
            }
            return x;
          };
        };
        const fns = [fnFor('fefuncr'), fnFor('fefuncg'), fnFor('fefuncb'), fnFor('fefunca')];
        const linTable = chromeTables && colorInterpolationFilters(k) === 1;
        // Bake to 256×4 RGBA8 (4 rows, one per channel). Each row
        // stores the function values × 255 in the R channel; the
        // shader reads .r. Other channels are zero.
        const lut = new Uint8Array(256 * 4 * 4);
        for (let row = 0; row < 4; row++) {
          const fn = fns[row];
          for (let i = 0; i < 256; i++) {
            const y = Math.max(0, Math.min(1, fn(i / 255)));
            // Row layout: row r at v=row, x at u=i; texel at (i, row) is
            // at byte offset (row * 256 + i) * 4.
            // Filter Effects 1 §15.7 (feComponentTransfer) defines the transfer functions exactly; the table is the nearest 8-bit entry. Chrome's
            // 8-bit table DROPS the fraction instead (0.66 -> 0, 2.5 -> 2), which a linearRGB result shows as up to 13 levels of sRGB in the
            // darks (one level of linear light): importSvg({ compat: 'chrome' }) reproduces that, the default is the spec.
            lut[(row * 256 + i) * 4 + 0] = linTable ? Math.floor(y * 255) : Math.round(y * 255);
          }
        }
        params = { lutBytes: lut };
        inputs = [resolveInput(k.getAttribute('in'))];
      } else {
        // Not a filter primitive (<title>, <desc>, <animate>, an unknown element): it takes no part in the chain.
        continue;
      }
      const idx = nodes.length;
      // color-interpolation-filters: this primitive's own value (the property is inherited from the filter element and its ancestors).
      if (SPACE_TYPES.has(nodeType) && colorInterpolationFilters(k) === 1) {
        params.cs = 1;
        if (dropShadowBase >= 0)
          for (let j = dropShadowBase; j < idx; j++)
            if (SPACE_TYPES.has(nodes[j].type)) nodes[j].params.cs = 1;
      }
      if (primOBB && OBB_SCALED.has(nodeType)) params.obb = 1;
      if (kt === 'feconvolvematrix' && k.hasAttribute('kernelUnitLength')) warnKernelUnitLength();
      // feImage keeps its own subregion (params.sub / subUnits above); every other primitive carries the one it states.
      if (kt !== 'feimage') {
        const sub = primSub(k);
        if (sub) {
          params.sub = sub.v;
          params.subUnits = sub.u;
          // A stated width or height of zero or less DISABLES the primitive (transparent black) in Filter Effects 1 (the default).
          // Chrome does not clip it: compat 'chrome' marks the node, and filterGraph/feImagePlace.js primitiveSubregions then leaves it
          // at its default subregion.
          if (
            chromeLighting &&
            ((sub.v[2] !== null && sub.v[2] <= 0) || (sub.v[3] !== null && sub.v[3] <= 0))
          )
            params.chromeZeroSub = 1;
        }
      }
      nodes.push({ type: nodeType, inputs, params });
      const result = k.getAttribute('result');
      if (result) byName[result] = idx;
      inLast = idx;
    }
    if (!nodes.length) return null;
    const graph = { nodes, rootOut: nodes.length - 1 };
    // Parameters or a subregion in objectBoundingBox primitiveUnits: they become user units against the referencing element's
    // box, which only the import of that element knows (importWalk claimFilter, bundleFinalize).
    if (
      nodes.some(
        (n) => n.params && (n.params.obb || (n.params.subUnits === 1 && n.type !== 'feImage')),
      )
    )
      graph.obb = true;
    return graph;
  }

  const visit = (el) => {
    const tag = svgElementName(el);
    if (tag === 'filter') {
      const id = el.getAttribute('id');
      if (id && isFirstWithId(root, el, id)) {
        // FILTER REGION (Filter Effects 7.1). x/y/width/height on <filter>, read in
        // filterUnits, bound the filter's output: nothing outside is painted, however
        // far a blur reaches. Parsed once here and attached to whichever record shape
        // this element produces below.
        //
        // objectBoundingBox (the default) makes them FRACTIONS of the filtered
        // element's bbox, and the initial values are -10%/-10%/120%/120% — which is
        // why an unstated region still leaves room for a modest blur. userSpaceOnUse
        // makes them user-space lengths.
        const _fu = (el.getAttribute('filterUnits') || 'objectBoundingBox').trim();
        const _oBB = _fu !== 'userSpaceOnUse';
        // The filter element's own font-size, for em / ex / rem in a userSpaceOnUse region (read down the DOM).
        let _fontCtx = null;
        const _plainNumber = /^[+-]?(?:\d*\.?\d+|\d+\.)(?:[eE][+-]?\d+)?$/;
        const _num = (name, dflt) => {
          const raw = el.getAttribute(name);
          if (raw === null || raw === undefined || raw === '') return dflt;
          const t = String(raw).trim();
          // objectBoundingBox: a percentage is a fraction of the bounding box, as a bare number already is, and a
          // length with a unit is invalid there.
          // userSpaceOnUse: a percentage is of the root viewport, width for x/width and height for y/height, and a
          // length is parsed as every other (units, em); a value that does not parse is ignored, whatever follows
          // its leading digits. A percentage is a fraction only under objectBoundingBox.
          if (t.endsWith('%')) {
            const body = t.slice(0, -1);
            if (!_plainNumber.test(body)) return dflt;
            const v = parseFloat(body);
            if (_oBB) return v / 100;
            const vp = name === 'x' || name === 'width' ? _vpRoot[0] : _vpRoot[1];
            return vp > 0 ? (v / 100) * vp : dflt;
          }
          if (_oBB) return _plainNumber.test(t) ? parseFloat(t) : dflt;
          if (!_fontCtx) _fontCtx = domFontSize(el);
          const v = parseLengthOr(t, NaN, {
            ..._fontCtx,
            parentWidth: _vpRoot[0],
            parentHeight: _vpRoot[1],
            axis: name === 'x' || name === 'width' ? 'x' : 'y',
          });
          return Number.isFinite(v) ? v : dflt;
        };
        // Was a region actually STATED? A stated region clips wherever the filter is used. The implicit
        // default (-10%/-10%/120%/120%) clips a shape that references the filter itself; one inherited
        // from a group does not, because the region belongs to the group (importWalk resolveFilterRegion).
        const _stated = ['x', 'y', 'width', 'height'].some((a) => {
          const v = el.getAttribute(a);
          return v !== null && v !== undefined && String(v).trim() !== '';
        });
        groupGraphs.set(id, () => buildFilterGraph(el));
        const region = {
          stated: _stated,
          oBB: _oBB,
          x: _num('x', _oBB ? -0.1 : _vpRoot[0] > 0 ? -0.1 * _vpRoot[0] : NaN),
          y: _num('y', _oBB ? -0.1 : _vpRoot[1] > 0 ? -0.1 * _vpRoot[1] : NaN),
          w: _num('width', _oBB ? 1.2 : _vpRoot[0] > 0 ? 1.2 * _vpRoot[0] : NaN),
          h: _num('height', _oBB ? 1.2 : _vpRoot[1] > 0 ? 1.2 * _vpRoot[1] : NaN),
        };
        // A stated width or height of zero or less disables the effect: the element paints nothing (Filter Effects 1
        // §7.1). Taken before the fallback below overwrites the extents.
        if (
          [
            ['width', region.w],
            ['height', region.h],
          ].some(([a, v]) => {
            const raw = el.getAttribute(a);
            return (
              raw !== null &&
              raw !== undefined &&
              String(raw).trim() !== '' &&
              Number.isFinite(v) &&
              v <= 0
            );
          })
        )
          region.empty = true;
        // Without a known viewport, retain the object-box fallback rather
        // than emitting non-finite section coordinates.
        if (!_oBB && !(region.w > 0 && region.h > 0)) {
          region.oBB = true;
          region.x = -0.1;
          region.y = -0.1;
          region.w = 1.2;
          region.h = 1.2;
        }
        // Non-standard override: `data-mantle-filter-region="none"` turns the region clip off for this filter.
        //
        // SVG's region is a hard clip, and that is what browsers do. Content converted from a source with different
        // filter semantics needs a way to say so: Flash filters GROW the object's bounds to fit the effect instead of
        // cutting it, so a converted drop shadow or glow loses its tail under the SVG rule. A converter can stamp this
        // attribute on the filters it emits. The name is deliberately a `data-` attribute: it survives SVG tools that
        // drop unknown namespaced attributes, and it names the behavior it overrides. "spec" is the default.
        const _regionOverride = (el.getAttribute('data-mantle-filter-region') || '')
          .trim()
          .toLowerCase();
        if (_regionOverride === 'none' || _regionOverride === 'unbounded') region.unbounded = true;
        let m = identity();
        let supported = true;
        let componentTransferLUT = null;

        let blurSigmaX = 0,
          blurSigmaY = 0;
        let sawBlur = false; // a feGaussianBlur was seen, whatever its sigma: a zero one still keeps its node (graph route) so it can be animated up
        const kids = elementChildren(el);
        // A primitive that states a subregion (x / y / width / height), or numbers in objectBoundingBox primitiveUnits, needs the
        // graph: the single-kind records have no per-primitive region and no box to scale against.
        const _fes = kids.filter((c) => svgElementName(c).startsWith('fe'));
        const _primOBB = (el.getAttribute('primitiveUnits') || '').trim() === 'objectBoundingBox';
        const _obbNames = new Set([
          'fegaussianblur',
          'femorphology',
          'feoffset',
          'fedisplacementmap',
          'fedropshadow',
          'fediffuselighting',
          'fespecularlighting',
        ]);
        const forceGraph =
          _fes.some((c) =>
            ['x', 'y', 'width', 'height'].some((a) => {
              const v = c.getAttribute(a);
              return v !== null && v !== undefined && String(v).trim() !== '';
            }),
          ) ||
          (_primOBB && _fes.some((c) => _obbNames.has(svgElementName(c))));
        // The single-kind shorthands (feDropShadow / feConvolveMatrix /
        // feMorphology) may only claim filters[id] when they are the SOLE
        // primitive — writing it mid-loop silently discards every sibling
        // primitive. With siblings, route the whole chain to the graph
        // builder instead.
        let feCount = 0;
        for (const k9 of kids) {
          if (svgElementName(k9).startsWith('fe')) feCount++;
        }
        // The result name of the nearest preceding fe* sibling — the only
        // input a linear fold can follow, since it folds primitives in
        // document order.
        const prevFeResult = (upto) => {
          for (let j = upto - 1; j >= 0; j--) {
            const t = svgElementName(kids[j]);
            if (t.startsWith('fe')) return (kids[j].getAttribute('result') || '').trim();
          }
          return '';
        };
        const isFirstFe = (upto) => {
          for (let j = upto - 1; j >= 0; j--) {
            if (svgElementName(kids[j]).startsWith('fe')) return false;
          }
          return true;
        };
        // Primitives that reduce to this path's (matrix, sigma) pair. A
        // leading in="SourceAlpha" folds into the matrix for these — see
        // srcAlphaPrefix below. Everything else has to reach the graph
        // builder to get the sentinel resolved.
        const FOLDABLE_IN = new Set(['fegaussianblur', 'fecolormatrix', 'fecomponenttransfer']);
        let srcAlphaPrefix = false;
        // color-interpolation-filters: linearRGB (the default) changes the picture of a primitive that mixes or transforms color, and the folded
        // (matrix, sigma) record below runs in sRGB. A chain with such a primitive in linearRGB takes the graph, which converts around it; one
        // without (a blur of the source ALPHA, a tint, a matrix that leaves color alone) gives the same picture in either space and keeps the record.
        let linSensitive = false;
        // A blur of color in linearRGB that nothing else in the chain disturbs is the single-kind blur on linear light (filterTab kind 7): the renderer
        // converts on the first pass and the composite converts back, so it keeps the in-place route instead of the graph.
        let linBlur = false;
        let colorless = false; // the chain so far carries no color (it started from SourceAlpha and nothing has made any)
        for (let i = 0; i < kids.length; i++) {
          if (forceGraph) {
            supported = false;
            break;
          }
          const k = kids[i];
          const kt = svgElementName(k);
          const lin = kt.startsWith('fe') && colorInterpolationFilters(k) === 1;
          // Every branch below folds the primitive as if it read
          // SourceGraphic — none of them consult `in`. So a primitive naming
          // a different sentinel would be silently filtered against the COLOR
          // graphic: `<feGaussianBlur in="SourceAlpha">`, the standard
          // hand-rolled drop shadow, would produce a red blur where a black one
          // belongs. Hand those to buildFilterGraph, which resolves sentinels
          // properly.
          //
          // An `in` naming the immediately preceding primitive's result is
          // exactly what the linear fold already assumes, so those keep the
          // fast path. feComposite is exempt because it is only recognized
          // here as the feFlood + operator="in" tint, whose baked matrix
          // takes RGB from the flood and alpha from the source — identical
          // for SourceGraphic and SourceAlpha.
          if (kt.startsWith('fe') && kt !== 'fecomposite') {
            const inName = (k.getAttribute('in') || '').trim();
            const prev = prevFeResult(i);
            // A later explicit source starts another input chain; the graph
            // preserves that branch and any earlier named results.
            if (inName === 'SourceGraphic' && !isFirstFe(i)) {
              supported = false;
              continue;
            }
            if (inName && inName !== 'SourceGraphic' && !(prev && inName === prev)) {
              // A LEADING SourceAlpha stays on the fast path, because the
              // mask is itself a linear 4x5 matrix with a zero offset column
              // and it commutes with everything this path folds: masking RGB
              // to zero then blurring per channel is the same as blurring
              // then masking. So it composes into `m` and the drop shadow —
              // the single most common filter there is — keeps its one-pass
              // route instead of building a graph.
              //
              // Only for the primitives that reduce to (matrix, sigma).
              // feConvolveMatrix and feMorphology write their own record with
              // no matrix to fold into, so they still go to the graph.
              if (inName === 'SourceAlpha' && isFirstFe(i) && FOLDABLE_IN.has(kt)) {
                srcAlphaPrefix = true;
                colorless = true;
              } else {
                supported = false;
                continue;
              }
            }
          }
          if (kt === 'fecolormatrix') {
            const matrix = colorMatrixFor(k);
            if (matrix) {
              m = matMul45(matrix, m);
              // A matrix on a colorless input makes color only through its alpha column and offsets; with none the picture is the same in either space.
              const makesColor = [3, 4, 8, 9, 13, 14].some((q) => matrix[q] !== 0);
              if (colorless) {
                if (makesColor) {
                  colorless = false;
                  if (lin) linSensitive = true;
                }
              } else if (lin && !matrixCommutesWithGamma(matrix)) linSensitive = true;
            } else supported = false;
          } else if (kt === 'fecomponenttransfer') {
            // 4 per-channel 1D transfer functions. Bake into a 256×4
            // float LUT and compose with the running matrix. Each channel
            // is sampled independently from its own row of the LUT.
            const fnFor = (chanTag, defaultIdent) => {
              const fn = lastChildNamed(k, chanTag);
              if (!fn) return defaultIdent;
              const type = (fn.getAttribute('type') || 'identity').toLowerCase();
              const valStr = fn.getAttribute('tableValues') || '';
              const slope = parseLengthOr(fn.getAttribute('slope') || '1', 1);
              const intercept = parseLengthOr(fn.getAttribute('intercept') || '0', 0);
              const amplitude = parseLengthOr(fn.getAttribute('amplitude') || '1', 1);
              const exponent = parseLengthOr(fn.getAttribute('exponent') || '1', 1);
              const offset = parseLengthOr(fn.getAttribute('offset') || '0', 0);
              const tableVals = valStr
                .trim()
                .split(/[\s,]+/)
                .map(parseFloat)
                .filter(Number.isFinite);
              return (x) => {
                if (type === 'identity') return x;
                if (type === 'linear') return slope * x + intercept;
                if (type === 'gamma') return amplitude * Math.pow(x, exponent) + offset;
                if (type === 'table' && tableVals.length === 1) return tableVals[0]; // one value: a constant
                if (type === 'table' && tableVals.length >= 2) {
                  const n = tableVals.length - 1;
                  const t = Math.max(0, Math.min(1, x)) * n;
                  const i = Math.floor(t);
                  const f = t - i;
                  if (i >= n) return tableVals[n];
                  return tableVals[i] * (1 - f) + tableVals[i + 1] * f;
                }
                if (type === 'discrete' && tableVals.length >= 1) {
                  const idx = Math.min(
                    tableVals.length - 1,
                    Math.floor(Math.max(0, Math.min(1, x)) * tableVals.length),
                  );
                  return tableVals[idx];
                }
                return x;
              };
            };
            const fR = fnFor('fefuncr', (x) => x);
            const fG = fnFor('fefuncg', (x) => x);
            const fB = fnFor('fefuncb', (x) => x);
            const fA = fnFor('fefunca', (x) => x);
            // Capture per-filter LUT data; matrix already accumulated.
            componentTransferLUT = { fR, fG, fB, fA };
          } else if (kt === 'feflood' || kt === 'fecomposite') {
            // Recognize the very common "tint" idiom that bakes to a
            // color matrix (no FBO needed):
            //
            //   <feFlood flood-color="C" flood-opacity="A" result="r1"/>
            //   <feComposite in="r1" in2="SourceGraphic" operator="in" result="r2"/>

            if (kt === 'feflood') {
              const primitives = kids.filter((child) => svgElementName(child).startsWith('fe'));
              if (
                primitives.length !== 2 ||
                primitives[0] !== k ||
                svgElementName(primitives[1]) !== 'fecomposite'
              )
                supported = false;
              continue;
            }
            // Only a standalone flood/source tint can share this linear record.
            if (feCount !== 2) {
              supported = false;
              continue;
            }
            const op = (k.getAttribute('operator') || 'over').toLowerCase();
            const in1 = (k.getAttribute('in') || '').trim();
            const in2 = (k.getAttribute('in2') || '').trim();
            if (op !== 'in') {
              supported = false;
              continue;
            }

            const findFlood = (refName) => {
              if (
                !refName ||
                refName === 'SourceGraphic' ||
                refName === 'SourceAlpha' ||
                refName === 'BackgroundImage' ||
                refName === 'BackgroundAlpha'
              )
                return null;
              for (let j = 0; j < i; j++) {
                const p = kids[j];
                if (svgElementName(p) !== 'feflood') continue;
                if ((p.getAttribute('result') || '') === refName) return p;
              }
              return null;
            };
            const isSrc = (s) => s === 'SourceGraphic' || s === 'SourceAlpha';
            let flood = null;
            if (isSrc(in1)) flood = findFlood(in2);
            else if (isSrc(in2)) flood = findFlood(in1);
            else {
              supported = false;
              continue;
            }
            if (!flood) {
              supported = false;
              continue;
            }
            const rgba = floodRgba(flood);
            const A = rgba[3];
            const Cr = rgba[0],
              Cg = rgba[1],
              Cb = rgba[2];
            // Output = (Cr * src.a, Cg * src.a, Cb * src.a, A * src.a).
            const tint = [0, 0, 0, Cr, 0, 0, 0, 0, Cg, 0, 0, 0, 0, Cb, 0, 0, 0, 0, A, 0];
            m = matMul45(tint, m);
            colorless = false;
          } else if (kt === 'fegaussianblur') {
            // stdDeviation: one or two numbers. Single value applies to
            // both axes; two values give X then Y. Negative values are
            // an error per spec; treat as zero.
            const sd = (k.getAttribute('stdDeviation') || '').trim();
            const parts = sd
              .split(/[\s,]+/)
              .map(parseFloat)
              .filter(Number.isFinite);
            const sx = parts.length >= 1 ? Math.max(0, parts[0]) : 0;
            const sy = parts.length >= 2 ? Math.max(0, parts[1]) : sx;
            sawBlur = true;
            // Blurs compose by Pythagorean sum of sigmas (since the
            // convolution of two Gaussians is a Gaussian with sigma
            // sqrt(σ₁² + σ₂²)).
            blurSigmaX = Math.sqrt(blurSigmaX * blurSigmaX + sx * sx);
            blurSigmaY = Math.sqrt(blurSigmaY * blurSigmaY + sy * sy);
            if (lin && (sx > 0 || sy > 0) && !colorless) linBlur = true;
          } else if (kt === 'fedropshadow') {
            if (feCount > 1) {
              supported = false;
              continue;
            }
            const sd = (k.getAttribute('stdDeviation') || '2').trim();
            const sdParts = sd
              .split(/[\s,]+/)
              .map(parseFloat)
              .filter(Number.isFinite);
            const dsx = sdParts.length >= 1 ? Math.max(0, sdParts[0]) : 0;
            const dsy = sdParts.length >= 2 ? Math.max(0, sdParts[1]) : dsx;
            const dx = parseFloat(k.getAttribute('dx') || '2');
            const dy = parseFloat(k.getAttribute('dy') || '2');
            const rgba = floodRgba(k);
            const aMul = rgba[3];
            const dsGraph = featherDropShadowGraph(dsx, dsy, dx, dy, [
              rgba[0],
              rgba[1],
              rgba[2],
              aMul,
            ]);
            // linearRGB: the shadow's flood and the merge over the source run in linear light (the blur sees only alpha, the offset only moves).
            if (lin)
              for (const nd of dsGraph.nodes)
                if (SPACE_TYPES.has(nd.type)) nd.params = { ...nd.params, cs: 1 };
            filters[id] = {
              region,
              kind: 'graph',
              graph: dsGraph,
            };
            supported = null; // Already wrote filters[id]; skip the
            //  generic colorMatrix/blur record below.
          } else if (kt === 'feconvolvematrix') {
            if (feCount > 1 || lin) {
              supported = false;
              continue;
            } // chain, or linearRGB (it mixes color) → graph builder
            if (k.hasAttribute('kernelUnitLength')) warnKernelUnitLength();
            // feConvolveMatrix — general N×M convolution kernel.
            // Production-class kernels are typically 3×3 (emboss,
            // sharpen, edge); the renderer caps support at 5×5 so the
            // shader can unroll cleanly. Beyond 5×5 falls through to the
            // graph builder, which warns and passes the filter through.
            const orderStr = (k.getAttribute('order') || '3').trim();
            const orderParts = orderStr
              .split(/[\s,]+/)
              .map(parseFloat)
              .filter(Number.isFinite);
            if ((orderParts[0] || 3) > 5 || (orderParts.length >= 2 && orderParts[1] > 5)) {
              supported = false;
              continue;
            }
            const orderX = Math.max(1, Math.min(5, Math.floor(orderParts[0] || 3)));
            const orderY = Math.max(
              1,
              Math.min(5, Math.floor(orderParts.length >= 2 ? orderParts[1] : orderX)),
            );
            const kernelStr = (k.getAttribute('kernelMatrix') || '').trim();
            const kernel = kernelStr
              .split(/[\s,]+/)
              .map(parseFloat)
              .filter(Number.isFinite);
            // Spec: kernel.length must equal orderX*orderY, and a shorter kernel is an error that disables the filter
            // (as in the graph builder); the slot is padded to a fixed 25 floats so the shader can index unconditionally.
            const needed = orderX * orderY;
            if (kernel.length < needed) {
              supported = false;
              continue;
            }
            while (kernel.length < 25) kernel.push(0);
            // divisor defaults to the sum of kernel values (or 1 if 0).
            const sum = kernel.slice(0, needed).reduce((s, v) => s + v, 0);
            const divisorAttr = parseFloat(k.getAttribute('divisor'));
            const divisor =
              Number.isFinite(divisorAttr) && divisorAttr !== 0 ? divisorAttr : sum !== 0 ? sum : 1;
            const bias = parseLengthOr(k.getAttribute('bias'), 0);
            const targetX = Number.isFinite(parseFloat(k.getAttribute('targetX')))
              ? parseInt(k.getAttribute('targetX'), 10)
              : Math.floor(orderX / 2);
            const targetY = Number.isFinite(parseFloat(k.getAttribute('targetY')))
              ? parseInt(k.getAttribute('targetY'), 10)
              : Math.floor(orderY / 2);
            const edgeStr = (k.getAttribute('edgeMode') || 'duplicate').trim().toLowerCase();
            const edgeMode = edgeStr === 'wrap' ? 1 : edgeStr === 'none' ? 2 : 0;
            const preserveAlpha =
              (k.getAttribute('preserveAlpha') || 'false').trim().toLowerCase() === 'true' ? 1 : 0;
            filters[id] = {
              region,
              kind: 'convolve',
              orderX,
              orderY,
              targetX,
              targetY,
              divisor,
              bias,
              edgeMode,
              preserveAlpha,
              kernel, // 25 floats
            };
            supported = null;
          } else if (kt === 'femorphology') {
            if (feCount > 1 || lin) {
              supported = false;
              continue;
            } // chain, or linearRGB (it mixes color) → graph builder
            // feMorphology: per-pixel max (dilate) or min (erode) over a
            // rectangular neighborhood of radius (rx, ry) in user space.
            // Spec: SVG Filter Effects § feMorphology.
            // Renderer maps this to a separable max/min pass against the
            // source FBO. Composing with other primitives in the same
            // filter (e.g. morph + blur) requires the filter graph; this
            // single-kind path handles only standalone <feMorphology>.
            const opAttr = (k.getAttribute('operator') || 'erode').trim().toLowerCase();
            const operator = opAttr === 'dilate' ? 1 : 0;
            const rStr = (k.getAttribute('radius') || '0').trim();
            const rParts = rStr
              .split(/[\s,]+/)
              .map(parseFloat)
              .filter(Number.isFinite);
            const rx = rParts.length >= 1 ? Math.max(0, rParts[0]) : 0;
            const ry = rParts.length >= 2 ? Math.max(0, rParts[1]) : rx;
            filters[id] = {
              region,
              kind: 'morphology',
              radiusX: rx,
              radiusY: ry,
              operator,
            };
            supported = null;
          } else if (
            kt === 'feblend' ||
            kt === 'femerge' ||
            kt === 'feoffset' ||
            kt === 'feturbulence' ||
            kt === 'fedisplacementmap' ||
            kt === 'fetile' ||
            kt === 'fediffuselighting' ||
            kt === 'fespecularlighting' ||
            kt === 'feimage'
          ) {
            // Primitives the single-kind heuristic doesn't reduce to a
            // matrix/sigma — flag `supported = false` so the buildFilterGraph
            // fallback takes over. The graph dispatch handles these in
            // filterGraphSvg.js.
            supported = false;
          }
        }
        // (A linear blur survives only as the whole chain: no matrix, no source-alpha mask, no transfer table beside it.)
        if (
          linBlur &&
          (srcAlphaPrefix || componentTransferLUT || m.some((v, i) => v !== identity()[i]))
        )
          linSensitive = true;
        if (supported && linSensitive) supported = false;
        if (supported && componentTransferLUT) {
          // Detect identity LUT — those can collapse into the matrix
          // path with no behavioral change. Non-identity LUTs fall
          // through to the graph path, where feComponentTransfer is
          // a first-class node (256×4 LUT texture per filter).
          let identityLut = true;
          const sample = (fn) => {
            for (let i = 0; i < 256; i += 32) {
              const x = i / 255;
              if (Math.abs(fn(x) - x) > 1 / 255) return false;
            }
            return true;
          };
          if (
            !sample(componentTransferLUT.fR) ||
            !sample(componentTransferLUT.fG) ||
            !sample(componentTransferLUT.fB) ||
            !sample(componentTransferLUT.fA)
          ) {
            identityLut = false;
          }
          if (!identityLut) supported = false;
        }
        // A leading in="SourceAlpha" becomes the first factor of the color
        // matrix: RGB to zero, alpha through. Zero offset column, so it stays
        // linear and the blur/matrix reorder above remains exact.
        if (supported && srcAlphaPrefix) {
          m = matMul45(m, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
        }
        // supported === null ⇒ a primitive (e.g. feDropShadow) already
        // wrote filters[id] directly; skip the generic record path.
        if (supported !== null) {
          const identityOnly =
            supported && !blurSigmaX && !blurSigmaY && m.every((v, i) => v === identity()[i]);
          // Inline matrices receive covered, opacity-scaled pixels. Only RGB
          // transforms independent of alpha and a non-amplifying alpha scale
          // commute with those factors. Other matrices need SourceGraphic and
          // the graph's post-filter opacity and transparent-region evaluation.
          const alphaCoupled =
            m[3] !== 0 ||
            m[8] !== 0 ||
            m[13] !== 0 ||
            m[15] !== 0 ||
            m[16] !== 0 ||
            m[17] !== 0 ||
            m[19] !== 0 ||
            m[18] < 0 ||
            m[18] > 1;
          const boundedInline =
            !blurSigmaX &&
            !blurSigmaY &&
            (region?.stated ||
              elementChildren(el).some((k) =>
                ['x', 'y', 'width', 'height'].some((a) => k.hasAttribute(a)),
              ));
          const zeroBlur = sawBlur && !blurSigmaX && !blurSigmaY;
          filters[id] =
            supported && !identityOnly && !alphaCoupled && !boundedInline && !zeroBlur
              ? {
                  region,
                  kind: blurSigmaX > 0 || blurSigmaY > 0 ? 'blur' : 'colorMatrix',
                  ...(linBlur && (blurSigmaX > 0 || blurSigmaY > 0) ? { linear: true } : {}),
                  matrix: m,
                  sigmaX: blurSigmaX,
                  sigmaY: blurSigmaY,
                }
              : (function () {
                  const g = buildFilterGraph(el);
                  if (g) return { region, kind: 'graph', graph: g };
                  return { region, kind: 'unsupported' };
                })();
        }
      }
    }
    const ks = elementChildren(el);
    for (let i = 0; i < ks.length; i++) visit(ks[i]);
  };
  visit(root);
  for (const [id, make] of groupGraphs) {
    if (filters[id]) Object.defineProperty(filters[id], '_makeGroupGraph', { value: make });
  }
  return filters;
}

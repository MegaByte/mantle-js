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
// and the graph-builder takes over. Recognised primitives match the
// dispatch tables in filterGraphSvg.js + filterGraphColr.js.

import { elementChildren } from './utils.js';
import { parseColor } from './color.js';
import { parseLength, parseLengthOr } from './length.js';
import { featherDropShadowGraph } from './effectsSynth.js';

/// imageResolver: optional `(href) => { imageId, w, h } | null` callback
/// used to resolve <feImage xlink:href="#imgId"> to an atlas slot at
/// parse time. The href is the raw attribute string (typically "#id").
/// imageId is 1-based into ctx.imagesUsed; w/h are the image's natural
/// pixel dims. When the resolver returns null (no DOM atlas, or the
/// href is external/unsupported), the feImage parse falls back to
/// emitting null → filter marked unsupported → shape renders unfiltered.
export function parseFilters(root, imageResolver) {
  const filters = {};
  // Helpers: build common color matrices.
  const identity = () => [1,0,0,0,0,  0,1,0,0,0,  0,0,1,0,0,  0,0,0,1,0];
  const saturate = (s) => {
    // Standard SVG saturate matrix (luminance weights 0.2126, 0.7152, 0.0722).
    const r = 0.2126, g = 0.7152, b = 0.0722;
    return [
      r + s*(1-r),  g - s*g,      b - s*b,      0, 0,
      r - s*r,      g + s*(1-g),  b - s*b,      0, 0,
      r - s*r,      g - s*g,      b + s*(1-b),  0, 0,
      0, 0, 0, 1, 0,
    ];
  };
  const hueRotate = (deg) => {
    const rad = deg * Math.PI / 180;
    const cs = Math.cos(rad), sn = Math.sin(rad);
    return [
      0.213 + cs*0.787 - sn*0.213,  0.715 - cs*0.715 - sn*0.715,  0.072 - cs*0.072 + sn*0.928,  0, 0,
      0.213 - cs*0.213 + sn*0.143,  0.715 + cs*0.285 + sn*0.140,  0.072 - cs*0.072 - sn*0.283,  0, 0,
      0.213 - cs*0.213 - sn*0.787,  0.715 - cs*0.715 + sn*0.715,  0.072 + cs*0.928 + sn*0.072,  0, 0,
      0, 0, 0, 1, 0,
    ];
  };
  const luminanceToAlpha = () => [
    0,0,0,0,0,
    0,0,0,0,0,
    0,0,0,0,0,
    0.2125, 0.7154, 0.0721, 0, 0,
  ];
  // Multiply two 4×5 color matrices (treating fifth column as offset).
  // Result = A · B applied to [r,g,b,a,1]^T meaning B applied first then A.
  const matMul45 = (A, B) => {
    const out = new Array(20);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 5; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += A[r*5 + k] * B[k*5 + c];
        if (c === 4) s += A[r*5 + 4]; // add A's offset column
        out[r*5 + c] = s;
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
  const SRC = {
    'SourceGraphic':    -1, 'SourceAlpha':      -2,
    'BackgroundImage':  -3, 'BackgroundAlpha':  -4,
    'FillPaint':        -5, 'StrokePaint':      -6,
  };
  function buildFilterGraph(el) {
    const nodes = [];
    const byName = Object.create(null);  // result-name → node index
    let inLast = SRC.SourceGraphic;
    function resolveInput(name) {
      if (!name) return inLast;
      if (name in SRC) return SRC[name];
      if (name in byName) return byName[name];
      return SRC.SourceGraphic;  // forgiving — same default the spec mandates
    }
    const kids = elementChildren(el);
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const kt = (k.tagName || '').toLowerCase();
      let nodeType = null;
      let params = null;
      let inputs = null;
      if (kt === 'fegaussianblur') {
        nodeType = 'feGaussianBlur';
        const sd = (k.getAttribute('stdDeviation') || '0').trim();
        const parts = sd.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
        const sx = parts.length >= 1 ? Math.max(0, parts[0]) : 0;
        const sy = parts.length >= 2 ? Math.max(0, parts[1]) : sx;
        if (sx === 0 && sy === 0) continue;  // identity — skip
        params = { sigmaX: sx, sigmaY: sy };
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'femorphology') {
        nodeType = 'feMorphology';
        const op = (k.getAttribute('operator') || 'erode').trim().toLowerCase();
        const operator = op === 'dilate' ? 1 : 0;
        const r = (k.getAttribute('radius') || '0').trim();
        const parts = r.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
        const rx = parts.length >= 1 ? Math.max(0, parts[0]) : 0;
        const ry = parts.length >= 2 ? Math.max(0, parts[1]) : rx;
        if (rx === 0 && ry === 0) continue;
        params = { operator, radiusX: rx, radiusY: ry };
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'feoffset') {
        nodeType = 'feOffset';
        const dx = parseLengthOr(k.getAttribute('dx') || '0', 0);
        const dy = parseLengthOr(k.getAttribute('dy') || '0', 0);
        if (dx === 0 && dy === 0) continue;
        params = { dx, dy };
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'feflood') {
        nodeType = 'feFlood';
        const colStr = (k.getAttribute('flood-color') || 'black').trim();
        const opStr  = parseFloat(k.getAttribute('flood-opacity') || '1');
        const rgba = parseColor(colStr);
        const a = (Number.isFinite(opStr) ? opStr : 1) * (rgba[3] !== undefined ? rgba[3] : 1);
        params = { rgba: [rgba[0], rgba[1], rgba[2], a] };
        inputs = [];  // feFlood is a source primitive — no inputs
      } else if (kt === 'fecolormatrix') {
        nodeType = 'feColorMatrix';
        const type = (k.getAttribute('type') || 'matrix').trim().toLowerCase();
        const valStr = (k.getAttribute('values') || '').trim();
        const vals = valStr.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
        let mat;
        if (type === 'matrix' && vals.length >= 20) mat = vals.slice(0, 20);
        else if (type === 'saturate')   mat = saturate(vals[0] !== undefined ? vals[0] : 1);
        else if (type === 'huerotate')  mat = hueRotate(vals[0] || 0);
        else if (type === 'luminancetoalpha') mat = luminanceToAlpha();
        else return null;  // unknown type — let kind path bail too
        params = { matrix: mat };
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'fecomposite') {
        nodeType = 'feComposite';
        const opName = (k.getAttribute('operator') || 'over').trim().toLowerCase();
        const opMap = { 'over': 0, 'in': 1, 'out': 2, 'atop': 3, 'xor': 4, 'arithmetic': 5 };
        const op = opName in opMap ? opMap[opName] : 0;
        const k1 = parseLengthOr(k.getAttribute('k1') || '0', 0);
        const k2 = parseLengthOr(k.getAttribute('k2') || '0', 0);
        const k3 = parseLengthOr(k.getAttribute('k3') || '0', 0);
        const k4 = parseLengthOr(k.getAttribute('k4') || '0', 0);
        params = { op, k: [k1, k2, k3, k4] };
        inputs = [
          resolveInput(k.getAttribute('in')),
          resolveInput(k.getAttribute('in2')),
        ];
      } else if (kt === 'fediffuselighting' || kt === 'fespecularlighting') {
        nodeType = (kt === 'fespecularlighting') ? 'feSpecularLighting' : 'feDiffuseLighting';
        const surfaceScale = parseLengthOr(k.getAttribute('surfaceScale') || '1', 1);
        const diffuseConstant  = parseLengthOr(k.getAttribute('diffuseConstant')  || '1', 1);
        const specularConstant = parseLengthOr(k.getAttribute('specularConstant') || '1', 1);
        const specularExponent = parseLengthOr(k.getAttribute('specularExponent') || '1', 1);
        const colorStr = (k.getAttribute('lighting-color') || 'white').trim();
        const lrgba = parseColor(colorStr);
        // Look at first <fe*Light> child for light source params.
        let lightType = 0;             // distant default
        let lightPos = [0, 0, 0];
        let spotAt = [0, 0, 0];
        let spotExp = 1;
        let spotCosCone = 2.0;          // > 1 → no cone
        for (const lc of elementChildren(k)) {
          const lt = (lc.tagName || '').toLowerCase();
          if (lt === 'fedistantlight') {
            lightType = 0;
            const azDeg = parseLengthOr(lc.getAttribute('azimuth')   || '0', 0);
            const elDeg = parseLengthOr(lc.getAttribute('elevation') || '0', 0);
            const az = azDeg * Math.PI / 180;
            const el = elDeg * Math.PI / 180;
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
              spotCosCone = Math.cos(ang * Math.PI / 180);
            }
            break;
          }
        }
        params = {
          surfaceScale, diffuseConstant, specularConstant, specularExponent,
          lightColor: [lrgba[0], lrgba[1], lrgba[2], 1],
          lightType, lightPos, spotAt, spotExp, spotCosCone,
        };
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'fedisplacementmap') {
        nodeType = 'feDisplacementMap';
        const scale = parseLengthOr(k.getAttribute('scale') || '0', 0);
        const chMap = { 'R': 0, 'G': 1, 'B': 2, 'A': 3 };
        const xCh = k.getAttribute('xChannelSelector') || 'A';
        const yCh = k.getAttribute('yChannelSelector') || 'A';
        const xChan = xCh in chMap ? chMap[xCh] : 3;
        const yChan = yCh in chMap ? chMap[yCh] : 3;
        params = { scale, xChan, yChan };
        inputs = [
          resolveInput(k.getAttribute('in')),
          resolveInput(k.getAttribute('in2')),
        ];
      } else if (kt === 'feturbulence') {
        nodeType = 'feTurbulence';
        const bfStr = (k.getAttribute('baseFrequency') || '0').trim();
        const bfParts = bfStr.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
        const bx = bfParts.length >= 1 ? Math.max(0, bfParts[0]) : 0;
        const by = bfParts.length >= 2 ? Math.max(0, bfParts[1]) : bx;
        const oc = Math.max(1, Math.min(6, parseInt(k.getAttribute('numOctaves') || '1', 10) || 1));
        const seed = parseLengthOr(k.getAttribute('seed') || '0', 0);
        const typeStr = (k.getAttribute('type') || 'turbulence').trim().toLowerCase();
        const kind = typeStr === 'fractalnoise' ? 1 : 0;
        const stitchStr = (k.getAttribute('stitchTiles') || 'noStitch').trim().toLowerCase();
        const stitch = stitchStr === 'stitch' ? 1 : 0;
        params = { baseFreqX: bx, baseFreqY: by, numOctaves: oc, seed, kind, stitch };
        inputs = [];  // source primitive — no inputs
      } else if (kt === 'feconvolvematrix') {
        // feConvolveMatrix — 2D NxM kernel convolution (capped at 5×5
        // by the shader). Parser computes divisor / target / edgeMode
        // defaults per the SVG Filter Effects spec. The graph holds
        // the raw kernel; the renderer interns it into bundle.kernelTab
        // (or, here, into a per-eval texture if the graph is the path).
        const orderRaw = (k.getAttribute('order') || '3').trim();
        const orderParts = orderRaw.split(/[\s,]+/).map(s => parseInt(s, 10)).filter(Number.isFinite);
        const orderX = Math.max(1, Math.min(5, orderParts[0] || 3));
        const orderY = Math.max(1, Math.min(5, orderParts.length > 1 ? orderParts[1] : orderX));
        const km = (k.getAttribute('kernelMatrix') || '').trim();
        const kvalsAll = km.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
        const need = orderX * orderY;
        if (kvalsAll.length < need) {
          // Insufficient kernel data — bail.
          nodeType = null;
        } else {
          const kvals = kvalsAll.slice(0, need);
          // Pack into a 25-float buffer (the shader unrolls to 5×5).
          const kernel = new Float32Array(25);
          for (let kk = 0; kk < kvals.length; kk++) kernel[kk] = kvals[kk];
          const divAttr = parseFloat(k.getAttribute('divisor'));
          let divisor;
          if (Number.isFinite(divAttr) && divAttr !== 0) divisor = divAttr;
          else {
            let s = 0; for (const v of kvals) s += v;
            divisor = s !== 0 ? s : 1;
          }
          const bias = parseLengthOr(k.getAttribute('bias') || '0', 0);
          const targetX = Number.isFinite(parseInt(k.getAttribute('targetX'), 10))
            ? parseInt(k.getAttribute('targetX'), 10) : Math.floor(orderX / 2);
          const targetY = Number.isFinite(parseInt(k.getAttribute('targetY'), 10))
            ? parseInt(k.getAttribute('targetY'), 10) : Math.floor(orderY / 2);
          const edgeStr = (k.getAttribute('edgeMode') || 'duplicate').trim().toLowerCase();
          const edgeMode = edgeStr === 'wrap' ? 1 : (edgeStr === 'none' ? 2 : 0);
          const preserveAlpha = (k.getAttribute('preserveAlpha') || 'false').trim().toLowerCase() === 'true' ? 1 : 0;
          nodeType = 'feConvolveMatrix';
          params = {
            orderX, orderY, targetX, targetY,
            divisor, bias, edgeMode, preserveAlpha,
            kernel,  // 25 floats; renderer uploads as needed
          };
          inputs = [resolveInput(k.getAttribute('in'))];
        }
      } else if (kt === 'feimage') {
        // Source primitive: bring an in-document <image> bitmap into the
        // filter graph. Href is "#imgId" pointing at an <image> element
        // whose atlas slot is already claimed. External URLs are not
        // supported here (no async fetch in this code path).
        const href = (k.getAttribute('href') || k.getAttribute('xlink:href') || '').trim();
        if (!imageResolver) { nodeType = null; }
        else {
          const resolved = imageResolver(href);
          if (!resolved) { nodeType = null; }
          else {
            nodeType = 'feImage';
            const par = (k.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim().toLowerCase();
            const preserveAR = par === 'none' ? 0 : 1;
            params = {
              imageId: resolved.imageId,
              imgW: resolved.w, imgH: resolved.h,
              preserveAR,
            };
            inputs = [];  // source primitive
          }
        }
      } else if (kt === 'fetile') {
        nodeType = 'feTile';
        params = {};
        inputs = [resolveInput(k.getAttribute('in'))];
      } else if (kt === 'feblend') {
        nodeType = 'feBlend';
        const modeName = (k.getAttribute('mode') || 'normal').trim().toLowerCase();
        const modeMap = {
          'normal': 0, 'multiply': 1, 'screen': 2, 'overlay': 3,
          'darken': 4, 'lighten': 5, 'color-dodge': 6, 'color-burn': 7,
          'hard-light': 8, 'soft-light': 9, 'difference': 10, 'exclusion': 11,
          'hue': 12, 'saturation': 13, 'color': 14, 'luminosity': 15,
        };
        const mode = modeName in modeMap ? modeMap[modeName] : 0;
        params = { mode };
        inputs = [
          resolveInput(k.getAttribute('in')),
          resolveInput(k.getAttribute('in2')),
        ];
      } else if (kt === 'femerge') {
        nodeType = 'feMerge';
        // mergeNode children carry per-input `in` attrs.
        const mergeKids = elementChildren(k);
        const ins = [];
        for (const mk of mergeKids) {
          if ((mk.tagName || '').toLowerCase() !== 'femergenode') continue;
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
          const fn = elementChildren(k).find(c => (c.tagName || '').toLowerCase() === chanTag);
          if (!fn) return (x) => x;
          const type = (fn.getAttribute('type') || 'identity').toLowerCase();
          const valStr = fn.getAttribute('tableValues') || '';
          const slope = parseLengthOr(fn.getAttribute('slope') || '1', 1);
          const intercept = parseLengthOr(fn.getAttribute('intercept') || '0', 0);
          const amplitude = parseLengthOr(fn.getAttribute('amplitude') || '1', 1);
          const exponent = parseLengthOr(fn.getAttribute('exponent') || '1', 1);
          const offset = parseLengthOr(fn.getAttribute('offset') || '0', 0);
          const tableVals = valStr.trim().split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
          return (x) => {
            if (type === 'linear')   return slope * x + intercept;
            if (type === 'gamma')    return amplitude * Math.pow(x, exponent) + offset;
            if (type === 'table' && tableVals.length >= 2) {
              const n = tableVals.length - 1;
              const t = Math.max(0, Math.min(1, x)) * n;
              const i = Math.floor(t);
              const f = t - i;
              if (i >= n) return tableVals[n];
              return tableVals[i] * (1 - f) + tableVals[i + 1] * f;
            }
            if (type === 'discrete' && tableVals.length >= 1) {
              const idx = Math.min(tableVals.length - 1,
                                   Math.floor(Math.max(0, Math.min(1, x)) * tableVals.length));
              return tableVals[idx];
            }
            return x;
          };
        };
        const fns = [fnFor('fefuncr'), fnFor('fefuncg'), fnFor('fefuncb'), fnFor('fefunca')];
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
            lut[(row * 256 + i) * 4 + 0] = Math.round(y * 255);
          }
        }
        params = { lutBytes: lut };
        inputs = [resolveInput(k.getAttribute('in'))];
      } else {
        // Unsupported in the graph dispatch. Bail; the kind heuristic
        // owns this filter (or marks it unsupported entirely).
        return null;
      }
      const idx = nodes.length;
      nodes.push({ type: nodeType, inputs, params });
      const result = k.getAttribute('result');
      if (result) byName[result] = idx;
      inLast = idx;
    }
    if (!nodes.length) return null;
    return { nodes, rootOut: nodes.length - 1 };
  }

  const visit = (el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'filter') {
      const id = el.getAttribute('id');
      if (id) {
        let m = identity();
        let supported = true;
        let componentTransferLUT = null;
        // Gaussian blur is captured separately and runs before the color
        // matrix at render time. SVG allows arbitrary primitive ordering;
        // the common case is a single feGaussianBlur (optionally followed
        // by an feColorMatrix), which we handle. A blur then a color
        // matrix is fine. A color matrix then a blur gets reordered to
        // blur-then-matrix — exactly equivalent only when the matrix is
        // LINEAR, but type="matrix" carries a 5th offset column (affine,
        // not linear), so a nonzero offset makes the reorder an
        // approximation (the offset would be blurred into the transparent
        // surround rather than applied after the blur).
        let blurSigmaX = 0, blurSigmaY = 0;
        const kids = elementChildren(el);
        // The single-kind shorthands (feDropShadow / feConvolveMatrix /
        // feMorphology) may only claim filters[id] when they are the SOLE
        // primitive — writing it mid-loop silently discards every sibling
        // primitive. With siblings, route the whole chain to the graph
        // builder instead.
        let feCount = 0;
        for (const k9 of kids) {
          if (((k9.tagName || '').toLowerCase()).startsWith('fe')) feCount++;
        }
        for (let i = 0; i < kids.length; i++) {
          const k = kids[i];
          const kt = (k.tagName || '').toLowerCase();
          if (kt === 'fecolormatrix') {
            const type = (k.getAttribute('type') || 'matrix').trim().toLowerCase();
            const valStr = (k.getAttribute('values') || '').trim();
            const vals = valStr.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
            if (type === 'matrix' && vals.length >= 20) {
              m = matMul45(vals.slice(0, 20), m);
            } else if (type === 'saturate') {
              m = matMul45(saturate(vals[0] !== undefined ? vals[0] : 1), m);
            } else if (type === 'huerotate') {
              m = matMul45(hueRotate(vals[0] || 0), m);
            } else if (type === 'luminancetoalpha') {
              m = matMul45(luminanceToAlpha(), m);
            } else {
              supported = false;
            }
          } else if (kt === 'fecomponenttransfer') {
            // 4 per-channel 1D transfer functions. Bake into a 256×4
            // float LUT and compose with the running matrix. Each channel
            // is sampled independently from its own row of the LUT.
            const fnFor = (chanTag, defaultIdent) => {
              const fn = elementChildren(k).find(c => (c.tagName || '').toLowerCase() === chanTag);
              if (!fn) return defaultIdent;
              const type = (fn.getAttribute('type') || 'identity').toLowerCase();
              const valStr = fn.getAttribute('tableValues') || '';
              const slope = parseLengthOr(fn.getAttribute('slope') || '1', 1);
              const intercept = parseLengthOr(fn.getAttribute('intercept') || '0', 0);
              const amplitude = parseLengthOr(fn.getAttribute('amplitude') || '1', 1);
              const exponent = parseLengthOr(fn.getAttribute('exponent') || '1', 1);
              const offset = parseLengthOr(fn.getAttribute('offset') || '0', 0);
              const tableVals = valStr.trim().split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
              return (x) => {
                if (type === 'identity') return x;
                if (type === 'linear')   return slope * x + intercept;
                if (type === 'gamma')    return amplitude * Math.pow(x, exponent) + offset;
                if (type === 'table' && tableVals.length >= 2) {
                  const n = tableVals.length - 1;
                  const t = Math.max(0, Math.min(1, x)) * n;
                  const i = Math.floor(t);
                  const f = t - i;
                  if (i >= n) return tableVals[n];
                  return tableVals[i] * (1 - f) + tableVals[i + 1] * f;
                }
                if (type === 'discrete' && tableVals.length >= 1) {
                  const idx = Math.min(tableVals.length - 1,
                                       Math.floor(Math.max(0, Math.min(1, x)) * tableVals.length));
                  return tableVals[idx];
                }
                return x;
              };
            };
            const fR = fnFor('fefuncr', x => x);
            const fG = fnFor('fefuncg', x => x);
            const fB = fnFor('fefuncb', x => x);
            const fA = fnFor('fefunca', x => x);
            // Capture per-filter LUT data; matrix already accumulated.
            componentTransferLUT = { fR, fG, fB, fA };
          } else if (kt === 'feflood' || kt === 'fecomposite') {
            // Recognize the very common "tint" idiom that bakes to a
            // color matrix (no FBO needed):
            //
            //   <feFlood flood-color="C" flood-opacity="A" result="r1"/>
            //   <feComposite in="r1" in2="SourceGraphic" operator="in" result="r2"/>
            //
            // (or in/in2 swapped). The result's RGB is the flood color
            // and its alpha is min(flood.a, src.a) ≈ flood.a · src.a for
            // typical source coverage. We bake this into a 4×5 matrix.
            //
            // The chain detection looks back at the already-parsed
            // siblings; if we see an feComposite-in whose two inputs are
            // SourceGraphic + an feFlood result (and only those two
            // primitives in the filter so far besides identity matrices),
            // compose a recolor matrix and treat the chain as supported.
            if (kt === 'feflood') {
              // Defer; feFlood alone with no consumer doesn't visibly
              // change anything reachable from SourceGraphic. We'll pick
              // it up when feComposite is processed.
              continue;
            }
            // feComposite: only handle operator="in" with one Flood input.
            const op = (k.getAttribute('operator') || 'over').toLowerCase();
            const in1 = (k.getAttribute('in')  || '').trim();
            const in2 = (k.getAttribute('in2') || '').trim();
            if (op !== 'in') { supported = false; continue; }
            // Find the matching feFlood among earlier siblings.
            const findFlood = (refName) => {
              if (!refName || refName === 'SourceGraphic' ||
                  refName === 'SourceAlpha' || refName === 'BackgroundImage' ||
                  refName === 'BackgroundAlpha') return null;
              for (let j = 0; j < i; j++) {
                const p = kids[j];
                if ((p.tagName || '').toLowerCase() !== 'feflood') continue;
                if ((p.getAttribute('result') || '') === refName) return p;
              }
              return null;
            };
            const isSrc = s => s === 'SourceGraphic' || s === 'SourceAlpha';
            let flood = null;
            if (isSrc(in1) || in1 === '') flood = findFlood(in2);
            else if (isSrc(in2) || in2 === '') flood = findFlood(in1);
            else { flood = findFlood(in1) || findFlood(in2); }
            if (!flood) { supported = false; continue; }
            const color = (flood.getAttribute('flood-color') || 'black').trim();
            const op2  = parseFloat(flood.getAttribute('flood-opacity') || '1');
            const rgba = parseColor(color);
            const A = (Number.isFinite(op2) ? op2 : 1) * (rgba[3] !== undefined ? rgba[3] : 1);
            const Cr = rgba[0], Cg = rgba[1], Cb = rgba[2];
            // Output = (Cr * src.a, Cg * src.a, Cb * src.a, A * src.a).
            const tint = [
              0, 0, 0, Cr, 0,
              0, 0, 0, Cg, 0,
              0, 0, 0, Cb, 0,
              0, 0, 0, A,  0,
            ];
            m = matMul45(tint, m);
          } else if (kt === 'fegaussianblur') {
            // stdDeviation: one or two numbers. Single value applies to
            // both axes; two values give X then Y. Negative values are
            // an error per spec; treat as zero.
            const sd = (k.getAttribute('stdDeviation') || '').trim();
            const parts = sd.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
            const sx = parts.length >= 1 ? Math.max(0, parts[0]) : 0;
            const sy = parts.length >= 2 ? Math.max(0, parts[1]) : sx;
            // Blurs compose by Pythagorean sum of sigmas (since the
            // convolution of two Gaussians is a Gaussian with sigma
            // sqrt(σ₁² + σ₂²)).
            blurSigmaX = Math.sqrt(blurSigmaX * blurSigmaX + sx * sx);
            blurSigmaY = Math.sqrt(blurSigmaY * blurSigmaY + sy * sy);
          } else if (kt === 'fedropshadow') {
            if (feCount > 1) { supported = false; continue; }  // chain → graph builder
            // SVG 1.2 <feDropShadow> is shorthand for the graph:
            //   feGaussianBlur(SourceAlpha, stdDeviation) →
            //   feOffset(dx, dy) → feFlood(flood-color/opacity) →
            //   feComposite(operator=in) → feMerge(shadow, SourceGraphic)
            // We emit exactly that graph.
            const sd = (k.getAttribute('stdDeviation') || '0').trim();
            const sdParts = sd.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
            const dsx = sdParts.length >= 1 ? Math.max(0, sdParts[0]) : 0;
            const dsy = sdParts.length >= 2 ? Math.max(0, sdParts[1]) : dsx;
            const dx = parseFloat(k.getAttribute('dx') || '2');
            const dy = parseFloat(k.getAttribute('dy') || '2');
            const colStr = (k.getAttribute('flood-color') || 'black').trim();
            const opStr  = parseFloat(k.getAttribute('flood-opacity') || '1');
            const rgba   = parseColor(colStr);
            const aMul   = (Number.isFinite(opStr) ? opStr : 1)
                         * (rgba[3] !== undefined ? rgba[3] : 1);
            filters[id] = {
              kind: 'graph',
              graph: featherDropShadowGraph(dsx, dsy, dx, dy,
                       [rgba[0], rgba[1], rgba[2], aMul]),
            };
            supported = null;  // Already wrote filters[id]; skip the
                               //  generic colorMatrix/blur record below.
          } else if (kt === 'feconvolvematrix') {
            if (feCount > 1) { supported = false; continue; }  // chain → graph builder
            // feConvolveMatrix — general N×M convolution kernel.
            // Production-class kernels are typically 3×3 (emboss,
            // sharpen, edge); the renderer caps support at 5×5 so the
            // shader can unroll cleanly. Beyond 5×5 falls through as
            // unsupported (filter pass-through).
            const orderStr = (k.getAttribute('order') || '3').trim();
            const orderParts = orderStr.split(/[\s,]+/).map(parseFloat)
                                .filter(Number.isFinite);
            const orderX = Math.max(1, Math.min(5, Math.floor(orderParts[0] || 3)));
            const orderY = Math.max(1, Math.min(5,
                              Math.floor(orderParts.length >= 2 ? orderParts[1] : orderX)));
            const kernelStr = (k.getAttribute('kernelMatrix') || '').trim();
            const kernel = kernelStr.split(/[\s,]+/).map(parseFloat)
                             .filter(Number.isFinite);
            // Spec: kernel.length must equal orderX*orderY; missing
            // entries default to 0. Pad to a fixed 25-float slot so the
            // shader can index unconditionally.
            const needed = orderX * orderY;
            while (kernel.length < needed) kernel.push(0);
            while (kernel.length < 25) kernel.push(0);
            // divisor defaults to the sum of kernel values (or 1 if 0).
            const sum = kernel.slice(0, needed).reduce((s, v) => s + v, 0);
            const divisorAttr = parseFloat(k.getAttribute('divisor'));
            const divisor = Number.isFinite(divisorAttr) && divisorAttr !== 0
              ? divisorAttr
              : (sum !== 0 ? sum : 1);
            const bias = parseLengthOr(k.getAttribute('bias'), 0);
            const targetX = Number.isFinite(parseFloat(k.getAttribute('targetX')))
              ? parseInt(k.getAttribute('targetX'), 10)
              : Math.floor(orderX / 2);
            const targetY = Number.isFinite(parseFloat(k.getAttribute('targetY')))
              ? parseInt(k.getAttribute('targetY'), 10)
              : Math.floor(orderY / 2);
            const edgeStr = (k.getAttribute('edgeMode') || 'duplicate')
                              .trim().toLowerCase();
            const edgeMode = edgeStr === 'wrap' ? 1 : (edgeStr === 'none' ? 2 : 0);
            const preserveAlpha = (k.getAttribute('preserveAlpha') || 'false')
                                    .trim().toLowerCase() === 'true' ? 1 : 0;
            filters[id] = {
              kind: 'convolve',
              orderX, orderY,
              targetX, targetY,
              divisor, bias,
              edgeMode, preserveAlpha,
              kernel,  // 25 floats
            };
            supported = null;
          } else if (kt === 'femorphology') {
            if (feCount > 1) { supported = false; continue; }  // chain → graph builder
            // feMorphology: per-pixel max (dilate) or min (erode) over a
            // rectangular neighborhood of radius (rx, ry) in user space.
            // Spec: SVG Filter Effects § feMorphology.
            // Renderer maps this to a separable max/min pass against the
            // source FBO. Composing with other primitives in the same
            // filter (e.g. morph + blur) requires the filter graph; this
            // single-kind path handles only standalone <feMorphology>.
            const opAttr = (k.getAttribute('operator') || 'erode')
                            .trim().toLowerCase();
            const operator = opAttr === 'dilate' ? 1 : 0;
            const rStr = (k.getAttribute('radius') || '0').trim();
            const rParts = rStr.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
            const rx = rParts.length >= 1 ? Math.max(0, rParts[0]) : 0;
            const ry = rParts.length >= 2 ? Math.max(0, rParts[1]) : rx;
            filters[id] = {
              kind: 'morphology',
              radiusX: rx, radiusY: ry,
              operator,
            };
            supported = null;
          } else if (kt === 'feblend' || kt === 'femerge' || kt === 'feoffset' ||
                     kt === 'feturbulence' || kt === 'fedisplacementmap' || kt === 'fetile' ||
                     kt === 'fediffuselighting' || kt === 'fespecularlighting' ||
                     kt === 'feimage') {
            // Primitives the single-kind heuristic doesn't reduce to a
            // matrix/sigma — flag `supported = false` so the buildFilterGraph
            // fallback takes over. The graph dispatch handles these in
            // filterGraphSvg.js.
            supported = false;
          }
        }
        if (supported && componentTransferLUT) {
          // Detect identity LUT — those can collapse into the matrix
          // path with no behavioral change. Non-identity LUTs fall
          // through to the graph path, where feComponentTransfer is
          // now a first-class node (256×4 LUT texture per filter).
          let identityLut = true;
          const sample = (fn) => {
            for (let i = 0; i < 256; i += 32) {
              const x = i / 255;
              if (Math.abs(fn(x) - x) > 1/255) return false;
            }
            return true;
          };
          if (!sample(componentTransferLUT.fR) ||
              !sample(componentTransferLUT.fG) ||
              !sample(componentTransferLUT.fB) ||
              !sample(componentTransferLUT.fA)) {
            identityLut = false;
          }
          if (!identityLut) supported = false;
        }
        // supported === null ⇒ a primitive (e.g. feDropShadow) already
        // wrote filters[id] directly; skip the generic record path.
        if (supported !== null) {
          filters[id] = supported
            ? {
                kind: (blurSigmaX > 0 || blurSigmaY > 0) ? 'blur' : 'colorMatrix',
                matrix: m,
                sigmaX: blurSigmaX,
                sigmaY: blurSigmaY,
              }
            : (function () {
                // Single-kind heuristic gave up. Try the graph builder:
                // if it can express the chain via the dispatch handlers
                // we've registered (filterGraphSvg.js), emit a graph
                // record instead of marking the filter unsupported.
                const g = buildFilterGraph(el);
                if (g) return { kind: 'graph', graph: g };
                return { kind: 'unsupported' };
              })();
        }
      }
    }
    const ks = elementChildren(el);
    for (let i = 0; i < ks.length; i++) visit(ks[i]);
  };
  visit(root);
  return filters;
}


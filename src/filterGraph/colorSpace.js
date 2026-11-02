// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterGraph/colorSpace.js -- color-interpolation-filters (Filter Effects 1 §15.8) for the filter graph.
//
// Every node carries the space it OPERATES in as params.cs: 1 = linearRGB, absent or 0 = sRGB. The importer writes it only on
// the primitives that read or produce color (a graph with no cs anywhere -- every CSS filter function, COLR paint graph, Rive
// shadow or sRGB-only filter -- is analyzed to "no conversions" and evaluates entirely in sRGB).
//
// An RT holds premultiplied RGBA in the space its node produced it in (its TAG). A primitive reads each input in the space the
// input is tagged with and converts it, inside its own shader, when that is not the space the primitive operates in; the
// graph's result is tagged and the composite converts it to sRGB. So a chain of linearRGB primitives converts once on the way
// in and once on the way out, and a graph of sRGB primitives converts never.
//
//   SourceGraphic, BackgroundImage, FillPaint, StrokePaint are sRGB.
//   SourceAlpha, BackgroundAlpha, and any result made only of them by a primitive that adds no color, are COLORLESS (tag -1): their
//   RGB is zero, which both transfer functions keep at zero, so no consumer converts them.
//   feOffset and feTile move pixels and keep the tag of their input (a conversion around them would only cost quantization).
//   feImage draws sRGB bitmap data and is tagged sRGB whatever the primitive says.
//   feFlood draws a constant: it is tagged sRGB whatever the primitive says (its color is stored as authored, and a linearRGB consumer converts
//   it where it reads it), so a flood that is the result needs no conversion and no precision is lost to an 8-bit linear target.
//   feColorMatrix converts its result back to sRGB as it writes it (Chrome fuses a color matrix with the conversions around it the same way):
//   a chain of color matrices keeps the exactness of the 8-bit sRGB targets. Every other primitive's linearRGB result is held in a LINEAR-LIGHT
//   target: SRGB8_ALPHA8 (filterGraph.js createRTPool setLinear), which the hardware encodes on write and decodes on sample, so the shaders see
//   linear values while sRGB-encoded storage preserves precision in dark colors.
//   feDisplacementMap converts only its displacement map (Filter Effects 1: the property "only applies to the in2 source image");
//   its result is the displaced in (tagged as in is).

// (The sentinel numbers are filterGraph.js's SRC_*; they are repeated here because filterGraph.js imports this module.)
const SRC_GRAPHIC = -1,
  SRC_ALPHA = -2,
  SRC_BACKGROUND = -3,
  SRC_BACKGROUND_A = -4,
  SRC_FILL_PAINT = -5,
  SRC_STROKE_PAINT = -6;

export const CS_COLORLESS = -1;
export const CS_SRGB = 0;
export const CS_LINEAR = 1;

/// The shader's conversion mode (csConvert in _filterRect.glsl) taking color tagged `from` to the space `to`: 0 none, 1 sRGB -> linear, 2 linear -> sRGB.
export function convMode(from, to) {
  if (from < 0 || to < 0 || from === to) return 0;
  return to === CS_LINEAR ? 1 : 2;
}

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

const INHERIT = new Set(['feOffset', 'feTile']);
// Primitives that add no color to colorless inputs. A composite is colorless-closed except `arithmetic` (k4 and the products add color).
const KEEPS_COLORLESS = new Set([
  'feGaussianBlur',
  'feMorphology',
  'feOffset',
  'feTile',
  'feMerge',
  'feComposite',
]);
const SOURCE_TAG = {
  [SRC_GRAPHIC]: CS_SRGB,
  [SRC_BACKGROUND]: CS_SRGB,
  [SRC_FILL_PAINT]: CS_SRGB,
  [SRC_STROKE_PAINT]: CS_SRGB,
  [SRC_ALPHA]: CS_COLORLESS,
  [SRC_BACKGROUND_A]: CS_COLORLESS,
};

const _cache = new WeakMap();
const NONE = Object.freeze({ any: false, op: null, out: null, ins: null, per: null, root: 0 });

/// Per-node spaces of a graph: { any, op[i] (the space node i operates in), out[i] (its result's tag), ins[i][k] (the tag of its input k), root (the
/// tag of the result) }. `any` is false for a graph that names no linearRGB node: nothing to convert, nothing to track. Cached per graph object.
export function analyzeSpaces(graph) {
  if (!graph || !graph.nodes) return NONE;
  let a = _cache.get(graph);
  if (a) return a;
  const nodes = graph.nodes,
    n = nodes.length;
  let any = false;
  for (let i = 0; i < n; i++)
    if (nodes[i].params && nodes[i].params.cs) {
      any = true;
      break;
    }
  if (!any) {
    _cache.set(graph, NONE);
    return NONE;
  }
  const op = new Int8Array(n),
    out = new Int8Array(n),
    ins = new Array(n);
  for (let i = 0; i < n; i++) {
    const node = nodes[i],
      p = node.params || {};
    const tags = node.inputs.map((j) => (j >= 0 && j < i ? out[j] : (SOURCE_TAG[j] ?? CS_SRGB)));
    ins[i] = tags;
    const pref = p.cs ? CS_LINEAR : CS_SRGB;
    const colorless =
      tags.length > 0 &&
      tags.every((t) => t === CS_COLORLESS) &&
      KEEPS_COLORLESS.has(node.type) &&
      !(node.type === 'feComposite' && (p.op | 0) === 5);
    if (INHERIT.has(node.type)) {
      op[i] = out[i] = tags.length ? tags[0] : pref;
    } else if (node.type === 'feImage' || node.type === 'feFlood') {
      op[i] = pref;
      out[i] = CS_SRGB;
    } else if (node.type === 'feColorMatrix') {
      // Its result is sRGB (converted on write); with only colorless inputs and no alpha column or offset into the color rows it makes no color at all.
      op[i] = pref;
      const m = p.matrix;
      const makesColor = !m || [3, 4, 8, 9, 13, 14].some((q) => m[q] !== 0);
      out[i] =
        tags.length > 0 && tags.every((t) => t === CS_COLORLESS) && !makesColor
          ? CS_COLORLESS
          : CS_SRGB;
    } else if (node.type === 'feDisplacementMap') {
      op[i] = pref;
      out[i] = tags[0];
    } else {
      op[i] = pref;
      out[i] = colorless ? CS_COLORLESS : pref;
    }
  }
  // A color matrix hands its result on as sRGB (converted as it writes) -- the exactness of Chrome's fused color filters -- unless every reader of it
  // works in linear light and is not itself a color matrix or a mover (feOffset / feTile pass the tag on): then it stays linear and the
  // readers convert nothing. The result of the graph is always sRGB.
  const r = graph.rootOut;
  const readers = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++)
    for (const j of nodes[i].inputs) if (j >= 0 && j < n) readers[j].push(i);
  for (let i = 0; i < n; i++) {
    if (
      nodes[i].type !== 'feColorMatrix' ||
      out[i] !== CS_SRGB ||
      op[i] !== CS_LINEAR ||
      i === r ||
      !readers[i].length
    )
      continue;
    if (
      readers[i].every(
        (j) =>
          op[j] === CS_LINEAR &&
          nodes[j].type !== 'feColorMatrix' &&
          nodes[j].type !== 'feDisplacementMap' &&
          !INHERIT.has(nodes[j].type),
      )
    ) {
      out[i] = CS_LINEAR;
      // (the readers were analyzed with this node sRGB; their input tags and conversions follow the new tag)
      for (const j of readers[i])
        ins[j] = ins[j].map((t, k) => (nodes[j].inputs[k] === i ? CS_LINEAR : t));
    }
  }
  const per = Array.from({ length: n }, (_, i) => ({ op: op[i], out: out[i], ins: ins[i] }));
  a = { any: true, op, out, ins, per, root: r >= 0 && r < n && out[r] > 0 ? CS_LINEAR : CS_SRGB };
  _cache.set(graph, a);
  return a;
}

/// The conversion a node applies to its own result as it writes it: only feColorMatrix does (linear in, sRGB out).
export function outMode(ctx) {
  const cs = ctx._cs;
  if (!cs || cs.out < 0) return 0;
  return convMode(cs.op, cs.out);
}
/// What a handler asks: the conversion mode input `k` of the node being evaluated needs (0 when the graph tracks no spaces).
export function inMode(ctx, k) {
  const cs = ctx._cs;
  if (!cs) return 0;
  return convMode(cs.ins[k] === undefined ? CS_SRGB : cs.ins[k], cs.op);
}
/// The space the node being evaluated operates in (0 sRGB, 1 linear).
export function opSpace(ctx) {
  return ctx._cs ? ctx._cs.op : CS_SRGB;
}

/// How many color-space conversions evaluating `graph` costs: one per input a primitive reads in another space than the one it operates in
/// (the displacement map included, the displaced image excluded), plus one for a result tagged linearRGB (the composite converts it to
/// sRGB). A graph with no linearRGB node costs none.
export function countConversions(graph) {
  const a = analyzeSpaces(graph);
  if (!a.any) return 0;
  let n = a.root === CS_LINEAR ? 1 : 0;
  for (let i = 0; i < graph.nodes.length; i++) {
    const t = graph.nodes[i].type;
    for (let k = 0; k < a.ins[i].length; k++) {
      if (t === 'feDisplacementMap' && k === 0) continue;
      if (INHERIT.has(t)) continue;
      if (convMode(a.ins[i][k], a.op[i]) !== 0) n++;
    }
    if (t === 'feColorMatrix' && convMode(a.op[i], a.out[i]) !== 0) n++; // a color matrix writes sRGB
  }
  return n;
}

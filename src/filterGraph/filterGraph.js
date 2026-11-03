// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { deleteGlResource, trackGlResource } from '../renderer/contextResources.js';
// Generic node-DAG evaluator, used by the SVG <filter> pipeline and the
// COLRv1 paint dispatch. The schema is a superset of OpenType's COLRv1
// PaintComposite tree so one walker renders both filter graphs and
// color-font glyph trees.
//
// Schema:
//   graph = {
//     nodes:   [ { type: string, inputs: int[], params: object | null }, ... ],
//     rootOut: int,   // index of the node whose output is the final result
//   }
// Node references:
//   - Special sentinels in the inputs array:
//       -1 = SourceGraphic    (coverage-rendered shape, premultiplied RGBA)
//       -2 = SourceAlpha      (same shape, RGB cleared, A copied)
//       -3 = BackgroundImage  (snapshot of the main FB under the shape)
//       -4 = BackgroundAlpha  (BackgroundImage with RGB cleared)
//       -5 = FillPaint        (the shape's fill paint as a solid)
//       -6 = StrokePaint      (the shape's stroke paint as a solid)
//     SVG filter spec names; COLRv1 doesn't use sentinels (its trees are
//     self-contained from PaintGlyph leaves).
//   - Any other value n >= 0: index of another node in the same graph.
//
// Node types (filter side):
//   'feGaussianBlur'   params: { sigmaX, sigmaY }
//   'feColorMatrix'    params: { matrix: [20 floats row-major 4x5] }
//   'feMorphology'     params: { operator: 0|1, radiusX, radiusY }
//   'feConvolveMatrix' params: { orderX, orderY, targetX, targetY,
//                                divisor, bias, edgeMode, preserveAlpha,
//                                kernel: [25 floats] }
//   'feOffset'         params: { dx, dy }
//   'feFlood'          params: { rgba: [4 floats premultiplied] }
//   'feComposite'      params: { op: 0..5 (over|in|out|atop|xor|arithmetic),
//                                k1,k2,k3,k4 (for arithmetic) }
//   'feBlend'          params: { mode: int (CSS blend mode 0..15) }
//   'feMerge'          inputs is the merge list (all alpha-composited
//                      in order); no params.
//   'feTile'           params: null (samples input as periodic wrap)
//   'feTurbulence'     params: { baseFreqX, baseFreqY, octaves, seed,
//                                kind: 0=turbulence|1=fractalNoise,
//                                stitchTiles, tileSize: [w,h] }
//   'feDisplacementMap' inputs[0]=source, inputs[1]=displacement-map
//                       params: { scale, xChan: 0..3, yChan: 0..3 }
//   'feSpecularLighting' / 'feDiffuseLighting' inputs[0]=bumpAlpha
//                       params: { surfaceScale, ka|ks, specularExponent,
//                                 lights: [{type, ...}] }
//
// COLRv1 node types (paint side):
//   'PaintGlyph', 'PaintColrGlyph', 'PaintSolid',
//   'PaintLinearGradient', 'PaintRadialGradient', 'PaintSweepGradient',
//   'PaintTransform', 'PaintTranslate', 'PaintScale', 'PaintRotate', 'PaintSkew',
//   'PaintComposite' (28 modes — superset of feBlend + feComposite operators)

// The pool keeps RTs allocated lazily and reuses them across draws of
// the same canvas size; the canvas-size invalidator is the same as
// shapeFbo's.

import { colrTraceSink, mantleDebugHook } from '../core/diagnostics.js';
import { noteExternalGlWrite } from '../core/glEpoch.js';
import { analyzeSpaces, CS_LINEAR, CS_SRGB } from './colorSpace.js';
import { warnUnregisteredNode } from './dispatchRegistry.js';

import {
  SRC_GRAPHIC,
  SRC_ALPHA,
  SRC_BACKGROUND,
  SRC_BACKGROUND_A,
  SRC_FILL_PAINT,
  SRC_STROKE_PAINT,
} from './sourceTags.js';
export {
  SRC_GRAPHIC,
  SRC_ALPHA,
  SRC_BACKGROUND,
  SRC_BACKGROUND_A,
  SRC_FILL_PAINT,
  SRC_STROKE_PAINT,
};

/// Construct an RT pool against a GL context. Each RT is a single-FBO
/// RGBA8 attachment of an arbitrary (w, h). pool.acquire(w, h) returns
/// a handle; pool.release(handle) returns it for reuse at the same
/// size. pool.invalidate() drops everything (call on canvas resize so
/// the pool's RTs don't outlive the GL viewport).
///
/// Free RTs are bucketed by exact size, so callers are expected to hand in sizes
/// already rounded to a grid (renderer._filterNodeRects quantizes each node's
/// RECT to 32px before asking for it). Bucket key fits in 32 bits (w|h<<16),
/// supporting canvases up to 65535 × 65535.
///
/// `pool.ensureSize(w, h)` is a no-op kept for API stability; the bucketed
/// pool needs no global current size.
// Allocation is exact because filter shaders address inputs through canvas-space
// rects and require one texture pixel per canvas pixel. Callers quantize the rect
// before acquisition when they want size-bucket reuse.
const POOL_QUANT = 1;
function quantize(v) {
  return Math.max(POOL_QUANT, Math.ceil(v / POOL_QUANT) * POOL_QUANT);
}
function sizeKey(w, h, lin) {
  return ((w & 0xffff) | ((h & 0xffff) << 16)) + (lin ? 0x100000000 : 0);
}

// A TARGET LARGER THAN ITS PIXELS. The renderer may hand a node a rect on the allocation quantum with `rect.keep` = the part of it the node really covers (same origin): the size follows the grid and
// the pool reuses it, while what is drawn stays exactly in `keep`. Every pass into such a target is scissored to `keep`, so the fragments, and what a later pass of the same node reads, are those of a
// target of `keep`'s size; the rest stays as the clear on acquire left it, and reads 0. The scratch of a multi-pass primitive carries the same rect.
let keepScissorOn = false;
/** Scissor the passes into `rt` to its rect's `keep`, or stop scissoring if it has none. @param {any} gl @param {any} rt */
export function applyKeepScissor(gl, rt) {
  const r = rt.rect,
    k = r && r.keep;
  if (k && rt.size[0] === r[2] && rt.size[1] === r[3]) {
    // (a warm's clamped target keeps the warm's own scissor)
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(k[0] - r[0], k[1] - r[1], k[2], k[3]);
    keepScissorOn = true;
  } else endKeepScissor(gl);
}
/** @param {any} gl */
export function endKeepScissor(gl) {
  if (keepScissorOn) {
    gl.disable(gl.SCISSOR_TEST);
    keepScissorOn = false;
  }
}

/** @param {any} gl @param {Record<string, any>} [opts] */
export function createRTPool(gl, opts) {
  // Attachment format defaults to RGBA8 (the filter/COLR pool). A coverage-only
  // pool can pass { internalFormat: gl.R8, format: gl.RED } for a 4× memory cut —
  // valid because coverage RTs are written/sampled as a single channel (.r).
  opts = opts || {};
  const internalFormat = opts.internalFormat || gl.RGBA8;
  const texFormat = opts.format || gl.RGBA;
  const texType = opts.type || gl.UNSIGNED_BYTE;
  const all = []; // [{ fbo, tex, size: [w,h], used }] (a freed slot is null, and the next new target takes it)
  const holes = []; // the freed slots of `all`
  let liveBytes = 0; // what `all` holds
  const now = () =>
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  let lastAcquireT = 0;
  const bytesPerPx = internalFormat === gl.R8 ? 1 : 4;
  const free = new Map(); // sizeKey → indices into `all`
  // Linear-light targets use SRGB8_ALPHA8: hardware encodes writes and decodes samples,
  // preserving shader-visible linear values with finer dark-color precision than raw linear RGBA8.
  // Both color formats use four bytes per pixel. Other pool formats ignore setLinear.
  const canLin = internalFormat === gl.RGBA8 && !!gl.SRGB8_ALPHA8;
  let linear = false;
  /// The format of the targets acquire() hands out from now on: true = linear light (SRGB8_ALPHA8). Returns the previous setting.
  function setLinear(v) {
    const previous = linear;
    linear = !!v && canLin;
    return previous;
  }
  // When true, acquire() returns a fully transparent RT (clearing any recycled
  // content). evaluateGraph turns it on whenever it is allocating per-node rects,
  // so every acquired RT — node outputs AND handler intermediates (blur tmp / box
  // ping-pong / merge accumulator) — is stale-free. A handler that doesn't write
  // its whole rect (feOffset blits a translated crop; passthrough copies only the
  // overlap with its input) then leaves transparent black, which is what a
  // primitive is outside its subregion. Off by default → the canvas-sized COLR
  // path pays nothing.
  let clearOnAcquire = false;
  function setClearOnAcquire(v) {
    const previous = clearOnAcquire;
    clearOnAcquire = !!v;
    return previous;
  }
  function ensureSize(_w, _h) {
    // No-op. Bucketed pool doesn't need a global current size.
    void _w;
    void _h;
  }
  function invalidate() {
    for (const r of all) {
      if (!r) continue;
      if (r.tex) deleteGlResource(gl, 'Texture', r.tex);
      if (r.fbo) deleteGlResource(gl, 'Framebuffer', r.fbo);
    }
    forget();
  }
  function forget() {
    all.length = 0;
    holes.length = 0;
    liveBytes = 0;
    free.clear();
  }
  // TRIM (memory). The pool keeps every size it was ever asked for, and a filter-heavy scene at a large canvas holds 100+ MB of
  // them for the life of the renderer. trim() frees ONE free target that has been idle for `idleMs`, is not the viewport's size
  // class (equal to it or larger), and only when the pool as a whole has had no acquire for `idleMs`: a live or alternating
  // filtered scene never loses a target it will ask for again. It returns the bytes freed (0 = nothing eligible). Freed slots
  // become null in `all` so indices stay stable.
  function trim(nowMs, idleMs, keepW, keepH) {
    if (!(idleMs > 0) || nowMs - lastAcquireT < idleMs) return 0;
    let best = -1;
    for (const bucket of free.values())
      for (let i = 0; i < bucket.length; i++) {
        const r = all[bucket[i]];
        if (!r || nowMs - (r.used || 0) < idleMs) continue;
        if (r.size[0] >= keepW && r.size[1] >= keepH) continue; // the viewport's own size class (or bigger): the next filter wants it
        if (best < 0 || (r.used || 0) < (all[best].used || 0)) best = bucket[i];
      }
    if (best < 0) return 0;
    const r = all[best],
      key = sizeKey(r.size[0], r.size[1], r.lin),
      bucket = free.get(key);
    if (bucket) {
      const at = bucket.indexOf(best);
      if (at >= 0) bucket.splice(at, 1);
      if (!bucket.length) free.delete(key);
    }
    if (r.tex) deleteGlResource(gl, 'Texture', r.tex);
    if (r.fbo) deleteGlResource(gl, 'Framebuffer', r.fbo);
    all[best] = null;
    holes.push(best);
    liveBytes -= r.size[0] * r.size[1] * bytesPerPx;
    return r.size[0] * r.size[1] * bytesPerPx;
  }
  /// Free the idle (released) targets, oldest first, until `needBytes` are freed; returns the bytes freed. Targets handed out by acquire() and not
  /// yet released are in use and are never touched. Size class does not matter here (trim() keeps the viewport's); this is the budget's call.
  /// `usedBefore` (ms): leave a target acquired at or after this time, the working set of the frames just drawn.
  function shrink(needBytes, usedBefore = Infinity) {
    let freed = 0;
    for (;;) {
      if (freed >= needBytes) break;
      let best = -1;
      for (const bucket of free.values())
        for (let i = 0; i < bucket.length; i++) {
          const r = all[bucket[i]];
          if (
            r &&
            (r.used || 0) < usedBefore &&
            (best < 0 || (r.used || 0) < (all[best].used || 0))
          )
            best = bucket[i];
        }
      if (best < 0) break;
      const r = all[best],
        key = sizeKey(r.size[0], r.size[1], r.lin),
        bucket = free.get(key);
      if (bucket) {
        const at = bucket.indexOf(best);
        if (at >= 0) bucket.splice(at, 1);
        if (!bucket.length) free.delete(key);
      }
      if (r.tex) deleteGlResource(gl, 'Texture', r.tex);
      if (r.fbo) deleteGlResource(gl, 'Framebuffer', r.fbo);
      all[best] = null;
      holes.push(best);
      liveBytes -= r.size[0] * r.size[1] * bytesPerPx;
      freed += r.size[0] * r.size[1] * bytesPerPx;
    }
    return freed;
  }
  /// What the pool holds right now: targets allocated, targets free, and how many free ones are the viewport's size class (never trimmed).
  function stats(keepW, keepH) {
    let nAll = 0,
      nFree = 0,
      nKeep = 0,
      bytes = 0;
    for (const r of all)
      if (r) {
        nAll++;
        bytes += r.size[0] * r.size[1] * bytesPerPx;
      }
    for (const b of free.values())
      for (const i of b) {
        const r = all[i];
        if (!r) continue;
        nFree++;
        if (r.size[0] >= keepW && r.size[1] >= keepH) nKeep++;
      }
    return { targets: nAll, free: nFree, viewportClass: nKeep, bytes };
  }
  /// The bytes the pool holds, as stats() counts them, without walking it.
  function bytes() {
    return liveBytes;
  }
  /// ms timestamp of the last acquire (0 = never): the renderer's "any filter work lately?" gate.
  function lastUse() {
    return lastAcquireT;
  }
  function alloc(w, h, lin) {
    const tex = trackGlResource(gl, gl.createTexture(), 'pool');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      lin ? gl.SRGB8_ALPHA8 : internalFormat,
      w,
      h,
      0,
      texFormat,
      texType,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = trackGlResource(gl, gl.createFramebuffer());
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, size: [w, h], lin };
  }
  // `rect` = the RT's canvas rect [x, y, w, h] in GL framebuffer px (origin
  // bottom-left). Filter RTs are 1:1 with canvas pixels, so a rect is a crop +
  // translation, never a scale; consumers remap uv through it (see
  // svgFilterShared.mapFor). Defaults to [0,0,w,h] — the canvas rect for a
  // canvas-sized RT — so a caller that doesn't care gets the right thing.
  // `overwrite`: the caller draws every texel of the RT before anything reads it (a conversion copy of an input fills its whole rect), so the
  // clear-on-acquire is skipped.
  function acquire(w, h, rect, overwrite) {
    // `opts.clamp()`: a fixed size the pool's creator asks for right now (the renderer's pipeline warm: pipelines depend on the format, not the size)
    const cl = opts.clamp ? opts.clamp() | 0 : 0;
    const qw = cl > 0 ? cl : quantize(w | 0);
    const qh = cl > 0 ? cl : quantize(h | 0);
    const lin = linear;
    const key = sizeKey(qw, qh, lin);
    const bucket = free.get(key);
    let idx;
    if (bucket && bucket.length) {
      idx = bucket.pop();
    } else {
      const target = alloc(qw, qh, lin);
      liveBytes += qw * qh * bytesPerPx;
      if (holes.length) {
        idx = holes.pop();
        all[idx] = target;
      } else {
        all.push(target);
        idx = all.length - 1;
      }
      // (memory probe: who allocates a NEW target, at what size -- set globalThis.__rtAllocLog = [] with __MANTLE_DEBUG__ to record; capped)
      const log = mantleDebugHook('__rtAllocLog');
      if (log && log.length < 4000)
        log.push([
          qw,
          qh,
          (new Error().stack || '')
            .split('\n')
            .slice(2, 7)
            .map((l) =>
              l
                .trim()
                .replace(/^at /, '')
                .replace(/\(.*\/(src|dist|node_modules)\//, '('),
            )
            .join(' < '),
        ]);
    }
    // Stamp every acquire — `all[idx]` is recycled, so a stale rect from a
    // previous tenant would silently offset every sample taken from it.
    all[idx].rect = rect || [0, 0, w | 0, h | 0];
    all[idx].used = lastAcquireT = now();
    if (clearOnAcquire && !overwrite) {
      // The caller pauses any user scissor for the whole graph evaluation, so
      // this clear reaches the entire RT.
      endKeepScissor(gl);
      const r = all[idx];
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
      gl.viewport(0, 0, r.size[0], r.size[1]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return idx;
  }
  function release(idx) {
    if (idx < 0 || idx >= all.length) return;
    const r = all[idx];
    if (!r) return;
    const key = sizeKey(r.size[0], r.size[1], r.lin);
    let bucket = free.get(key);
    if (!bucket) {
      bucket = [];
      free.set(key, bucket);
    }
    bucket.push(idx);
  }
  function get(idx) {
    return all[idx];
  }
  // The quantized (allocated) texture size for a (w, h) request. An acquired RT
  // is rounded UP to the pool quantum, so its texture is ≥ the requested size;
  // a screen-space consumer that sampled by viewport size would read past the
  // rendered region. Callers feeding gl_FragCoord-based UVs must divide by this.
  function sizeFor(w, h) {
    return [quantize(w | 0), quantize(h | 0)];
  }
  const api = {
    ensureSize,
    acquire,
    release,
    get,
    sizeFor,
    invalidate,
    forget,
    trim,
    shrink,
    bytes,
    lastUse,
    stats,
    setClearOnAcquire,
    setLinear,
    _scissorOn: false,
  };
  return api;
}

/// Walk a graph DAG end-to-end. `dispatch` is the node-type registry:
///   dispatch[nodeType](node, resolvedInputs, outRT, ctx)
/// where `resolvedInputs` is an array of either:
///   - { kind: 'source', tag: SRC_GRAPHIC | SRC_ALPHA | ... } for sentinel inputs
///   - { kind: 'rt', tex: WebGLTexture, fbo: WebGLFramebuffer } for node outputs
/// and outRT is the same shape: the framebuffer/texture the node should
/// write into. ctx is a free-form per-evaluation context the caller
/// passes in (e.g., the SVG-side ctx carries sourceRT, mainCopyTex, etc.).
///
/// Returns the root output's RT shape (caller composites it).
// `nodeRects` (optional): an array aligned with graph.nodes, each entry the
// canvas rect [x, y, w, h] (GL px, origin bottom-left) where that node's output
// can be non-zero. Given them, each node's RT is allocated at ITS own rect
// rather than at the full canvas — the memory and the fragment work both drop
// to the region that matters. Output-identical: a primitive is transparent
// black outside its subregion by spec, which is what a consumer reads off the
// edge of a rect (svgFilterShared.sampleIn returns 0 there, not the clamped
// texel). Omit for a canvas-sized graph. See renderer._filterNodeRects.
/**
 * @typedef {object} FilterGraphNode
 * @property {string} type the node type, the key into the dispatch registry
 * @property {number[]} inputs source sentinels (negative) and indices of earlier nodes
 * @property {Record<string, any> | null} [params] the node's parameters (their shape depends on `type`)
 */
/**
 * @typedef {object} FilterGraph
 * @property {FilterGraphNode[]} nodes
 * @property {number} rootOut the index of the node whose output is the result
 * @property {{ fill: any, stroke: any }} [ownerPaints] the owner's fill and stroke paint, scoped to one evaluation
 */
/**
 * @typedef {object} FilterRT A pooled render target.
 * @property {WebGLFramebuffer} fbo
 * @property {WebGLTexture} tex
 * @property {[number, number]} size texture size in pixels
 * @property {number[]} [rect] the canvas-space rect it covers
 * @property {number} [poolIdx] its pool slot, set on a graph's root result
 * @property {number} [cs] the color space the pixels are in (1 = linearRGB), set on a graph's root result
 */
/**
 * @typedef {Array<{ kind: string, idx?: number, tag?: number }>} FilterNodeInputs a resolved input: { kind: 'rt', idx } or { kind: 'source', tag }
 * @typedef {(node: FilterGraphNode, inputs: FilterNodeInputs, outRT: FilterRT, ctx: FilterEvalContext) => void} FilterNodeHandler
 * @typedef {Record<string, any>} FilterEvalContext The caller-defined evaluation context (renderer hooks, paint inputs, scratch the handlers share).
 */
/**
 * @param {WebGL2RenderingContext} gl
 * @param {FilterGraph} graph
 * @param {ReturnType<typeof createRTPool>} pool the render-target pool the nodes allocate from
 * @param {Record<string, FilterNodeHandler>} dispatch the node-type registry
 * @param {FilterEvalContext} ctx
 * @param {number} w the canvas-sized default target width
 * @param {number} h the canvas-sized default target height
 * @param {Array<number[] & { empty?: boolean }> | null} [nodeRects] per-node canvas rects (omit for a canvas-sized graph)
 * @returns {FilterRT} the root node's target; hand it back with releaseRoot
 */
function coverageShadow(graph, spaces) {
  const rootNode = graph.nodes[graph.rootOut],
    ns = graph.nodes;
  // Resolve constant paint coverage only at the terminal drop-shadow merge.
  // The interval is taken from the actual screen-space lower render target.
  const shadow =
    ns.length === 5 &&
    graph.rootOut === 4 &&
    ns[0].type === 'feGaussianBlur' &&
    ns[0].inputs.length === 1 &&
    ns[0].inputs[0] === SRC_ALPHA &&
    ns[1].type === 'feOffset' &&
    ns[1].inputs.length === 1 &&
    ns[1].inputs[0] === 0 &&
    ns[2].type === 'feFlood' &&
    ns[2].inputs.length === 0 &&
    ns[3].type === 'feComposite' &&
    ns[3].params?.op === 1 &&
    ns[3].inputs[0] === 2 &&
    ns[3].inputs[1] === 1 &&
    rootNode.type === 'feMerge' &&
    rootNode.inputs.length === 2 &&
    rootNode.inputs[0] === 3 &&
    rootNode.inputs[1] === SRC_GRAPHIC &&
    ns.every((n) => !n.params?.sub && !n.params?.subRegion && !n.params?.m) &&
    ns[2].params.rgba?.length === 4 &&
    ns[2].params.rgba.every((v) => Number.isFinite(v) && v >= 0 && v <= 1);
  return (
    spaces.any &&
    spaces.root === CS_LINEAR &&
    shadow &&
    spaces.per[3].out === CS_LINEAR &&
    spaces.per[4].ins[1] === CS_SRGB
  );
}

export function unitCoverageShadow(graph) {
  return coverageShadow(graph, analyzeSpaces(graph));
}

export function evaluateGraph(gl, graph, pool, dispatch, ctx, w, h, nodeRects) {
  pool.ensureSize(w, h);
  // Every acquired RT must start transparent: a handler that doesn't write its
  // whole rect (feOffset blits a translated crop; passthrough copies only the
  // overlap) leaves the rest, and the rest must read as 0.
  const previousClear = nodeRects && pool.setClearOnAcquire ? pool.setClearOnAcquire(true) : false;
  const previousLinear = pool.setLinear ? pool.setLinear(false) : false;
  const n = graph.nodes.length;
  ctx._graph = graph; // a handler that needs the graph's topology (feTile's input subregion) reads it here
  // PRIMITIVE SUBREGIONS (Filter Effects 1 §15.3): a node whose subregion is not the whole filter region is transparent outside it. The
  // renderer resolves them to canvas pixel rects (ctx.primClipsOf; null for the graph of any filter that states none, which is nearly
  // every one) and the output of each such node is cleared outside its rect right after its handler, before anything reads it.
  const clips = ctx.primClipsOf ? ctx.primClipsOf(graph) : null;
  // Refcount each node by how many later nodes (or the root) consume it.
  const analytic = ctx.analyticPaintTransforms ? new Uint8Array(n) : null;
  const raster = analytic ? new Uint8Array(n) : null;
  if (analytic)
    for (let i = 0; i < n; i++) {
      const node = graph.nodes[i],
        input = node.inputs[0];
      analytic[i] = +(
        node.type === 'PaintSolid' ||
        node.type === 'PaintLinearGradient' ||
        node.type === 'PaintRadialGradient' ||
        node.type === 'PaintSweepGradient' ||
        (node.type === 'PaintTransform' &&
          node.inputs.length === 1 &&
          input >= 0 &&
          input < i &&
          analytic[input])
      );
    }
  const refs = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (const inp of graph.nodes[i].inputs) {
      if (inp >= 0 && inp < n) {
        refs[inp]++;
        if (raster && !(analytic[i] && graph.nodes[i].type === 'PaintTransform')) raster[inp] = 1;
      }
    }
  }
  if (graph.rootOut >= 0 && graph.rootOut < n) {
    refs[graph.rootOut]++;
    if (raster) raster[graph.rootOut] = 1;
  }
  const outRT = new Array(n).fill(-1);
  let activeRT = -1;
  // COLOR SPACES (colorSpace.js): which space each node operates in and each result is tagged with. Null for a graph that names no linearRGB node.
  let spaces = analyzeSpaces(graph);
  if (ctx.sourceMaterial && coverageShadow(graph, spaces)) {
    const per = spaces.per.slice(),
      root = graph.rootOut;
    per[root] = {
      ...per[root],
      op: CS_SRGB,
      out: CS_LINEAR,
      coverageResolve: true,
      sourceMaterial: ctx.sourceMaterial,
    };
    spaces = { ...spaces, per, root: CS_LINEAR };
  }
  const previousCs = ctx._cs;
  // Owner paint inputs are scoped to this evaluation; a nested one (feImage drawing a filtered bundle) keeps its own scratch.
  const previousFillPaint = ctx.fillPaint,
    previousStrokePaint = ctx.strokePaint;
  const outerPaintRTs = ctx._solidPaintRTs,
    outerPaintIdx = ctx._solidPaintRTIdx;
  ctx._solidPaintRTs = null;
  ctx._solidPaintRTIdx = null;
  if (graph.ownerPaints) {
    ctx.fillPaint = graph.ownerPaints.fill;
    ctx.strokePaint = graph.ownerPaints.stroke;
  }
  const previousPaintNodes = ctx._paintNodes;
  ctx._paintNodes = graph.nodes;
  try {
    for (let i = 0; i < n; i++) {
      const node = graph.nodes[i];
      // A transform evaluates these generators from their records. Keep a
      // raster only when another consumer or the graph root needs its pixels.
      if (analytic && analytic[i] && !raster[i]) {
        for (const inp of node.inputs)
          if (inp >= 0 && --refs[inp] === 0 && outRT[inp] >= 0) pool.release(outRT[inp]);
        const trace = colrTraceSink();
        if (trace) trace.push({ i, type: node.type, analytic: true, err: 0, rgba: null });
        continue;
      }
      const inputs = node.inputs.map((inp) => {
        if (inp >= 0) return { kind: 'rt', idx: outRT[inp] };
        return { kind: 'source', tag: inp };
      });
      // Each output carries its canvas-space rect so consumers can map inputs
      // at a different origin without resampling them.
      const rect = nodeRects ? nodeRects[i] : null;
      // Match output storage to its color tag, then select the handler's working space for scratch allocations.
      const per = spaces.any ? spaces.per[i] : null;
      if (pool.setLinear) pool.setLinear(!!per && per.out === CS_LINEAR);
      const myRT = rect ? pool.acquire(rect[2], rect[3], rect) : pool.acquire(w, h);
      if (pool.setLinear) pool.setLinear(!!per && per.op === CS_LINEAR);
      activeRT = myRT;
      outRT[i] = myRT;
      const handler = dispatch[node.type];
      ctx._curIdx = i;
      ctx._cs = spaces.any ? spaces.per[i] : null;
      if (!(rect && rect.empty)) {
        if (!handler) {
          warnUnregisteredNode(node.type);
          unhandledNode(gl, inputs[0], pool, pool.get(myRT));
        } else handler(node, inputs, pool.get(myRT), ctx);
      }
      endKeepScissor(gl);
      if (clips && clips[i]) clearOutsideRect(gl, pool.get(myRT), clips[i]);

      const _trace = colrTraceSink();
      if (_trace) {
        const err = gl.getError();
        let rgba = null;
        try {
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, pool.get(myRT).fbo);
          const px = new Uint8Array(4);
          const [tw, th] = pool.get(myRT).size;
          gl.readPixels(tw >>> 1, th >>> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          rgba = [px[0], px[1], px[2], px[3]];
        } catch {}
        _trace.push({ i, type: node.type, err, rgba });
      }
      for (const inp of node.inputs) {
        if (inp >= 0 && --refs[inp] === 0) pool.release(outRT[inp]);
      }
      // Disconnected nodes are legal input but have no future consumer.
      if (refs[i] === 0) pool.release(myRT);
      activeRT = -1;
    }
    const root = pool.get(outRT[graph.rootOut]);
    root.poolIdx = outRT[graph.rootOut];
    root.cs = spaces.root; // the space the result is in (1 = linearRGB: the composite converts it to sRGB)
    return root;
  } catch (error) {
    // Release only live outputs. Zero-ref outputs were already returned and may
    // have been reused by a later node.
    const live = new Set();
    if (activeRT >= 0) live.add(activeRT);
    for (let i = 0; i < n; i++) {
      if (outRT[i] >= 0 && refs[i] > 0) live.add(outRT[i]);
    }
    for (const idx of live) pool.release(idx);
    throw error;
  } finally {
    endKeepScissor(gl);
    ctx._cs = previousCs;
    ctx._paintNodes = previousPaintNodes;
    ctx.fillPaint = previousFillPaint;
    ctx.strokePaint = previousStrokePaint;
    if (ctx._solidPaintRTIdx) for (const index of ctx._solidPaintRTIdx) pool.release(index);
    ctx._solidPaintRTs = outerPaintRTs;
    ctx._solidPaintRTIdx = outerPaintIdx;

    if (ctx && ctx._alphaRTIdx) {
      for (const idx of ctx._alphaRTIdx) pool.release(idx);
      ctx._alphaRTIdx = null;
      ctx._alphaRTs = null;
    }
    if (nodeRects && pool.setClearOnAcquire) pool.setClearOnAcquire(previousClear);
    if (pool.setLinear) pool.setLinear(previousLinear);

    noteExternalGlWrite();
  }
}

/// Clear everything of `rt` outside `keep` ([x, y, w, h] in the canvas pixels the RT's rect is in; w or h <= 0 keeps nothing). The
/// scissor is off while a graph evaluates, so it is switched on for the strips and back off.
function clearOutsideRect(gl, rt, keep) {
  const r = rt.rect || [0, 0, rt.size[0], rt.size[1]],
    w = rt.size[0],
    h = rt.size[1];
  const cl = (v, hi) => Math.max(0, Math.min(hi, v));
  const x0 = cl(keep[0] - r[0], w),
    y0 = cl(keep[1] - r[1], h);
  const x1 = cl(keep[0] + keep[2] - r[0], w),
    y1 = cl(keep[1] + keep[3] - r[1], h);
  if (x0 <= 0 && y0 <= 0 && x1 >= w && y1 >= h && keep[2] > 0 && keep[3] > 0) return;
  // (The renderer pauses its scissor for a graph evaluation; whatever it was, it is handed back as found.)
  const wasOn = gl.isEnabled(gl.SCISSOR_TEST),
    box = wasOn ? gl.getParameter(gl.SCISSOR_BOX) : null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.SCISSOR_TEST);
  const strip = (x, y, sw, sh) => {
    if (sw > 0 && sh > 0) {
      gl.scissor(x, y, sw, sh);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  };
  if (!(x1 > x0 && y1 > y0) || !(keep[2] > 0 && keep[3] > 0)) strip(0, 0, w, h);
  else {
    strip(0, 0, w, y0);
    strip(0, y1, w, h - y1);
    strip(0, y0, x0, y1 - y0);
    strip(x1, y0, w - x1, y1 - y0);
  }
  if (wasOn) gl.scissor(box[0], box[1], box[2], box[3]);
  else gl.disable(gl.SCISSOR_TEST);
}

/// Return an evaluateGraph root to the pool once the caller has consumed it.
export function releaseRoot(pool, rootRT) {
  if (rootRT && rootRT.poolIdx !== undefined && rootRT.poolIdx >= 0) {
    pool.release(rootRT.poolIdx);
    rootRT.poolIdx = -1;
  }
}

// What a node with no registered handler renders. Reached in lean builds:
// handlers register themselves on import (see dispatchRegistry.js), so a
// build that ships only the primitives its assets need will hit this for any
// primitive it left out.

// It copies the input through when it can, leaving the element unfiltered
// instead of absent — the same "render up to the error" posture the SVG spec
// takes elsewhere (§8.3.9). Only pool RTs can be reached from here; a sentinel
// input needs ctx, which is caller-defined and not guaranteed to carry one, so
// that case still clears.
function unhandledNode(gl, input, pool, outRT) {
  if (input && input.kind === 'rt' && input.idx >= 0) {
    const inRT = pool.get(input.idx);
    if (inRT && inRT.fbo) {
      // Both RTs are 1:1 with canvas pixels, so this is a translated crop of
      // the overlapping region — the same mapping svgFilterShared.blitRect
      // does, repeated here rather than imported: this module is imported BY
      // svgFilterShared, and closing that loop is how a swallowed
      // ReferenceError becomes a silent fallback.
      const inR = inRT.rect || [0, 0, inRT.size[0], inRT.size[1]];
      const outR = outRT.rect || [0, 0, outRT.size[0], outRT.size[1]];
      const x0 = Math.max(inR[0], outR[0]),
        y0 = Math.max(inR[1], outR[1]);
      const x1 = Math.min(inR[0] + inR[2], outR[0] + outR[2]);
      const y1 = Math.min(inR[1] + inR[3], outR[1] + outR[3]);
      if (x1 > x0 && y1 > y0) {
        applyKeepScissor(gl, outRT);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, inRT.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, outRT.fbo);
        gl.blitFramebuffer(
          x0 - inR[0],
          y0 - inR[1],
          x1 - inR[0],
          y1 - inR[1],
          x0 - outR[0],
          y0 - outR[1],
          x1 - outR[0],
          y1 - outR[1],
          gl.COLOR_BUFFER_BIT,
          gl.NEAREST,
        );
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
        return;
      }
      // Rects don't meet: nothing of the input lands here, so transparent is
      // the right answer and the clear below produces it.
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
  gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

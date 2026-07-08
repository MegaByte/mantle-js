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
//
// The walker:
//   1. Reference-count every node's `inputs[]` so we know when each
//      output RT can return to the freelist.
//   2. Topological order is implicit — nodes only reference earlier
//      indices (importer responsibility).
//   3. For each node, allocate an output RT from the pool, call its
//      registered shader pass, decrement refcounts on its inputs, and
//      free any input RT whose refcount has reached zero.
//   4. Return the root's RT (caller composites it back to main FB).
//
// The pool keeps RTs allocated lazily and reuses them across draws of
// the same canvas size; the canvas-size invalidator is the same as
// shapeFbo's.

import { colrTraceSink } from '../core/diagnostics.js';

export const SRC_GRAPHIC      = -1;
export const SRC_ALPHA        = -2;
export const SRC_BACKGROUND   = -3;
export const SRC_BACKGROUND_A = -4;
export const SRC_FILL_PAINT   = -5;
export const SRC_STROKE_PAINT = -6;

/// Construct an RT pool against a GL context. Each RT is a single-FBO
/// RGBA8 attachment of an arbitrary (w, h). pool.acquire(w, h) returns
/// a handle; pool.release(handle) returns it for reuse at the same
/// size. pool.invalidate() drops everything (call on canvas resize so
/// the pool's RTs don't outlive the GL viewport).
///
/// Free RTs are bucketed by quantized size so a 47×93 bbox and a
/// 49×91 bbox share the same bucket (both round up to 64×128). The
/// quantization step is 32 — small enough that the over-allocation
/// is negligible (worst case +31 pixels per axis) while keeping
/// bucket fragmentation low. Bucket key fits in 32 bits (w|h<<16),
/// supporting canvases up to 65535 × 65535.
///
/// `pool.ensureSize(w, h)` is a no-op kept for API stability; the bucketed
/// pool needs no global current size.
const POOL_QUANT = 32;
function quantize(v) {
  return Math.max(POOL_QUANT, Math.ceil(v / POOL_QUANT) * POOL_QUANT);
}
function sizeKey(w, h) {
  return (w & 0xffff) | ((h & 0xffff) << 16);
}

export function createRTPool(gl, opts) {
  // Attachment format defaults to RGBA8 (the filter/COLR pool). A coverage-only
  // pool can pass { internalFormat: gl.R8, format: gl.RED } for a 4× memory cut —
  // valid because coverage RTs are written/sampled as a single channel (.r).
  opts = opts || {};
  const internalFormat = opts.internalFormat || gl.RGBA8;
  const texFormat = opts.format || gl.RGBA;
  const texType = opts.type || gl.UNSIGNED_BYTE;
  const all = [];          // [{ fbo, tex, size: [w,h] }]
  const free = new Map();  // sizeKey → indices into `all`
  // When true, acquire() returns a fully transparent RT (clearing any
  // recycled content). Set by evaluateGraph only while node scissoring is
  // active, so EVERY acquired RT — node outputs AND handler intermediates
  // (blur tmp / box ping-pong / merge accumulator) — is stale-free.
  // Scissored passes then write only their bbox and leave the rest at 0,
  // which is byte-exact because spec-bounded primitives are 0 outside
  // their bbox. Off by default → the non-scissored COLR path pays nothing.
  let clearOnAcquire = false;
  function setClearOnAcquire(v) { clearOnAcquire = !!v; }
  function ensureSize(_w, _h) {
    // No-op. Bucketed pool doesn't need a global current size.
    void _w; void _h;
  }
  function invalidate() {
    for (const r of all) {
      if (r.tex) gl.deleteTexture(r.tex);
      if (r.fbo) gl.deleteFramebuffer(r.fbo);
    }
    forget();
  }
  function forget() {
    all.length = 0;
    free.clear();
  }
  function alloc(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, texFormat, texType, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex, size: [w, h] };
  }
  function acquire(w, h) {
    const qw = quantize(w | 0);
    const qh = quantize(h | 0);
    const key = sizeKey(qw, qh);
    const bucket = free.get(key);
    let idx;
    if (bucket && bucket.length) {
      idx = bucket.pop();
    } else {
      all.push(alloc(qw, qh));
      idx = all.length - 1;
    }
    if (clearOnAcquire) {
      // Clear the full RT transparent, scissor-safe: a node scissor may be
      // active (we're mid-handler for a multi-pass primitive), so disable
      // it around the clear and restore it so the handler's own draws stay
      // scissored.
      const r = all[idx];
      const scOn = gl.isEnabled(gl.SCISSOR_TEST);
      if (scOn) gl.disable(gl.SCISSOR_TEST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, r.fbo);
      gl.viewport(0, 0, r.size[0], r.size[1]);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (scOn) gl.enable(gl.SCISSOR_TEST);
    }
    return idx;
  }
  function release(idx) {
    if (idx < 0 || idx >= all.length) return;
    const r = all[idx];
    const key = sizeKey(r.size[0], r.size[1]);
    let bucket = free.get(key);
    if (!bucket) { bucket = []; free.set(key, bucket); }
    bucket.push(idx);
  }
  function get(idx) {
    return all[idx];
  }
  // The quantized (allocated) texture size for a (w, h) request. An acquired RT
  // is rounded UP to the pool quantum, so its texture is ≥ the requested size;
  // a screen-space consumer that sampled by viewport size would read past the
  // rendered region. Callers feeding gl_FragCoord-based UVs must divide by THIS.
  function sizeFor(w, h) { return [quantize(w | 0), quantize(h | 0)]; }
  return { ensureSize, acquire, release, get, sizeFor, invalidate, forget, setClearOnAcquire };
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
// `nodeScissors` (optional): an array aligned with graph.nodes. Each
// entry is a GL scissor rect {x,y,w,h} in bottom-left framebuffer pixels
// restricting that node's pass to the region where its output can be
// non-zero, or null/absent to draw the full canvas for that node. When
// provided, the node's RT is pre-cleared to transparent across the full
// canvas and the handler's draw is scissored — output-identical to a
// full pass for spec-bounded primitives while skipping out-of-bbox
// fragment work. See renderer._filterNodeScissors.
export function evaluateGraph(gl, graph, pool, dispatch, ctx, w, h, nodeScissors) {
  pool.ensureSize(w, h);
  // With scissoring active, every acquired RT must start transparent so a
  // scissored pass leaves stale-free zeros outside its bbox (byte-exact for
  // spec-bounded primitives, incl. multi-pass blur intermediates).
  if (nodeScissors && pool.setClearOnAcquire) pool.setClearOnAcquire(true);
  const n = graph.nodes.length;
  // Refcount each node by how many later nodes (or the root) consume it.
  const refs = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (const inp of graph.nodes[i].inputs) {
      if (inp >= 0 && inp < n) refs[inp]++;
    }
  }
  if (graph.rootOut >= 0 && graph.rootOut < n) refs[graph.rootOut]++;
  const outRT = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const node = graph.nodes[i];
    // Resolve inputs.
    const inputs = node.inputs.map(inp => {
      if (inp >= 0) return { kind: 'rt', idx: outRT[inp] };
      return { kind: 'source', tag: inp };
    });
    // Allocate this node's output RT at canvas size. Bbox-sized RTs would
    // require per-shader UV remapping uniforms — the SVG handlers assume
    // input.uv == output.uv at vUV=[0,1], which only holds when both RTs
    // cover the same canvas region. The COLRv1 dispatch sidesteps this by
    // passing bboxOrigin/bboxSize as explicit uniforms.
    const myRT = pool.acquire(w, h);
    outRT[i] = myRT;
    const handler = dispatch[node.type];
    // Hand the current node index to dispatch handlers that need it
    // (e.g., COLRv1 dispatch reads per-node bbox via ctx._curIdx). The
    // SVG dispatch ignores this field; passthrough handlers ignore it.
    ctx._curIdx = i;
    // myRT was just cleared transparent by acquire (clearOnAcquire is on
    // whenever nodeScissors is set). Restrict the handler's draw + its own
    // clear to the node's bbox; everything outside stays at the cleared 0,
    // which is byte-exact for spec-bounded primitives.
    const sc = nodeScissors ? nodeScissors[i] : null;
    if (sc) {
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(sc.x, sc.y, sc.w, sc.h);
    }
    if (!handler) {
      // Unknown node type: emit a passthrough of input[0] if present,
      // else transparent black. Keeps the walker robust against partial
      // dispatch tables (e.g., COLRv1 nodes when running an SVG graph).
      passthrough(gl, inputs[0], pool.get(myRT), ctx);
    } else {
      handler(node, inputs, pool.get(myRT), ctx);
    }
    if (sc) gl.disable(gl.SCISSOR_TEST);
    // Optional per-node trace for COLR filter-graph tests
    // (`setDiagnostics({ colrTrace: [] })`). No-op when unset.
    const _trace = colrTraceSink();
    if (_trace) {
      const err = gl.getError();
      let rgba = null;
      try {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, pool.get(myRT).fbo);
        const px = new Uint8Array(4);
        gl.readPixels(w >>> 1, h >>> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        rgba = [px[0], px[1], px[2], px[3]];
      } catch {}
      _trace.push({ i, type: node.type, err, rgba });
    }
    // Drop refs on inputs; free any RTs whose refcount hits 0 (and
    // they were RT-backed, not source sentinels).
    for (const inp of node.inputs) {
      if (inp >= 0 && --refs[inp] === 0) {
        pool.release(outRT[inp]);
      }
    }
  }
  // Restore the pool's default (no clear-on-acquire) so a later
  // non-scissored evaluation (e.g. COLR) pays nothing.
  if (nodeScissors && pool.setClearOnAcquire) pool.setClearOnAcquire(false);
  return pool.get(outRT[graph.rootOut]);
}

// Passthrough helper for unknown nodes (or no-op nodes). Not exported;
// dispatch handlers register their own copies as needed.
function passthrough(gl, input, outRT, ctx) {
  // The fastest passthrough is a framebuffer blit; the dispatch layer
  // can call gl.blitFramebuffer itself when it knows the source is an
  // RT. For the default fallback path we just clear the output, since
  // the walker hit an unknown node-type and we don't want to depend on
  // ctx.copyTexProgram being present.
  gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
  gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  void input;
  void ctx;
}

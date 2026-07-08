// shapeMorph.js — name-based shape morph between two bundles.
//
// Source bundles aren't guaranteed to share matched topology + ordering,
// so we match by `shapeId` and categorize each shape:
//
//   - matched (same id, same curve byte count + same per-shape band /
//     meta layout): per-texel curve lerp at parameter t. Both poses'
//     geometry collapses onto one shape slot. Exact and continuous.
//   - src-only (id present in source but missing in target): fade out
//     as t → 1 via per-shape visibility on a private override table.
//   - dst-only (id present in target but missing in source): the
//     shape is appended to the morph bundle's shape list with its
//     visibility ramping in as t → 1.
//
// Shapes without a string id (or with empty id) fall back to positional
// matching by index up to the shorter bundle's length; extras on either
// side become src-only / dst-only.
//
// Public API:
//
//   const morph = createShapeMorph(gl, srcBundle, dstBundle);
//   renderer.drawBundle(morph.bundle, { worldMatrix });
//   morph.setT(0.5);   // re-uploads curves + visibility
//   morph.dispose();   // releases GL resources
//
// Cost shape: matched-shape curve lerp is O(total_matched_curve_texels)
// per setT; for typical Flash-style assets that's ~30KB and a single
// texSubImage2D upload. Fade-only shapes pay no per-T cost beyond a
// trivial override-table touch.

import { createBundle, makeTex } from '../renderer/bundle.js';
import { mantleDebugFlag } from '../core/diagnostics.js';
import { createOverrideTable } from './overrides.js';

// GPU texture lerp (gl-memoized): out = mix(texA, texB, uT). Interpolates
// the static src/dst CURVE textures into the live curve texture each setT,
// avoiding a per-frame CPU lerp + texSubImage2D upload. Samples on high
// texture units (14/15) so it never disturbs the renderer's cached fill-pass
// bindings (units 0–9); the RTT updates the live texture's content while its
// unit-0 binding stays valid.
const _lerpPassByGl = new WeakMap();
function getLerpPass(gl) {
  let p = _lerpPassByGl.get(gl);
  if (p) return p;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('lerpPass: ' + gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, '#version 300 es\nlayout(location=0) in vec2 a; out vec2 uv; void main(){ uv = a*0.5+0.5; gl_Position = vec4(a,0.0,1.0); }'));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; in vec2 uv; uniform highp sampler2D uA, uB; uniform float uT; out vec4 o; void main(){ o = mix(texture(uA, uv), texture(uB, uv), uT); }'));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('lerpPass link: ' + gl.getProgramInfoLog(prog));
  const vao = gl.createVertexArray();
  const vb = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);  // fullscreen tri
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  p = { prog, vao, uA: gl.getUniformLocation(prog, 'uA'), uB: gl.getUniformLocation(prog, 'uB'), uT: gl.getUniformLocation(prog, 'uT') };
  _lerpPassByGl.set(gl, p);
  return p;
}

// Pure (gl-free) morph machinery lives in the core so the no-WebGL
// fallback can reuse it without importing this GL module.
import {
  resolveSpriteRange,
  buildMorphPlan,
  composeMorphSections,
  resetVisibility,
  updateVisibility,
} from '../core/morphCore.js';


/**
 * Build a morph handle from two source bundles. Both bundles must be
 * createBundle outputs (exposing `shapeIds`, `metaFloats`, etc.).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {object} srcBundle
 * @param {object} dstBundle
 */
// DefineMorphShape2 morphable meta slots, lerped src→dst per matched shape:
//   0..3 bbox xywh · 4..7 fillColor RGBA · 8..11 strokeColor RGBA
//   12 strokeWidth (texel 3.x) · 36..39 imageRect (texel 9). Everything else
// stays at src.
const MORPH_LERP_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 36, 37, 38, 39];

export function createShapeMorph(gl, srcBundle, dstBundle, opts) {
  if (!gl) throw new Error('createShapeMorph: gl required');
  if (!srcBundle || !dstBundle)
    throw new Error('createShapeMorph: both source and target bundles required');
  // Whole-bundle morph = sprite morph with no range restriction.
  return _buildMorph(gl, srcBundle, dstBundle, null, null, opts);
}

/**
 * Morph ONE sprite (a top-level <g id> / lone id'd top-level shape from a
 * sheet, via bundle.spriteRanges) against another. Same handle API as
 * createShapeMorph (bundle / setT / dispose). The morph bundle renders only
 * the sprite; the rest of the sheet is carried but hidden.
 *
 *   const morph = createSpriteMorph(gl,
 *     { bundle: sheet, sprite: 'hero_idle' },     // sprite = id OR [first,last]
 *     { bundle: sheet, sprite: 'hero_run'  });    // dst.bundle may === src.bundle
 *   renderer.drawBundle(morph.bundle, { worldMatrix });
 *   morph.setT(0.5);
 *
 * Shapes within the two sprites match by shapeId (then positionally) and
 * curve-lerp when their per-shape topology matches; mismatched pairs
 * crossfade. For a true geometric morph the two poses should share matched
 * per-shape topology (same shape count + curve sizes, ideally same ids).
 *
 * @param {WebGL2RenderingContext} gl
 * @param {{bundle:object, sprite:(string|[number,number])}} srcRef
 * @param {{bundle:object, sprite:(string|[number,number])}} dstRef
 */
export function createSpriteMorph(gl, srcRef, dstRef) {
  if (!gl) throw new Error('createSpriteMorph: gl required');
  if (!srcRef || !srcRef.bundle || !dstRef || !dstRef.bundle)
    throw new Error('createSpriteMorph: srcRef.bundle and dstRef.bundle required');
  const srcRange = resolveSpriteRange(srcRef.bundle, srcRef.sprite, 'src');
  const dstRange = resolveSpriteRange(dstRef.bundle, dstRef.sprite, 'dst');
  // Same-bundle overlapping ranges are a malformed request (a sprite can't
  // morph against itself / an overlapping span).
  if (srcRef.bundle === dstRef.bundle
      && srcRange[0] <= dstRange[1] && dstRange[0] <= srcRange[1]) {
    throw new Error('createSpriteMorph: src and dst sprites overlap in the '
      + 'same bundle (ranges [' + srcRange + '] and [' + dstRange + ']); '
      + 'morph two DISTINCT sprites, or use separate bundles.');
  }
  return _buildMorph(gl, srcRef.bundle, dstRef.bundle, srcRange, dstRange);
}

// Shared core for whole-bundle (createShapeMorph) and per-sprite
// (createSpriteMorph) morphs. srcRange / dstRange are inclusive
// [first, last] shape-index ranges, or null = the whole bundle. When a
// range is set, only that sprite's shapes participate (the morph bundle
// contains just those rows + dst-only appends); the curve / band /
// curveGeom / gradient / filter / atlas planes are forwarded WHOLE from
// src so the meta rows' absolute indices into them stay valid (slicing
// those would require re-indexing every side table).
function _buildMorph(gl, srcBundle, dstBundle, srcRange, dstRange, opts) {
  // 1. Categorize shapes by id (or positional index for blank ids),
  //    scoped to the sprite ranges when set.
  const plan = buildMorphPlan(srcBundle, dstBundle, srcRange, dstRange);

  // 2. Compose a sections-shape dict for the morph's bundle. We
  //    seed it with `src` (its curves are the t=0 state) plus extra
  //    rows for `dst-only` shapes appended at the end. Meta + curve
  //    + band buffers expand to accomodate.
  const sections = composeMorphSections(srcBundle, dstBundle, plan);
  const bundle = createBundle(gl, sections);

  // Mark the bundle so the renderer's GPU-resident Loop-Blinn morph route
  // (opt-in via renderer.setLoopBlinnMorphFill) can build per-shape morph meshes
  // from the STATIC endpoints and lerp on the GPU, replacing this setT's
  // per-frame CPU lerp + texture uploads. Only morphs whose shapes ALL matched
  // (no fade in/out) are routable. `t` is updated every setT; `skipUploads` is
  // flipped on by the renderer once it routes.
  // Per-shape curve ranges in the _mergedCurveF32 / _dstCurveF32 coordinate
  // space (FLOAT indices), keyed by shape index — from plan.matched, NOT the
  // bundle's curveRangesByShape (which is padded to the curve-texture size and
  // doesn't align with the merged curve arrays).
  const _morphCurveRanges = [];
  for (const m of plan.matched) _morphCurveRanges[m.srcIdx] = { begin: m.srcBegin, end: m.srcEnd };
  // PREBUILD: queue the morph-pair mesh build the moment the target attaches —
  // crash/transition morphs are normally ready before their first draw instead of
  // building inside the frame (the idle preparer resumes it in 8ms slices).
  try { _smEnqueue && _smEnqueue(bundle); } catch { }
  bundle._morphSrc = {
    mergedCurveF32: sections._mergedCurveF32,
    dstCurveF32: sections._dstCurveF32,
    curveRanges: _morphCurveRanges,
    mergedMetaF32: sections._mergedMetaF32,
    dstMetaF32: sections._dstAlignedMetaF32,
    metaStride: sections._metaStride,
    matchedAll: plan.matched.length === (bundle.numShapes | 0),
    t: 0,
    skipUploads: false,
  };

  // 3. Private override table for fade-in / fade-out. Initial state
  //    matches t = 0: src + matched fully visible, dst-only invisible.
  const overrides = createOverrideTable(gl, bundle);
  resetVisibility(overrides, plan, /* t = */ 0);

  // 4. Curve-lerp scratch buffer. Same shape as the seeded curve
  //    plane so we can `texSubImage2D` the whole thing per setT. We
  //    allocate it lazily on first setT because t == 0 needs no
  //    upload (texture already holds src curves).
  let lerpCurves = null;
  // Parallel scratch for the gradient-stops byte plane. Lazily
  // allocated the first time setT needs to upload non-baseline stops.
  let lerpStopsBytes = null;
  // DefineMorphShape2 lerp scratches (Slice 1 + gradient params).
  // lerpMeta: same shape as `_mergedMetaF32`, used to re-upload the
  // bundle's meta texture per setT.
  let lerpMeta = null;
  let lerpGradParams = null;
  let lastT = 0;
  // ── GPU texture-lerp targets ──────────────────────────────────────────
  // Each plane (curve / gradient-stops / meta / gradient-params) is morphed by
  // a render-to-texture pre-pass: mix(srcTex, dstTex, t) → the live texture, no
  // per-frame CPU lerp + texSubImage2D. `dst` is the t=1 FULL plane (src with
  // only the morphing slots overlaid by dst values), so mix reproduces the
  // per-slot lerp. Falls back to a CPU lerp+upload when the render target isn't
  // available (EXT_color_buffer_float absent). Built lazily on first setT.
  // `undefined` = not built, `null` = no data, object = built.
  let _ltCurve, _ltStops, _ltMeta, _ltGrad;
  function buildLerpTarget(liveTex, src, dst, W, H, internal, format, type, cpuFallback) {
    // CPU fallback when GPU float render targets can't be set up: the
    // explicit opt (opts.cpuLerp — parity tests compare both paths), or a
    // stub/limited GL context (no getExtension) where the cpuFallback's
    // plain texSubImage2D upload still works.
    if ((opts && opts.cpuLerp) || typeof gl.getExtension !== 'function') return { gpu: false, cpuFallback };
    gl.getExtension('EXT_color_buffer_float');
    const srcTex = makeTex(gl, src, W, H, internal, format, type);
    const dstTex = makeTex(gl, dst, W, H, internal, format, type);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, liveTex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) { gl.deleteFramebuffer(fbo); gl.deleteTexture(srcTex); gl.deleteTexture(dstTex); return { gpu: false, cpuFallback }; }
    return { gpu: true, srcTex, dstTex, fbo, W, H, cpuFallback };
  }
  // High texture units (14/15) so the renderer's cached fill bindings (0–9) are
  // untouched; the RTT updates the live texture's content, its unit-0 binding
  // stays valid.
  function runLerpTarget(tgt, t) {
    if (!tgt.gpu) { tgt.cpuFallback(t); return; }
    const lp = getLerpPass(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo);
    gl.viewport(0, 0, tgt.W, tgt.H);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(lp.prog);
    gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_2D, tgt.srcTex); gl.uniform1i(lp.uA, 14);
    gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, tgt.dstTex); gl.uniform1i(lp.uB, 15);
    gl.uniform1f(lp.uT, t);
    gl.bindVertexArray(lp.vao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.activeTexture(gl.TEXTURE0);
  }

  /** Upload the morph state for parameter t. */
  function setT(t) {
    t = clamp01(t);
    if (t === lastT && t !== 0) return;
    lastT = t;
    bundle._morphSrc.t = t;
    // When the renderer's GPU-resident LB morph route is active it lerps the
    // geometry + color on the GPU from the static endpoints, so skip this
    // frame's CPU lerp + texture uploads entirely; just keep the fade-in/out
    // visibility in sync (a no-op for fully-matched morphs).
    if (bundle._morphSrc.skipUploads) { updateVisibility(overrides, plan, t); return; }
    // 1. Curves (matched shapes).
    if (plan.matched.length) {
      if (_ltCurve === undefined) {
        const merged = sections._mergedCurveF32, W = sections._curveW, H = sections._curveH;
        const t1 = merged.slice();
        for (const m of plan.matched) t1.set(sections._dstCurveF32.subarray(m.srcBegin, m.srcEnd), m.srcBegin);
        _ltCurve = buildLerpTarget(bundle.curveTex, merged, t1, W, H, gl.RGBA32F, gl.RGBA, gl.FLOAT, (tt) => {
          if (!lerpCurves) lerpCurves = new Float32Array(merged.length);
          lerpCurves.set(merged);
          for (const m of plan.matched) { const d = sections._dstCurveF32.subarray(m.srcBegin, m.srcEnd), s = merged.subarray(m.srcBegin, m.srcEnd), o = lerpCurves.subarray(m.srcBegin, m.srcEnd); for (let i = 0; i < o.length; i++) o[i] = s[i] * (1 - tt) + d[i] * tt; }
          gl.bindTexture(gl.TEXTURE_2D, bundle.curveTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.FLOAT, lerpCurves); gl.bindTexture(gl.TEXTURE_2D, null);
        });
      }
      runLerpTarget(_ltCurve, t);
    }
    // 2. Gradient stops (RGBA8 — color-renderable without the float ext).
    if (sections._gradStopPlan && sections._gradStopPlan.length && sections._srcGradStopsB && sections._dstGradStopsB && bundle.gradientStopsTex) {
      if (_ltStops === undefined) {
        const src = sections._srcGradStopsB, W = Math.max(1, bundle.gradientStopsCount | 0);
        const t1 = src.slice();
        for (const r of sections._gradStopPlan) for (let k = 0; k < r.byteLength; k++) t1[r.srcByteOffset + k] = sections._dstGradStopsB[r.dstByteOffset + k];
        _ltStops = buildLerpTarget(bundle.gradientStopsTex, src, t1, W, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, (tt) => {
          if (!lerpStopsBytes) lerpStopsBytes = new Uint8Array(src.length);
          lerpStopsBytes.set(src); const ti = 1 - tt;
          for (const r of sections._gradStopPlan) for (let k = 0; k < r.byteLength; k++) lerpStopsBytes[r.srcByteOffset + k] = (src[r.srcByteOffset + k] * ti + sections._dstGradStopsB[r.dstByteOffset + k] * tt + 0.5) | 0;
          gl.bindTexture(gl.TEXTURE_2D, bundle.gradientStopsTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, lerpStopsBytes); gl.bindTexture(gl.TEXTURE_2D, null);
        });
      }
      runLerpTarget(_ltStops, t);
    }
    // 3. Meta plane (only the morphable slots differ src↔dst; structural slots
    // — ids/glyphLoc/flags — are identical in src & dst so mix leaves them).
    if (plan.matched.length && bundle.metaTex && sections._mergedMetaF32 && sections._dstAlignedMetaF32) {
      if (_ltMeta === undefined) {
        const merged = sections._mergedMetaF32, stride = sections._metaStride, FULL_META_W = 12, mh = merged.length / (FULL_META_W * 4) | 0;
        if (mh > 0) {
          const t1 = merged.slice();
          for (const srcIdx of sections._matchedSrcIdxs) { const base = srcIdx * stride; for (const s of MORPH_LERP_SLOTS) t1[base + s] = sections._dstAlignedMetaF32[base + s]; }
          _ltMeta = buildLerpTarget(bundle.metaTex, merged, t1, FULL_META_W, mh, gl.RGBA32F, gl.RGBA, gl.FLOAT, (tt) => {
            if (!lerpMeta) lerpMeta = new Float32Array(merged.length);
            lerpMeta.set(merged); const ti = 1 - tt;
            for (const srcIdx of sections._matchedSrcIdxs) { const base = srcIdx * stride; for (const s of MORPH_LERP_SLOTS) { const o = base + s; lerpMeta[o] = merged[o] * ti + sections._dstAlignedMetaF32[o] * tt; } }
            gl.bindTexture(gl.TEXTURE_2D, bundle.metaTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FULL_META_W, mh, gl.RGBA, gl.FLOAT, lerpMeta); gl.bindTexture(gl.TEXTURE_2D, null);
          });
        } else _ltMeta = null;
      }
      if (_ltMeta) runLerpTarget(_ltMeta, t);
    }
    // 4. Gradient params (gradient_transform + focal + axis endpoints).
    if (sections._gradParamPlan && sections._gradParamPlan.length && sections._srcGradParamsF && sections._dstGradParamsF && bundle.gradientTex) {
      if (_ltGrad === undefined) {
        const src = sections._srcGradParamsF, gradCount = src.length >>> 4;
        if (gradCount > 0) {
          const t1 = src.slice();
          for (const p of sections._gradParamPlan) for (const s of p.lerpSlots) t1[p.baseF + s] = sections._dstGradParamsF[p.baseF + s];
          _ltGrad = buildLerpTarget(bundle.gradientTex, src, t1, 4, gradCount, gl.RGBA32F, gl.RGBA, gl.FLOAT, (tt) => {
            if (!lerpGradParams) lerpGradParams = new Float32Array(src.length);
            lerpGradParams.set(src); const ti = 1 - tt;
            for (const p of sections._gradParamPlan) for (const s of p.lerpSlots) { const i = p.baseF + s; lerpGradParams[i] = src[i] * ti + sections._dstGradParamsF[i] * tt; }
            gl.bindTexture(gl.TEXTURE_2D, bundle.gradientTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, gradCount, gl.RGBA, gl.FLOAT, lerpGradParams); gl.bindTexture(gl.TEXTURE_2D, null);
          });
        } else _ltGrad = null;
      }
      if (_ltGrad) runLerpTarget(_ltGrad, t);
    }
    // Visibility fade for src-only / dst-only.
    updateVisibility(overrides, plan, t);
  }

  /** Release all GL resources owned by the morph. */
  function dispose() {
    if (overrides) overrides.dispose();
    for (const tgt of [_ltCurve, _ltStops, _ltMeta, _ltGrad]) {
      if (tgt && tgt.gpu) { gl.deleteFramebuffer(tgt.fbo); gl.deleteTexture(tgt.srcTex); gl.deleteTexture(tgt.dstTex); }
    }
    if (bundle && bundle.dispose) bundle.dispose();
  }

  // SVG-export back-reference (request-time reconstruction). The morph
  // bakes interpolated geometry into the GPU curve texture, so the lerped
  // path lives only on the GPU — there is no CPU `d` string to serialize.
  // Stash just the inputs the export path needs to rebuild it on demand:
  // the two source bundles, the optional sprite ranges, and a live read of
  // the current parameter. renderer.exportFrameSVG() reads this, builds a
  // native morph (CPU `curveRangeToPathD`) for the SAME src/dst, and ticks
  // it to `t`. Non-enumerable so it doesn't perturb bundle iteration.
  try {
    Object.defineProperty(bundle, '__exportMorph', {
      value: {
        srcBundle, dstBundle,
        // null range = whole-bundle morph (createNativeMorph treats an
        // undefined sprite the same way); a set range is the inclusive
        // [first,last] shape span, which createNativeMorph accepts as a
        // sprite selector.
        srcSprite: srcRange || undefined,
        dstSprite: dstRange || undefined,
        get t() { return lastT; },
      },
      enumerable: false, configurable: true, writable: true,
    });
  } catch { /* frozen bundle — export falls back to the static src pose */ }

  return {
    get bundle()    { return bundle; },
    get overrides() { return overrides; },
    get plan()      { return plan; },
    get t()         { return lastT; },
    // True once the GPU curve-lerp path is active (RGBA32F render target
    // available), false if it fell back to the CPU lerp + upload.
    get usesGpuCurveLerp() { return !!(_ltCurve && _ltCurve.gpu); },
    setT,
    dispose,
  };
}

// ---- Plan construction ---------------------------------------------

/**
 * Categorize each shape in src/dst into matched / src-only / dst-only.
 *
 * Matched: same shapeId (when both ids non-empty) AND same byte count
 * in the curve buffer (a proxy for matched per-shape geometry size —
 * an identical-curve-buffer-length check at the per-shape level).
 *
 * Empty-string ids are matched positionally up to the shorter bundle.
 *
 * Returns:
 *   {
 *     matched:    [{srcIdx, dstIdx, srcBegin, srcEnd, dstBegin, dstEnd}],
 *     srcOnly:    [{srcIdx}],
 *     dstOnly:    [{dstIdx}],
 *     finalShapeCount,
 *   }
 */

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// ── Internal surface for the no-WebGL fallback ─────────────────────────
// The pure-CPU pieces of the morph (no gl): plan building, section
// composition, sprite-range resolution, and the visibility driver. The
// native morph reuses them so the matching/lerp logic has a single source
// of truth — it differs only in emitting path `d` instead of uploading the
// lerped curve buffer to a texture. Not part of the public package API.
// New code can import from ../core/morphCore.js directly.
export {
  buildMorphPlan as _morphBuildPlan,
  composeMorphSections as _morphComposeSections,
  resolveSpriteRange as _morphResolveSpriteRange,
  updateVisibility as _morphUpdateVisibility,
} from '../core/morphCore.js';

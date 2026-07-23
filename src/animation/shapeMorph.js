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
import { buildDrawList } from '../renderer/bundle.js';
import { requestOcclusionCull } from '../renderer/occlusionWorkerPool.js';
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
  const prog = gl.createProgram();
  let vs = null, fs = null;
  try {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error('lerpPass: ' + info);
      }
      return s;
    };
    vs = sh(gl.VERTEX_SHADER, '#version 300 es\nlayout(location=0) in vec2 a; out vec2 uv; void main(){ uv = a*0.5+0.5; gl_Position = vec4(a,0.0,1.0); }');
    fs = sh(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; in vec2 uv; uniform highp sampler2D uA, uB; uniform float uT; out vec4 o; void main(){ o = mix(texture(uA, uv), texture(uB, uv), uT); }');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('lerpPass link: ' + gl.getProgramInfoLog(prog));
  } catch (error) {
    gl.deleteProgram(prog);
    throw error;
  } finally {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
  }
  const vao = gl.createVertexArray();
  const vb = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);  // fullscreen tri
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  p = { prog, vao, vb, users: 0, uA: gl.getUniformLocation(prog, 'uA'), uB: gl.getUniformLocation(prog, 'uB'), uT: gl.getUniformLocation(prog, 'uT') };
  _lerpPassByGl.set(gl, p);
  return p;
}

function releaseLerpPass(gl, p) {
  if (!p || --p.users > 0) return;
  gl.deleteProgram(p.prog);
  gl.deleteVertexArray(p.vao);
  gl.deleteBuffer(p.vb);
  _lerpPassByGl.delete(gl);
}

// ── Curve-plane FIXUP pass (gl-memoized) ───────────────────────────────────
//
// The plain mix() above is wrong for exactly two kinds of texel, and both are
// wrong for the same reason: they hold a quantity that is not a linear function
// of the geometry, so interpolating it does not interpolate the shape.
//
//   ARC data texels — the plane feeds the lerp arcs in ENDPOINT form (p1, p4,
//     rx, ry, phi, flags), the only exact form whose componentwise lerp keeps an
//     arc's endpoints welded to its neighbours' (morphCore.prepareArcMorph). The
//     SHADER, though, ray-casts against CENTRE form. So the mixed endpoint form
//     has to be converted, per frame, before anything reads it.
//   JOIN texels — hold the neighbours' UNIT tangents, which the stroke shader
//     builds its joins and miters from. A lerp of two unit vectors is neither
//     unit nor tangent to the lerped curve; it collapses toward zero as the poses
//     diverge, and the join geometry divides by it (outlines sprout discs and
//     spokes). Tangents must be RECOMPUTED from the lerped geometry.
//
// Both were CPU work, which pinned an arc-bearing morph to a full curve-plane
// re-upload every frame. They needn't be. The key is that this pass does NOT read
// what the mix wrote: it samples the same two STATIC planes and mixes them itself,
// so it has no dependency on pass 1 — no read-after-write on the live texture, no
// ping-pong. It just draws one POINT per texel the mix got wrong and overwrites
// it. Cost is O(arcs + stroked segments) fragments, not O(plane).
const _fixupPassByGl = new WeakMap();

export const FIX_ARC_C = 0;    // write (cx, cy, rx, ry)
export const FIX_ARC_T = 1;    // write (theta_s, theta_e, phi, 0)
export const FIX_JOIN  = 2;    // write (inTan.xy, outTan.xy)

const FIXUP_VS = `#version 300 es
precision highp float; precision highp int;
layout(location=0) in ivec4 aFix;   // (outTexel, kind, argA, argB)
flat out ivec4 vFix;
uniform int uW, uH;
void main() {
  vFix = aFix;
  int i = aFix.x;
  vec2 p = (vec2(float(i % uW), float(i / uW)) + 0.5) / vec2(float(uW), float(uH));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

const FIXUP_FS = `#version 300 es
precision highp float; precision highp int;
flat in ivec4 vFix;
uniform highp sampler2D uA, uB;
uniform float uT;
uniform int uW;
out vec4 o;

// The lerped value of one texel — mixed HERE from the two static planes, which is
// what keeps this pass independent of the mix that already ran.
vec4 fx(int texel) {
  ivec2 c = ivec2(texel % uW, texel / uW);
  return mix(texelFetch(uA, c, 0), texelFetch(uB, c, 0), uT);
}

// SVG F.6.5 endpoint -> centre, including the F.6.6 radii correction. Mid-lerp the
// endpoints move independently of the radii, so the correction genuinely fires —
// and scaling the radii up to span the chord is exactly the right answer when it does.
// Returns (cx, cy, rx, ry) in .xyzw and writes (theta_s, theta_e) to th.
vec4 arcCentre(int hdr, out vec2 th) {
  vec4 d0 = fx(hdr + 1);              // p1.xy, p4.xy
  vec4 d1 = fx(hdr + 2);              // rx, ry, phi, flags
  vec2 p1 = d0.xy, p4 = d0.zw;
  float rx = abs(d1.x), ry = abs(d1.y), phi = d1.z;
  int flags = int(d1.w + 0.5);
  float large = float(flags & 1), sweep = float((flags >> 1) & 1);
  float cp = cos(phi), sp = sin(phi);
  vec2 m = (p1 - p4) * 0.5;
  float x1p =  cp * m.x + sp * m.y;
  float y1p = -sp * m.x + cp * m.y;
  if (rx == 0.0 || ry == 0.0) {
    vec2 chord = p4 - p1;
    float len = length(chord);
    if (len == 0.0) { th = vec2(0.0); return vec4(p1, 0.0, 0.0); }
    vec2 c = (p1 + p4) * 0.5;
    float angle = atan(chord.y, chord.x);
    float t0;
    if (ry == 0.0) { rx = len * 0.5; ry = 0.0; phi = angle; t0 = 3.14159265358979324; }
    else { rx = 0.0; ry = len * 0.5; phi = angle - 1.57079632679489662; t0 = -1.57079632679489662; }
    float dt = sweep > 0.5 ? 3.14159265358979324 : -3.14159265358979324;
    th = vec2(t0, t0 + dt);
    return vec4(c, rx, ry);
  }
  float lam = (x1p / rx) * (x1p / rx) + (y1p / ry) * (y1p / ry);
  if (lam > 1.0) { float s = sqrt(lam); rx *= s; ry *= s; }
  float num = rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p;
  float den = rx*rx*y1p*y1p + ry*ry*x1p*x1p;
  float sq = den > 0.0 ? sqrt(max(num / den, 0.0)) : 0.0;
  if (large == sweep) sq = -sq;
  float cxp =  sq * rx * y1p / ry;
  float cyp = -sq * ry * x1p / rx;
  vec2 c = vec2(cp * cxp - sp * cyp, sp * cxp + cp * cyp) + (p1 + p4) * 0.5;
  vec2 u = vec2((x1p - cxp) / rx, (y1p - cyp) / ry);
  vec2 v = vec2((-x1p - cxp) / rx, (-y1p - cyp) / ry);
  float t0 = atan(u.y, u.x);
  float dt = atan(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y);
  if (sweep < 0.5 && dt > 0.0) dt -= 6.28318530717958647;
  if (sweep > 0.5 && dt < 0.0) dt += 6.28318530717958647;
  th = vec2(t0, t0 + dt);
  return vec4(c, rx, ry);
}

// Unit tangent of the segment whose header is at texel hdr, at its start or end.
// Same derivative conventions (and degenerate fallbacks) as textures.js segTangentAt.
vec2 segTangent(int hdr, bool atStart) {
  int ty = int(fx(hdr).x + 0.5) & 3;
  vec2 d;
  if (ty == 3) {                                  // ARC
    vec2 th; vec4 cr = arcCentre(hdr, th);
    float rx = cr.z, ry = cr.w, phi = fx(hdr + 2).z;
    float t = atStart ? th.x : th.y;
    float dth = th.y - th.x;
    float cp = cos(phi), sp = sin(phi), ct = cos(t), st = sin(t);
    d = vec2((-cp * rx * st - sp * ry * ct) * dth,
             (-sp * rx * st + cp * ry * ct) * dth);
  } else if (ty == 0) {                           // LINE
    vec4 a = fx(hdr + 1);
    d = a.zw - a.xy;
  } else {                                        // QUAD / CUBIC
    vec4 a = fx(hdr + 1), b = fx(hdr + 2);
    vec2 p1 = a.xy, p2 = a.zw, p3 = b.xy, p4 = b.zw;
    float u = atStart ? 0.0 : 1.0, mu = 1.0 - u;
    if (ty == 1) {
      d = 2.0 * mu * (p2 - p1) + 2.0 * u * (p3 - p2);
      if (length(d) < 1e-9) d = p3 - p1;
    } else {
      d = 3.0*mu*mu*(p2-p1) + 6.0*mu*u*(p3-p2) + 3.0*u*u*(p4-p3);
      if (length(d) < 1e-9) { d = p3 - p2; if (length(d) < 1e-9) d = p4 - p1; }
    }
  }
  float m = length(d);
  return m < 1e-12 ? vec2(0.0) : d / m;
}

void main() {
  int kind = vFix.y;
  if (kind == ${FIX_JOIN}) {
    vec2 inT  = vFix.z >= 0 ? segTangent(vFix.z, false) : vec2(0.0);
    vec2 outT = vFix.w >= 0 ? segTangent(vFix.w, true)  : vec2(0.0);
    o = vec4(inT, outT);
  } else {
    vec2 th; vec4 cr = arcCentre(vFix.z, th);
    o = (kind == ${FIX_ARC_C}) ? cr : vec4(th, fx(vFix.z + 2).z, 0.0);
  }
}`;

function getFixupPass(gl) {
  let p = _fixupPassByGl.get(gl);
  if (p) return p;
  const prog = gl.createProgram();
  let vs = null, fs = null;
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error('fixupPass: ' + info);
    }
    return s;
  };
  try {
    vs = sh(gl.VERTEX_SHADER, FIXUP_VS);
    fs = sh(gl.FRAGMENT_SHADER, FIXUP_FS);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('fixupPass link: ' + gl.getProgramInfoLog(prog));
  } catch (error) {
    gl.deleteProgram(prog);
    throw error;
  } finally {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
  }
  p = {
    prog, users: 0,
    uA: gl.getUniformLocation(prog, 'uA'), uB: gl.getUniformLocation(prog, 'uB'),
    uT: gl.getUniformLocation(prog, 'uT'),
    uW: gl.getUniformLocation(prog, 'uW'), uH: gl.getUniformLocation(prog, 'uH'),
  };
  _fixupPassByGl.set(gl, p);
  return p;
}

function releaseFixupPass(gl, p) {
  if (!p || --p.users > 0) return;
  gl.deleteProgram(p.prog);
  _fixupPassByGl.delete(gl);
}

// Pure (gl-free) morph machinery lives in the core so the no-WebGL
// fallback can reuse it without importing this GL module.
import {
  resolveSpriteRange,
  buildMorphPlan,
  composeMorphSections,
  resetVisibility,
  updateVisibility,
  arcRecordToCenter,
  rebuildJoinTangents,
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

// Float-render-target completeness is a CONTEXT capability (constant once RGBA32F
// is known color-renderable), but checkFramebufferStatus is a sync driver query
// (~ms each on Metal). Cache the verdict per (gl, internalFormat) so buildLerpTarget
// pays it ONCE, not per morph — a road of N morphs was ~0.5s of redundant checks.
const _floatFboOk = new WeakMap();   // gl → Map(internalFormat → boolean)

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
  // The STATIC cull must not run here: it decides what is hidden from the geometry as
  // authored, and these sections are only the t=0 pose — setT lerps every control
  // point, so a shape buried at t=0 can be fully exposed at t=1. The morph gets its
  // own cull instead (below), which decides containment across the WHOLE animation.
  // Recolour is a BUNDLE property, and a morph INHERITS it from its poses: content
  // that is recoloured at t=0 and t=1 is recoloured at every t between. The morph
  // bundle is rebuilt on each bracket transition, so without this the fill variant
  // would be re-derived — and self-healed, mid-play — on every new bracket.
  const recolor = !!((srcBundle && srcBundle.recolor) || (dstBundle && dstBundle.recolor));
  const bundle = createBundle(gl, sections, { occlusionCull: false, recolor });
  // No-AA (band-hard) eligibility for a stroke-covered morph: the covering stroke hides the fill's
  // AA band throughout the morph, so band-hard fits (the per-frame band the fill pass already
  // rebuilds carries it — no extra cost). Require BOTH endpoints covered, else the fill edge shows
  // mid-morph. Do not rebuild the GWN tree per frame; cubic and arc morphs use
  // band-hard only at low segment counts, otherwise AAC.
  if (srcBundle && dstBundle && srcBundle.noAaFill && dstBundle.noAaFill) {
    bundle.noAaFill = true;
    bundle.minStrokeEmW = Math.min(srcBundle.minStrokeEmW || 0, dstBundle.minStrokeEmW || 0) || (srcBundle.minStrokeEmW || dstBundle.minStrokeEmW || 0);
  }

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
  bundle._morphSrc = {
    mergedCurveF32: sections._mergedCurveF32,
    dstCurveF32: sections._dstCurveF32,
    // Endpoint-form planes for arc-bearing morphs (centre-form lerp tears the
    // contour). Hit tests use these the same way setT's CPU lerp does.
    srcEpCurveF32: sections._srcEpCurveF32 || null,
    dstEpCurveF32: sections._dstEpCurveF32 || null,
    arcOffsets: sections._arcOffsets || null,
    joinTable: sections._joinTable || null,
    curveRanges: _morphCurveRanges,
    mergedMetaF32: sections._mergedMetaF32,
    dstMetaF32: sections._dstAlignedMetaF32,
    metaStride: sections._metaStride,
    matchedSrcIdxs: sections._matchedSrcIdxs || null,
    // Arcs do NOT disqualify this route. It reads the two CENTRE-form planes,
    // decodes each pose's contours exactly, and lerps the resulting MESH
    // VERTICES — it never interpolates arc PARAMETERS, so it has none of the
    // trouble that forces setT's own lerp into endpoint form (prepareArcMorph).
    matchedAll: plan.matched.length === (bundle.numShapes | 0),
    t: 0,
    skipUploads: false,
  };
  // So hit tests can honor fade-in/out without the caller threading overrides.
  try {
    Object.defineProperty(bundle, '_morphOverrides', {
      value: null, enumerable: false, configurable: true, writable: true,
    });
  } catch { /* ignore */ }

  // 2b. MORPH OCCLUSION CULL, off the main thread. A shape a later opaque shape hides
  //     for the WHOLE morph is never seen, so drawing it only costs — and, along a
  //     shared edge, conflates its colour into the antialiased boundary exactly as in
  //     the static case. Endpoint testing would be UNSOUND (an occluder can shrink
  //     faster than what it hides and expose it midway), so morphCull.js eliminates t
  //     analytically and certifies that the boundaries never cross for ANY t. Anything
  //     it cannot certify keeps its draw. Landing late is harmless: until then the
  //     morph simply draws a few shapes nobody can see.
  requestOcclusionCull(
    {
      cv: sections._mergedCurveF32, cv1: sections._dstCurveF32,   // cv1 ⇒ a morph job
      meta: sections._mergedMetaF32, meta1: sections._dstAlignedMetaF32,
      n: bundle.numShapes | 0, stride: sections._metaStride | 0,
      ranges: _morphCurveRanges,
    },
    (culled) => {
      if (bundle._disposed || !culled || !culled.length) return;
      const set = new Set(culled);
      bundle._culledShapes = set;
      bundle.drawList = buildDrawList(bundle.metaFloats, bundle.numShapes,
                                      bundle.metaFloatsPerShape, bundle.chunkByShape,
                                      bundle.filterGraphs, set);
      bundle._lbCombined = null;    // the analytic route caches one combined VBO off the list
    },
  );

  // 3. Private override table for fade-in / fade-out. Initial state
  //    matches t = 0: src + matched fully visible, dst-only invisible.
  const overrides = createOverrideTable(gl, bundle);
  resetVisibility(overrides, plan, /* t = */ 0);
  bundle._morphOverrides = overrides;

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
  let _lerpPass = null, _fixupPass = null;
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
    // Completeness is constant per (context, format) — check once, cache the verdict.
    let fboCache = _floatFboOk.get(gl);
    if (!fboCache) { fboCache = new Map(); _floatFboOk.set(gl, fboCache); }
    let ok = fboCache.get(internal);
    if (ok === undefined) { ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE; fboCache.set(internal, ok); }
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
    if (!_lerpPass) { _lerpPass = lp; lp.users++; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, tgt.fbo);
    gl.viewport(0, 0, tgt.W, tgt.H);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(lp.prog);
    gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_2D, tgt.srcTex); gl.uniform1i(lp.uA, 14);
    gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, tgt.dstTex); gl.uniform1i(lp.uB, 15);
    gl.uniform1f(lp.uT, t);
    gl.bindVertexArray(lp.vao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    // Pass 2: overwrite the texels the plain mix cannot get right — arc data
    // (endpoint form -> centre form) and stroke join tangents (recomputed from
    // the lerped geometry). Same FBO, same t, but it re-mixes from the STATIC
    // planes rather than reading what pass 1 just wrote, so the two passes are
    // independent and no ping-pong is needed.
    if (tgt.fix && tgt.fix.count) {
      const fp = getFixupPass(gl);
      if (!_fixupPass) { _fixupPass = fp; fp.users++; }
      gl.useProgram(fp.prog);
      gl.activeTexture(gl.TEXTURE14); gl.bindTexture(gl.TEXTURE_2D, tgt.srcTex); gl.uniform1i(fp.uA, 14);
      gl.activeTexture(gl.TEXTURE15); gl.bindTexture(gl.TEXTURE_2D, tgt.dstTex); gl.uniform1i(fp.uB, 15);
      gl.uniform1f(fp.uT, t);
      gl.uniform1i(fp.uW, tgt.W); gl.uniform1i(fp.uH, tgt.H);
      gl.bindVertexArray(tgt.fix.vao);
      gl.drawArrays(gl.POINTS, 0, tgt.fix.count);
      gl.bindVertexArray(null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.activeTexture(gl.TEXTURE0);
  }

  /** One point per texel the mix gets wrong. Attributes are (outTexel, kind,
   *  argA, argB): for an arc, argA is its record's HEADER texel; for a join,
   *  argA/argB are the previous/next segments' header texels (-1 = free end). */
  function buildFixupPoints(arcOffsets, joinTable) {
    const nArc = arcOffsets ? arcOffsets.length : 0;
    const nJoin = joinTable ? joinTable.length / 6 : 0;
    if (!nArc && !nJoin) return null;
    const a = new Int32Array((nArc * 2 + nJoin) * 4);
    let k = 0;
    for (let i = 0; i < nArc; i++) {
      const hdr = arcOffsets[i] >> 2;                    // float offset -> texel
      a[k++] = hdr + 1; a[k++] = FIX_ARC_C; a[k++] = hdr; a[k++] = 0;
      a[k++] = hdr + 2; a[k++] = FIX_ARC_T; a[k++] = hdr; a[k++] = 0;
    }
    for (let i = 0; i < nJoin; i++) {
      // Row 0 is already the JOIN texel's float slot (buildJoinTable resolved the
      // line-vs-rest record-size difference); prev/next are HEADER float offsets.
      const prev = joinTable[i * 6 + 2];
      const next = joinTable[i * 6 + 4];
      a[k++] = joinTable[i * 6] >> 2;
      a[k++] = FIX_JOIN;
      a[k++] = prev < 0 ? -1 : prev >> 2;
      a[k++] = next < 0 ? -1 : next >> 2;
    }
    const vao = gl.createVertexArray();
    const vb = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, a, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 4, gl.INT, 0, 0);
    gl.bindVertexArray(null);
    return { vao, vb, count: nArc * 2 + nJoin };
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
        const W = sections._curveW, H = sections._curveH;
        // An arc-bearing morph interpolates the ENDPOINT-form planes, not the
        // centre-form ones: a componentwise lerp of centre form pulls an arc's
        // endpoints off the contour and the fill tears (morphCore.prepareArcMorph).
        // Stroked segments likewise carry their neighbours' UNIT tangents in the
        // join texel, and a lerp of two unit vectors is neither unit nor tangent
        // to the lerped curve (buildJoinTable).
        //
        // Neither is fatal to the GPU route: both are repaired by the FIXUP pass,
        // which re-mixes the two static planes itself and overwrites just those
        // texels (see getFixupPass). So the mix stays on the GPU, and the CPU
        // closure below is only the fallback for contexts with no float FBO.
        const arcs = sections._arcOffsets;
        const joins = sections._joinTable;
        const hasArcs = !!(arcs && arcs.length);
        const hasJoins = !!(joins && joins.length);
        const merged = hasArcs ? sections._srcEpCurveF32 : sections._mergedCurveF32;
        const dstPlane = hasArcs ? sections._dstEpCurveF32 : sections._dstCurveF32;
        const t1 = merged.slice();
        for (const m of plan.matched) t1.set(dstPlane.subarray(m.srcBegin, m.srcEnd), m.srcBegin);
        const cpuLerp = (tt) => {
          if (!lerpCurves) lerpCurves = new Float32Array(merged.length);
          lerpCurves.set(merged);
          for (const m of plan.matched) { const d = dstPlane.subarray(m.srcBegin, m.srcEnd), s = merged.subarray(m.srcBegin, m.srcEnd), o = lerpCurves.subarray(m.srcBegin, m.srcEnd); for (let i = 0; i < o.length; i++) o[i] = s[i] * (1 - tt) + d[i] * tt; }
          // Endpoint form -> centre form, in place, for every arc the morph carries.
          if (hasArcs) for (let i = 0; i < arcs.length; i++) arcRecordToCenter(lerpCurves, arcs[i]);
          // THEN the joins: an arc's tangent is only defined once it is back in
          // centre form.
          if (hasJoins) rebuildJoinTangents(lerpCurves, joins);
          gl.bindTexture(gl.TEXTURE_2D, bundle.curveTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.FLOAT, lerpCurves); gl.bindTexture(gl.TEXTURE_2D, null);
        };
        _ltCurve = buildLerpTarget(bundle.curveTex, merged, t1, W, H, gl.RGBA32F, gl.RGBA, gl.FLOAT, cpuLerp);
        // The fixup pass rides the GPU route only; the CPU closure does the same
        // repairs itself, in JS.
        if (_ltCurve.gpu) _ltCurve.fix = buildFixupPoints(arcs, joins);
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
    bundle._morphOverrides = null;
    if (bundle && bundle._morphSrc) bundle._morphSrc = null;
    for (const tgt of [_ltCurve, _ltStops, _ltMeta, _ltGrad]) {
      if (tgt && tgt.gpu) { gl.deleteFramebuffer(tgt.fbo); gl.deleteTexture(tgt.srcTex); gl.deleteTexture(tgt.dstTex); }
      if (tgt && tgt.fix) { gl.deleteVertexArray(tgt.fix.vao); gl.deleteBuffer(tgt.fix.vb); }
    }
    releaseLerpPass(gl, _lerpPass);
    releaseFixupPass(gl, _fixupPass);
    _lerpPass = _fixupPass = null;
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

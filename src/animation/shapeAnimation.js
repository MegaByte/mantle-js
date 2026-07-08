// shapeAnimation.js — extensions to createShapeMorph for Lottie /
// Rive / state-machine animation drivers.
//
// `createShapeMorph` is a two-pose curve-buffer lerp. Both formats
// need:
//   - N-key timelines with multiple interpolator kinds
//   - per-vertex spatial-Bezier motion (Lottie)
//   - in-bundle path delta channels (Lottie keyframe deltas)
//   - bone-weighted skinning (Rive non-mesh paths)
//   - 3-pose blend stacks (Rive state-machine transitions)
//
// Each entry point is a driver-layer wrapper that owns one or more
// `createShapeMorph` instances (or one shared curve scratch buffer)
// and reuses the existing `setT` upload path. The renderer-side
// kernel (`texSubImage2D` on `bundle.curveTex`) is unchanged.

import { createShapeMorph, createSpriteMorph } from './shapeMorph.js';
// Timeline bracket/ease helpers live in the gl-free core.
import { timelineBracketAt, timelineEase, updateVisibility } from '../core/morphCore.js';

// ────────────────────────────────────────────────────────────────
// 1) N-key timeline
// ────────────────────────────────────────────────────────────────
//
// Owns N source bundles + a time-ordered keyframe list. Each key
// carries `{ time, bundleIndex, interp }`. At `setTime(seconds)`
// the timeline picks the bracketing keys, computes the local `t`
// according to the interpolator, and either:
//   - hot path: reuses a *single* createShapeMorph if the bracket
//     pair is the same as the previous frame (just calls setT)
//   - cold path: builds a new createShapeMorph for the new
//     bracket pair (bracket transitions only — at typical 60fps
//     animation rates this is once per keyframe, not once per frame)
//
// `bundles`: array of N source bundles (createBundle output)
// `keys`: array of `{ time, bundleIndex, interp }` sorted by time
//   interp ∈ {'linear', 'hold', 'cubicBezier', 'spatialBezier'}
//   For 'cubicBezier' the key also carries
//     `{ outX, outY, inX, inY }` — the temporal-Bezier control
//     points (Lottie shape).
//   For 'spatialBezier' see the createSpatialBezierMorph below;
//   the timeline only stores the marker, the actual sampling lives
//   in the morph instance.
//
// Returns a handle:
//   { setTime(seconds), duration, currentBundle, dispose() }
export function createShapeTimeline(gl, bundles, keys) {
  if (!gl) throw new Error('createShapeTimeline: gl required');
  if (!Array.isArray(bundles) || bundles.length < 1)
    throw new Error('createShapeTimeline: bundles[] must be non-empty');
  if (!Array.isArray(keys) || keys.length < 1)
    throw new Error('createShapeTimeline: keys[] must be non-empty');
  // Validate keys are time-sorted.
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].time < keys[i - 1].time)
      throw new Error('createShapeTimeline: keys must be time-sorted');
  }
  // Validate bundleIndex values reference real bundles.
  for (const k of keys) {
    if (!(k.bundleIndex >= 0 && k.bundleIndex < bundles.length))
      throw new Error(`createShapeTimeline: key bundleIndex ${k.bundleIndex} out of range`);
  }
  const duration = keys[keys.length - 1].time - keys[0].time;
  // Morphs are KEPT for the timeline's whole life, one per bracket pair —
  // flipbooks cycle the same pose pairs forever, and dispose-and-rebuild on
  // every bracket transition re-ran curve matching + pair-mesh builds each
  // switch (the pose-storm class). N keys → at most N-1
  // cached pairs, built once (lazily on first visit, or by the idle prewarm
  // below) and retuned with setT thereafter.
  const _pairMorphs = new Map();   // 'lo:hi' → createShapeMorph
  let curMorph = null;
  let curSrcIdx = -1, curDstIdx = -1;
  let lastTime = NaN;
  const _morphFor = (loBundle, hiBundle) => {
    const k = loBundle + ':' + hiBundle;
    let m = _pairMorphs.get(k);
    if (!m) { m = createShapeMorph(gl, bundles[loBundle], bundles[hiBundle]); _pairMorphs.set(k, m); }
    return m;
  };

  function setTime(time) {
    if (time === lastTime) return;
    lastTime = time;
    // spatialBezier easing returns linear localT here; the morph instance
    // applies its per-vertex tangents.
    const { iLo, iHi, localT } = timelineBracketAt(keys, time);
    const loBundle = keys[iLo].bundleIndex;
    const hiBundle = keys[iHi].bundleIndex;
    // Hot path: same bracket as last frame → just retune setT.
    if (curMorph && curSrcIdx === loBundle && curDstIdx === hiBundle) {
      curMorph.setT(timelineEase(keys[iLo], localT));
      return;
    }
    curMorph = _morphFor(loBundle, hiBundle);
    curSrcIdx = loBundle;
    curDstIdx = hiBundle;
    curMorph.setT(timelineEase(keys[iLo], localT));
  }

  // Idle PREWARM: construct every consecutive bracket pair once, one per idle
  // tick, so the whole flipbook is ready before playback reaches it. Errors
  // fall back to lazy construction on first visit.
  {
    const pairs = [];
    const seen = new Set();
    for (let i = 0; i + 1 < keys.length; i++) {
      const lo = keys[i].bundleIndex, hi = keys[i + 1].bundleIndex;
      const k = lo + ':' + hi;
      if (lo !== hi && !seen.has(k)) { seen.add(k); pairs.push([lo, hi]); }
    }
    let pi = 0;
    const warm = () => {
      if (pi >= pairs.length) return;
      const [lo, hi] = pairs[pi++];
      try { _morphFor(lo, hi); } catch { }
      if (pi < pairs.length) {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 500 });
        else setTimeout(warm, 0);
      }
    };
    if (pairs.length) {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 500 });
      else setTimeout(warm, 0);
    }
  }

  function dispose() {
    for (const m of _pairMorphs.values()) { try { m.dispose(); } catch { } }
    _pairMorphs.clear();
    curMorph = null;
  }

  return {
    setTime,
    get duration() { return duration; },
    get currentMorph() { return curMorph; },
    get bundle() { return curMorph ? curMorph.bundle : bundles[keys[0].bundleIndex]; },
    dispose,
  };
}

// Bracket + easing helpers (from morphCore):
//   timelineBracketAt: keys[iLo]/keys[iHi] bracket `time`; localT is the
//     un-eased [0..1] within the interval.
//   timelineEase: applies the LO key's departure-side interpolator
//     (linear / hold / cubicBezier) to localT. spatialBezier returns
//     linear localT — the morph instance applies its per-vertex tangents.


/**
 * N-key timeline over SPRITE poses — the sprite analogue of
 * createShapeTimeline. Each key picks a sprite ref (idle → walk → run →
 * jump); adjacent keys are blended with createSpriteMorph + the same
 * linear / hold / cubic-Bezier easing. Sprites may all live in ONE sheet
 * (the common case) or span several.
 *
 *   const tl = createSpriteTimeline(gl,
 *     [ { bundle: sheet, sprite: 'idle' },     // ref 0
 *       { bundle: sheet, sprite: 'run'  },     // ref 1
 *       { bundle: sheet, sprite: 'jump' } ],   // ref 2
 *     [ { time: 0.0, refIndex: 0 },
 *       { time: 0.5, refIndex: 1, interp: 'cubicBezier', outX: .4, inX: .6 },
 *       { time: 1.0, refIndex: 2 } ]);
 *   tl.setTime(t);
 *   renderer.drawBundle(tl.bundle, { worldMatrix });
 *   tl.dispose();
 *
 * @param {WebGL2RenderingContext} gl
 * @param {Array<{bundle:object, sprite:(string|[number,number])}>} refs
 * @param {Array<{time:number, refIndex:number, interp?:string,
 *                outX?:number, outY?:number, inX?:number, inY?:number}>} keys
 */
export function createSpriteTimeline(gl, refs, keys) {
  if (!gl) throw new Error('createSpriteTimeline: gl required');
  if (!Array.isArray(refs) || refs.length < 1)
    throw new Error('createSpriteTimeline: refs[] must be non-empty');
  for (const r of refs) {
    if (!r || !r.bundle || r.sprite === undefined)
      throw new Error('createSpriteTimeline: each ref needs { bundle, sprite }');
  }
  if (!Array.isArray(keys) || keys.length < 1)
    throw new Error('createSpriteTimeline: keys[] must be non-empty');
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].time < keys[i - 1].time)
      throw new Error('createSpriteTimeline: keys must be time-sorted');
  }
  for (const k of keys) {
    if (!(k.refIndex >= 0 && k.refIndex < refs.length))
      throw new Error(`createSpriteTimeline: key refIndex ${k.refIndex} out of range`);
  }
  const duration = keys[keys.length - 1].time - keys[0].time;

  // Cached morph for the current bracket pair (a ref-pair). Rebuilt only
  // when the bracket's (lo, hi) ref indices change — the hot path retunes
  // setT. When lo === hi (before the first / after the last key, or two
  // keys pointing at the SAME ref) there's nothing to morph: we hold that
  // single ref via a degenerate self-morph (createSpriteMorph would reject
  // an overlapping same-bundle pair, so we special-case it to a static
  // single-sprite draw bundle built once).
  // Two kinds of active handle:
  //   • bracketMorph — a createSpriteMorph between two DISTINCT refs, owned
  //     here and disposed when the bracket's ref-pair changes.
  //   • a hold — a static single-sprite handle (lo === hi: clamp regions,
  //     or two keys on the same ref). Cached per ref index in `holds` and
  //     disposed only at dispose().
  // `current` points at whichever is live; `currentIsHold` says which kind.
  let bracketMorph = null;
  const _spritePairs = new Map();   // 'lo:hi' → createSpriteMorph, kept until dispose
  let curLoRef = -1, curHiRef = -1;
  let current = null;
  let lastTime = NaN;
  const holds = new Map();   // refIndex → sprite-morph handle pinned at t=0

  function buildHold(refIdx) {
    let h = holds.get(refIdx);
    if (h) return h;
    // createSpriteMorph needs two distinct sprites. Pair the held ref with
    // any OTHER ref and pin t=0 (= fully the held sprite). With a single
    // ref total, pair it against a shallow bundle clone (distinct object
    // identity sidesteps the same-bundle overlap guard) at the same range.
    const self = refs[refIdx];
    let other = -1;
    for (let i = 0; i < refs.length; i++) if (i !== refIdx) { other = i; break; }
    const dstRef = other >= 0
      ? refs[other]
      : { bundle: Object.assign(
            Object.create(Object.getPrototypeOf(self.bundle) || Object.prototype),
            self.bundle),
          sprite: self.sprite };
    h = createSpriteMorph(gl, self, dstRef);
    h.setT(0);
    holds.set(refIdx, h);
    return h;
  }

  function setTime(time) {
    if (time === lastTime) return;
    lastTime = time;
    const { iLo, iHi, localT } = timelineBracketAt(keys, time);
    const loRef = keys[iLo].refIndex;
    const hiRef = keys[iHi].refIndex;

    if (loRef === hiRef) {
      current = buildHold(loRef);
      return;
    }
    // Distinct refs → blend. Reuse the cached bracket morph if the pair
    // is unchanged; otherwise rebuild (disposing the prior bracket morph).
    if (!(bracketMorph && curLoRef === loRef && curHiRef === hiRef)) {
      // KEPT per pair for the timeline's life (same rationale as the shape
      // timeline: flipbooks revisit the same pairs; dispose-and-rebuild ran a
      // sprite-morph construction on every pose transition).
      {
        const k9 = loRef + ':' + hiRef;
        let m9 = _spritePairs.get(k9);
        if (!m9) { m9 = createSpriteMorph(gl, refs[loRef], refs[hiRef]); _spritePairs.set(k9, m9); }
        bracketMorph = m9;
      }
      curLoRef = loRef; curHiRef = hiRef;
    }
    bracketMorph.setT(timelineEase(keys[iLo], localT));
    current = bracketMorph;
  }

  function dispose() {
    for (const m9 of _spritePairs.values()) { try { m9.dispose(); } catch { } }
    _spritePairs.clear();
    bracketMorph = null;
    for (const h of holds.values()) h.dispose();
    holds.clear();
    current = null;
    curLoRef = curHiRef = -1;
  }

  return {
    setTime,
    get duration() { return duration; },
    get currentMorph() { return current; },
    get bundle() { return (current || buildHold(keys[0].refIndex)).bundle; },
    dispose,
  };
}

// ────────────────────────────────────────────────────────────────
// 2) Spatial-Bezier morph
// ────────────────────────────────────────────────────────────────
//
// Lottie/AE animates each vertex along a 2D Bezier trajectory from
// its src pose to its dst pose — not a straight line. The trajectory
// is defined by two control points per vertex: `outTan` (departure
// from src) and `inTan` (arrival at dst). Both are expressed as
// 2D offsets in the same em-space as the curve buffer's positions.
//
// We store the tangents in two parallel buffers the size of one
// shape's curve floats (matched-shape only). At setT, for each
// matched-shape texel pair (srcPos, dstPos) we evaluate
//   P(t) = (1-t)³·src + 3(1-t)²t·(src+outTan) + 3(1-t)t²·(dst-inTan) + t³·dst
//
// `tangents`: { outTan, inTan } — each a Float32Array the same
// length as the source bundle's curveFloats. Set to zero for any
// texel that should use a straight line.
export function createSpatialBezierMorph(gl, srcBundle, dstBundle, tangents) {
  const morph = createShapeMorph(gl, srcBundle, dstBundle);
  if (!tangents || !tangents.outTan || !tangents.inTan)
    throw new Error('createSpatialBezierMorph: tangents.outTan + tangents.inTan required');
  // Replace the morph's linear lerp with a Bezier sample: read the
  // matched ranges from `plan`, re-upload the sampled curve plane to
  // `bundle.curveTex`.
  const plan = morph.plan;
  const src  = srcBundle;
  const dst  = dstBundle;
  const srcF = extractCurveFloats(src);
  const dstF = extractCurveFloats(dst);
  const outTan = tangents.outTan;
  const inTan  = tangents.inTan;
  // Sanity-check sizes — must match the source curve plane.
  if (outTan.length !== srcF.length || inTan.length !== srcF.length)
    throw new Error('createSpatialBezierMorph: tangents must match source curveFloats length');
  // Scratch for evaluation. Reused across setT calls.
  let scratch = null;
  // Pull the curve plane dims out of the morph's bundle (the
  // texture is _curveW × _curveH; we re-derive from the bundle).
  function getCurveDims() {
    const total = srcF.length;
    const TEX_W = 4096;
    const texelsPerRow = TEX_W;
    const floatsPerRow = texelsPerRow * 4;
    const rows = Math.ceil(total / floatsPerRow);
    return { w: TEX_W, h: rows };
  }
  const { w: cw, h: ch } = getCurveDims();

  function setT(t) {
    t = clamp01(t);
    // Size scratch to the PADDED curve plane (cw*ch*4); the upload below
    // covers the full TEX_W×rows region, so an unpadded buffer would
    // throw INVALID_OPERATION on real WebGL2. scratch.set(srcF) fills
    // only the leading floats; the zero tail maps to unused texels.
    if (!scratch) scratch = new Float32Array(cw * ch * 4);
    // Start scratch = src (baseline at t=0).
    scratch.set(srcF);
    const omt = 1 - t;
    const k0 = omt * omt * omt;
    const k1 = 3 * omt * omt * t;
    const k2 = 3 * omt * t * t;
    const k3 = t * t * t;
    for (const m of plan.matched) {
      // For each float i in [m.srcBegin, m.srcEnd) — pair-treat
      // consecutive (x, y) floats as a 2D position and apply the
      // cubic Bezier sample.
      const sB = m.srcBegin, sE = m.srcEnd;
      const dB = m.dstBegin;
      for (let i = sB; i + 1 < sE; i += 2) {
        const sx = srcF[i],     sy = srcF[i + 1];
        const dx = dstF[dB + (i - sB)], dy = dstF[dB + (i - sB) + 1];
        const otx = outTan[i],  oty = outTan[i + 1];
        const itx = inTan[i],   ity = inTan[i + 1];
        // Bezier control points: P0=src, P1=src+outTan, P2=dst-inTan, P3=dst.
        scratch[i]     = k0 * sx + k1 * (sx + otx) + k2 * (dx - itx) + k3 * dx;
        scratch[i + 1] = k0 * sy + k1 * (sy + oty) + k2 * (dy - ity) + k3 * dy;
      }
    }
    // Direct GL upload.
    const tex = morph.bundle.curveTex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cw, ch,
                     gl.RGBA, gl.FLOAT, scratch);
    gl.bindTexture(gl.TEXTURE_2D, null);
    // Drive src-only fade-out / dst-only fade-in. This wrapper replaces
    // the morph's setT wholesale, so without this a non-matched-topology
    // crossfade would freeze at the t=0 state.
    updateVisibility(morph.overrides, plan, t);
  }

  return {
    get bundle()    { return morph.bundle; },
    get plan()      { return morph.plan; },
    get overrides() { return morph.overrides; },
    setT,
    dispose() { morph.dispose(); },
  };
}

// ────────────────────────────────────────────────────────────────
// 3) In-bundle path delta channel
// ────────────────────────────────────────────────────────────────
//
// Lottie keyframes can be stored as DELTAS against a base pose
// rather than as separate full bundles. This saves substantial
// memory at runtime for long animations: 60 keyframes × 10 paths
// × 100 vertices is ~120K floats of base + ~14M floats of deltas
// if you keep N bundles, vs. base + delta floats packed densely.
//
// `createPathDeltaMorph(gl, baseBundle, deltas)`:
//   - baseBundle: a regular createBundle output (the rest pose)
//   - deltas: an array of `{ time, vertexDeltas }` where
//     vertexDeltas is a Float32Array the same length as
//     baseBundle.curveFloats, containing dst - base for the
//     animated texels (zero everywhere the path doesn't move).
//
// At setTime(seconds) we pick the bracketing delta pair and
// evaluate `cur = base + lerp(deltaLo, deltaHi, localT)` into a
// scratch buffer and upload.
export function createPathDeltaMorph(gl, baseBundle, deltas) {
  if (!gl) throw new Error('createPathDeltaMorph: gl required');
  if (!baseBundle) throw new Error('createPathDeltaMorph: baseBundle required');
  if (!Array.isArray(deltas) || deltas.length < 1)
    throw new Error('createPathDeltaMorph: deltas[] required');
  const baseF = extractCurveFloats(baseBundle);
  for (const d of deltas) {
    if (!d.vertexDeltas || d.vertexDeltas.length !== baseF.length)
      throw new Error('createPathDeltaMorph: each delta.vertexDeltas must match baseBundle.curveFloats length');
  }
  // Build the GL bundle from the base — we reuse its curveTex as
  // the upload target.
  // Sort deltas by time defensively.
  const sorted = deltas.slice().sort((a, b) => a.time - b.time);
  const duration = sorted[sorted.length - 1].time - sorted[0].time;
  // Curve plane dims.
  const TEX_W = 4096;
  const floatsPerRow = TEX_W * 4;
  const rows = Math.ceil(baseF.length / floatsPerRow);
  let scratch = null;
  let lastTime = NaN;

  function setTime(time) {
    if (time === lastTime) return;
    lastTime = time;
    // Find the bracketing pair.
    let iLo = 0, iHi = 0, localT = 0;
    if (time <= sorted[0].time) { iLo = iHi = 0; localT = 0; }
    else if (time >= sorted[sorted.length - 1].time) {
      iLo = iHi = sorted.length - 1; localT = 1;
    } else {
      let lo = 0, hi = sorted.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].time <= time) lo = mid; else hi = mid;
      }
      iLo = lo; iHi = hi;
      const dt = sorted[hi].time - sorted[lo].time;
      localT = dt > 0 ? (time - sorted[lo].time) / dt : 0;
    }
    // Pad to the full TEX_W×rows plane the upload covers (an unpadded
    // buffer throws INVALID_OPERATION on real WebGL2); the loop below
    // writes only the leading baseF.length floats, tail stays zero.
    if (!scratch) scratch = new Float32Array(floatsPerRow * rows);
    const dLo = sorted[iLo].vertexDeltas;
    const dHi = sorted[iHi].vertexDeltas;
    const omt = 1 - localT;
    for (let i = 0; i < baseF.length; i++) {
      scratch[i] = baseF[i] + dLo[i] * omt + dHi[i] * localT;
    }
    // Upload.
    const tex = baseBundle.curveTex;
    if (!tex) return;   // bundle wasn't materialized to GL yet
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, rows,
                     gl.RGBA, gl.FLOAT, scratch);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  function dispose() {
    // We don't own the bundle (caller created it). Drop scratch.
    scratch = null;
  }

  return {
    get bundle() { return baseBundle; },
    get duration() { return duration; },
    setTime, dispose,
  };
}

// ────────────────────────────────────────────────────────────────
// 4) Bone skinning for non-mesh paths
// ────────────────────────────────────────────────────────────────
//
// Rive `RenderPathDeformer` + `PointDeformer`. Each curve-buffer
// texel pair (x, y) is associated with one or more bones via a
// weights table:
//   weights[i] = [{ boneId, weight }, ...]   for vertex i
//
// At setBoneMatrices(matrices), we rewrite curve texels:
//   newPos = Σ w_b · (M_b · restPos)   over each (boneId=b, weight=w_b)
//
// Matrix layout: each 2D affine is [m00, m01, m10, m11, tx, ty]
// (6 floats per bone, row-major 2×2 + translate).
//
// `baseBundle`: rest pose (createBundle output)
// `boneWeights`: an array of length (baseBundle.curveFloats.length / 2)
//   — one entry per vertex (each entry = sequential pair of floats).
//   Each entry is itself an array of `{ boneId, weight }`. Empty
//   arrays / null entries mean "no skinning, leave at rest pos".
export function createSkinnedMorph(gl, baseBundle, boneWeights) {
  if (!gl) throw new Error('createSkinnedMorph: gl required');
  if (!baseBundle) throw new Error('createSkinnedMorph: baseBundle required');
  if (!Array.isArray(boneWeights))
    throw new Error('createSkinnedMorph: boneWeights must be an array');
  const baseF = extractCurveFloats(baseBundle);
  const nVerts = baseF.length >>> 1;
  if (boneWeights.length !== nVerts)
    throw new Error(`createSkinnedMorph: boneWeights.length ${boneWeights.length} must equal vertex count ${nVerts}`);
  const TEX_W = 4096;
  const floatsPerRow = TEX_W * 4;
  const rows = Math.ceil(baseF.length / floatsPerRow);
  let scratch = null;

  function setBoneMatrices(matrices) {
    // matrices: flat Float32Array of (numBones × 6) — [m00,m01,m10,m11,tx,ty] per bone.
    if (!matrices) return;
    // Pad to the full TEX_W×rows plane the upload covers (unpadded would
    // throw INVALID_OPERATION on real WebGL2); set(baseF) fills only the
    // leading floats, tail stays zero.
    if (!scratch) scratch = new Float32Array(floatsPerRow * rows);
    scratch.set(baseF);
    for (let v = 0; v < nVerts; v++) {
      const ws = boneWeights[v];
      if (!ws || ws.length === 0) continue;   // leave at rest
      const restX = baseF[v * 2];
      const restY = baseF[v * 2 + 1];
      let outX = 0, outY = 0;
      for (let k = 0; k < ws.length; k++) {
        const { boneId, weight } = ws[k];
        const off = boneId * 6;
        const m00 = matrices[off],     m01 = matrices[off + 1];
        const m10 = matrices[off + 2], m11 = matrices[off + 3];
        const tx  = matrices[off + 4], ty  = matrices[off + 5];
        const wx = m00 * restX + m01 * restY + tx;
        const wy = m10 * restX + m11 * restY + ty;
        outX += weight * wx;
        outY += weight * wy;
      }
      scratch[v * 2]     = outX;
      scratch[v * 2 + 1] = outY;
    }
    // Upload.
    const tex = baseBundle.curveTex;
    if (!tex) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, rows,
                     gl.RGBA, gl.FLOAT, scratch);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  function dispose() { scratch = null; }

  return {
    get bundle() { return baseBundle; },
    get numVertices() { return nVerts; },
    setBoneMatrices, dispose,
  };
}

// ────────────────────────────────────────────────────────────────
// 5) 3-pose state-machine blend stack
// ────────────────────────────────────────────────────────────────
//
// Rive state machines transition between named poses. During a
// transition, the renderer needs to evaluate
//   visible = (1-tt) · prevPose + tt · curPose
// where `prevPose` is itself the result of a possibly-in-flight
// transition. A 3-pose stack covers transitions-during-transitions:
//
//   final = baseA + lerp(baseA→baseB, midT) + lerp(midResult→baseC, outT)
//
// In practice 2 levels of nesting is enough for shipped Rive
// content; deeper nesting either snaps to the deepest target or
// accepts visual popping (matching the Rive runtime's own
// behavior). We expose a 3-pose blend explicitly.
//
// `bundles`: array of N bundles (named).
// State: poseA / poseB / poseC indices + tAB / tBC weights.
//   At rest: poseA = current, poseB = poseA, tAB = 0.
//   Transition start: set poseB = target, tAB animates 0→1.
//   Pre-empted transition: poseC = new target, tBC animates 0→1.
//   When tBC hits 1, demote: poseA = poseC, poseB = poseC, tAB = 0.
export function createPoseStack(gl, bundles) {
  if (!gl) throw new Error('createPoseStack: gl required');
  if (!Array.isArray(bundles) || bundles.length < 1)
    throw new Error('createPoseStack: bundles[] required');
  let poseA = 0, poseB = 0, poseC = 0;
  let tAB = 0, tBC = 0;
  // Cached morphs.
  let morphAB = null, morphBC = null;
  let cachedABKey = '', cachedBCKey = '';

  function ensureMorph(slot, srcIdx, dstIdx) {
    const key = `${srcIdx}|${dstIdx}`;
    if (slot === 'AB') {
      if (cachedABKey !== key) {
        if (morphAB) morphAB.dispose();
        morphAB = createShapeMorph(gl, bundles[srcIdx], bundles[dstIdx]);
        cachedABKey = key;
      }
      return morphAB;
    } else {
      if (cachedBCKey !== key) {
        if (morphBC) morphBC.dispose();
        morphBC = createShapeMorph(gl, bundles[srcIdx], bundles[dstIdx]);
        cachedBCKey = key;
      }
      return morphBC;
    }
  }

  // setState applies the blend math and uploads to GL via the
  // outermost morph (morphBC if it exists, else morphAB).
  function setState({ a = poseA, b = poseB, c = poseC, tAB: nTAB = tAB, tBC: nTBC = tBC }) {
    poseA = a; poseB = b; poseC = c;
    tAB = clamp01(nTAB); tBC = clamp01(nTBC);
    // 2-level fast path: if tBC == 0 (no preempting transition),
    // just use morphAB with t=tAB.
    if (tBC === 0 || poseC === poseB) {
      const m = ensureMorph('AB', poseA, poseB);
      m.setT(tAB);
      return;
    }
    // Real 3-pose blend. Each morph's bundle is independent, so we can't
    // compose them at the GL level; instead:
    //   1. Compute A↔B blended curveFloats into a CPU scratch.
    //   2. Lerp that scratch toward C's curveFloats by tBC.
    //   3. Upload into the morphBC bundle's curveTex.
    const baseAF = extractCurveFloats(bundles[poseA]);
    const baseBF = extractCurveFloats(bundles[poseB]);
    const baseCF = extractCurveFloats(bundles[poseC]);
    // Pick smallest curveFloats length so we don't read past
    // either source. Matched-topology assumption — for mismatched
    // counts, fall back to morphAB only (visibility fade handles
    // the rest).
    const n = Math.min(baseAF.length, baseBF.length, baseCF.length);
    const TEX_W = 4096;
    const rows = Math.ceil(n / (TEX_W * 4));
    const padded = TEX_W * rows * 4;
    // Size to the full plane the upload covers (an unpadded source view
    // throws INVALID_OPERATION on real WebGL2); leading n floats are the
    // blended pose, texels past n are unused capacity padding.
    if (!_stackScratch || _stackScratch.length < padded)
      _stackScratch = new Float32Array(padded);
    const ab1 = 1 - tAB, bc1 = 1 - tBC;
    for (let i = 0; i < n; i++) {
      const ab = baseAF[i] * ab1 + baseBF[i] * tAB;
      _stackScratch[i] = ab * bc1 + baseCF[i] * tBC;
    }
    // Use morphBC's bundle as the upload target (its sections / bands /
    // curveGeom cover the C pose, the visually dominant one when tBC>0).
    const m = ensureMorph('BC', poseB, poseC);
    const tex = m.bundle.curveTex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, rows,
                     gl.RGBA, gl.FLOAT, _stackScratch.subarray(0, padded));
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  let _stackScratch = null;

  function bundle() {
    // Outermost active morph's bundle is the renderable; falls
    // back to morphAB and then to bundles[poseA].
    if (tBC > 0 && morphBC) return morphBC.bundle;
    if (morphAB) return morphAB.bundle;
    return bundles[poseA];
  }

  function dispose() {
    if (morphAB) morphAB.dispose();
    if (morphBC) morphBC.dispose();
    morphAB = morphBC = null;
    _stackScratch = null;
  }

  return {
    setState,
    get poseA() { return poseA; },
    get poseB() { return poseB; },
    get poseC() { return poseC; },
    get tAB()   { return tAB; },
    get tBC()   { return tBC; },
    get bundle(){ return bundle(); },
    dispose,
  };
}

// ────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────
function extractCurveFloats(bundle) {
  if (bundle.curveFloats instanceof Float32Array) return bundle.curveFloats;
  if (bundle.curveTexels instanceof Float32Array) return bundle.curveTexels;
  if (bundle._mergedCurveF32 instanceof Float32Array) return bundle._mergedCurveF32;
  if (bundle.curves && bundle.curves.byteLength) return new Float32Array(bundle.curves);
  return new Float32Array(0);
}

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

// Internal surface for the no-WebGL fallback: the pure-CPU timeline
// bracket + easing helpers. Not public package API.
export {
  timelineBracketAt as _timelineBracketAt,
  timelineEase as _timelineEase,
} from '../core/morphCore.js';

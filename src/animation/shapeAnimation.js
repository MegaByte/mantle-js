// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
// Driven poses rebuild current geometry and CPU query data from semantic curve
// fields. Timeline pairs retain the ordinary GPU morph path.

import { curvePoseLayout, adoptCurvePose, sampleDrivenPaint } from './currentCurvePose.js';
import { createShapeMorph, createSpriteMorph } from './shapeMorph.js';
import { checkedSpriteBounds, ownSpriteRange } from '../core/spriteRange.js';
import { unwrapBundle } from '../core/unwrapBundle.js';
// Timeline bracket/ease helpers live in the gl-free core.
import {
  timelineBracketAt,
  timelineEase,
  updateVisibility,
  arcRecordToCenter,
  applyArcFlagSteps,
  restoreArcEndPoses,
  prepareDrivenArcMorph,
} from '../core/morphCore.js';

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
//     points (Lottie shape). outX and inX are clamped to [0, 1] (CSS and
//     Lottie require it; outside it x(t) is not monotone); outY and inY may overshoot.
//   For 'spatialBezier' see the createSpatialBezierMorph below;
//   the timeline only stores the marker, the actual sampling lives
//   in the morph instance.
//
// Returns a handle:
//   { setTime(seconds), duration, currentBundle, dispose() }
/// PAIR MORPHS ARE SHARED (per GL context): every timeline over the same two pose bundles uses ONE morph of them. A scene that made each of its sprites a
/// timeline over the same 40 poses had each build its own 31 pair morphs (~4 MB each, per sprite on screen). A timeline holds one reference per pair;
/// the morph is disposed with its last user. Each user draws its own pose: drawBundle(timeline.bundle, { morphT: timeline.t }) applies it at the draw.
const _sharedPairs = new WeakMap(); // gl -> WeakMap(source pose -> Map(destination pose -> { morph, refs }))
/// A timeline's arc options change the morph, so a pair is shared only between timelines that agree on them: a second key under the destination.
const pairOptionKey = (opts) =>
  (opts && opts.compat === 'chrome' ? 'c' : '') +
  (opts && opts.arcRotation === 'shortest' ? 's' : '');
function acquirePair(gl, a, b, opts) {
  let byGl = _sharedPairs.get(gl);
  if (!byGl) _sharedPairs.set(gl, (byGl = new WeakMap()));
  let byA = byGl.get(a);
  if (!byA) byGl.set(a, (byA = new Map()));
  const optKey = pairOptionKey(opts);
  let byOpt = byA.get(b);
  if (!byOpt) byA.set(b, (byOpt = new Map()));
  let e = byOpt.get(optKey);
  if (!e) {
    e = {
      morph: createShapeMorph(
        gl,
        a,
        b,
        optKey ? { compat: opts.compat, arcRotation: opts.arcRotation } : undefined,
      ),
      refs: 0,
      a,
      b,
      optKey,
    };
    byOpt.set(optKey, e);
    // (its draw states are its poses': a renderer's declared reach for the two poses covers the morph -- warmNeeds bundleTags)
    if (e.morph.bundle)
      Object.defineProperty(e.morph.bundle, '_reachPoses', {
        value: [new WeakRef(a), new WeakRef(b)],
        configurable: true,
        enumerable: false,
      });
    // (and its name, for the debug records -- playBuildWhy, standInWhy, getMemoryStats rows: read when asked, the app may label a pose after the timeline exists)
    if (e.morph.bundle && !('debugLabel' in e.morph.bundle))
      Object.defineProperty(e.morph.bundle, 'debugLabel', {
        get: () => 'pair:' + (a.debugLabel || '?') + '>' + (b.debugLabel || '?'),
        set(v) {
          Object.defineProperty(this, 'debugLabel', {
            value: v,
            writable: true,
            configurable: true,
            enumerable: false,
          });
        },
        configurable: true,
        enumerable: false,
      });
  }
  e.refs++;
  return e;
}
function releasePair(gl, e) {
  if (--e.refs > 0) return;
  const { a, b, optKey } = e;
  const byA = _sharedPairs.get(gl) && _sharedPairs.get(gl).get(a);
  const byOpt = byA && byA.get(b);
  if (byOpt && byOpt.get(optKey) === e) {
    byOpt.delete(optKey);
    if (!byOpt.size) byA.delete(b);
  }
  try {
    e.morph.dispose();
  } catch {
    /* already gone */
  }
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {any[]} bundles the poses
 * @param {any[]} keys `{ time, bundleIndex, interp }`, sorted by time
 * @param {{compat?: 'spec'|'chrome', arcRotation?: 'spec'|'shortest'}} [opts] Every bracket's morph takes them (createShapeMorph). Timelines over the same poses share a pair morph only when these agree.
 */
export function createShapeTimeline(gl, bundles, keys, opts) {
  if (!gl) throw new Error('createShapeTimeline: gl required');
  if (!Array.isArray(bundles) || bundles.length < 1)
    throw new Error('createShapeTimeline: bundles[] must be non-empty');
  if (!Array.isArray(keys) || keys.length < 1)
    throw new Error('createShapeTimeline: keys[] must be non-empty');
  // Validate keys are time-sorted.
  for (let i = 0; i < keys.length; i++) {
    if (!Number.isFinite(keys[i].time))
      throw new Error('createShapeTimeline: key times must be finite numbers');
    if (i > 0 && keys[i].time < keys[i - 1].time)
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
  // every bracket transition would re-run curve matching + pair-mesh builds
  // each switch. N keys → at most N-1
  // pairs, referenced at creation (below) from the context's SHARED pair morphs (see acquirePair) and retuned with setT thereafter.
  const _pairs = new Map(); // 'lo:hi' → { morph, refs } (one reference held by this timeline)
  let curMorph = null,
    curT = 0;
  let curSrcIdx = -1,
    curDstIdx = -1;
  let lastTime = NaN;
  let disposed = false;
  const _morphFor = (loBundle, hiBundle) => {
    const k = loBundle + ':' + hiBundle;
    let e = _pairs.get(k);
    if (!e) {
      e = acquirePair(gl, bundles[loBundle], bundles[hiBundle], opts);
      _pairs.set(k, e);
    }
    return e.morph;
  };

  function setTime(time) {
    if (disposed) return;
    time = +time;
    if (time !== time) time = keys[0].time; // NaN reads as the first key, as setT(NaN) reads as 0
    if (time === lastTime) {
      // (the time is this timeline's, the morph is shared: another timeline may have moved it since, and a draw right after this call must see this pose)
      const src = curMorph && curMorph.bundle && curMorph.bundle._morphSrc;
      if (src && src.t !== curT) curMorph.setT(curT);
      return;
    }
    lastTime = time;
    // spatialBezier easing returns linear localT here; the morph instance
    // applies its per-vertex tangents.
    const { iLo, iHi, localT } = timelineBracketAt(keys, time);
    const loBundle = keys[iLo].bundleIndex;
    const hiBundle = keys[iHi].bundleIndex;
    // Hot path: same bracket as last frame → just retune setT.
    // (setT here as well: a timeline drawn without `morphT` -- its only user -- draws the pose of its last setTime)
    if (curMorph && curSrcIdx === loBundle && curDstIdx === hiBundle) {
      curT = timelineEase(keys[iLo], localT);
      curMorph.setT(curT);
      return;
    }
    curMorph = _morphFor(loBundle, hiBundle);
    curSrcIdx = loBundle;
    curDstIdx = hiBundle;
    curT = timelineEase(keys[iLo], localT);
    curMorph.setT(curT);
  }

  // every PAIR IS BUILT HERE, like a static bundle's geometry at createBundle: the timeline's content is known at creation, so its pair morphs exist (and are in
  // the loading call's warm image) before anything draws. Built on first visit, or by an idle prewarm a busy loading page never runs, the pairs past the
  // first would be new bundles in play with programs never warmed.
  // Exactly the brackets setTime can reach (timelineBracketAt): every consecutive pair, a hold of one pose too, and the first and last keys held (before
  // the first key, past the last). The last hold is built here too, or a timeline would build it in play when it reaches its end.
  try {
    _morphFor(keys[0].bundleIndex, keys[0].bundleIndex);
    for (let i = 0; i + 1 < keys.length; i++)
      _morphFor(keys[i].bundleIndex, keys[i + 1].bundleIndex);
    _morphFor(keys[keys.length - 1].bundleIndex, keys[keys.length - 1].bundleIndex);
  } catch (err) {
    for (const e of _pairs.values()) releasePair(gl, e); // (a pair that cannot be built: the caller gets no timeline to dispose, so the references taken so far go here)
    throw err;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const e of _pairs.values()) releasePair(gl, e); // (through the entry: `bundles` is the caller's array, which it may have changed since)
    _pairs.clear();
    curMorph = null;
  }

  return {
    setTime,
    get duration() {
      return duration;
    },
    get currentMorph() {
      return curMorph;
    },
    get bundle() {
      return curMorph ? curMorph.bundle : bundles[keys[0].bundleIndex];
    },
    /// This timeline's pose on its current pair morph (draw it with drawBundle(bundle, { morphT: t }): the morph is shared), or null before any pair.
    get t() {
      return curMorph ? curT : null;
    },
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
 * @param {{compat?: 'spec'|'chrome', arcRotation?: 'spec'|'shortest'}} [opts] Every bracket's morph takes them (createShapeMorph).
 */
export function createSpriteTimeline(gl, refs, keys, opts) {
  if (!gl) throw new Error('createSpriteTimeline: gl required');
  if (!Array.isArray(refs) || refs.length < 1)
    throw new Error('createSpriteTimeline: refs[] must be non-empty');
  for (const r of refs) {
    if (!r || !r.bundle || r.sprite === undefined)
      throw new Error('createSpriteTimeline: each ref needs { bundle, sprite }');
  }
  if (!Array.isArray(keys) || keys.length < 1)
    throw new Error('createSpriteTimeline: keys[] must be non-empty');
  for (let i = 0; i < keys.length; i++) {
    if (!Number.isFinite(keys[i].time))
      throw new Error('createSpriteTimeline: key times must be finite numbers');
    if (i > 0 && keys[i].time < keys[i - 1].time)
      throw new Error('createSpriteTimeline: keys must be time-sorted');
  }
  for (const k of keys) {
    if (!(k.refIndex >= 0 && k.refIndex < refs.length))
      throw new Error(`createSpriteTimeline: key refIndex ${k.refIndex} out of range`);
  }
  const duration = keys[keys.length - 1].time - keys[0].time;

  let bracketMorph = null;
  const _spritePairs = new Map(); // 'lo:hi' → createSpriteMorph, kept until dispose
  let curLoRef = -1,
    curHiRef = -1;
  let current = null;
  let lastTime = NaN;
  const holds = new Map(); // refIndex → its held frame: { bundle: a VIEW of its sheet }
  let disposed = false;

  // A HELD FRAME IS A VIEW OF ITS SHEET, not a morph: an object that inherits everything from the sheet and names the sprite (_spriteOf), which every
  // draw and hit entry point resolves to drawSprite(sheet, sprite) / { sprite } on the sheet itself, so nothing is copied and every cache stays the
  // sheet's. A sprite morph pinned at t = 0 instead would be a bundle per frame forwarding the whole sheet's planes (gigabytes for a sheet of
  // thousands of frames). `currentMorph` is null on a held frame.
  function buildHold(refIdx) {
    let h = holds.get(refIdx);
    if (h) return h;
    const r = refs[refIdx],
      sheet = unwrapBundle(r.bundle);
    const ok = Array.isArray(r.sprite)
      ? checkedSpriteBounds(r.sprite, sheet && sheet.numShapes)
      : typeof r.sprite === 'string' && ownSpriteRange(sheet, r.sprite);
    if (!sheet || !ok)
      throw new Error(
        `createSpriteTimeline: ref ${refIdx} names no sprite of its bundle (${JSON.stringify(r.sprite)})`,
      );
    const view = Object.create(sheet);
    Object.defineProperty(view, '_spriteOf', { value: { sheet, sprite: r.sprite } });
    h = { bundle: view, sprite: r.sprite, overrides: null, dispose() {} };
    holds.set(refIdx, h);
    return h;
  }

  const pairMorph = (lo, hi) => {
    const k9 = lo + ':' + hi;
    let m9 = _spritePairs.get(k9);
    if (!m9) {
      m9 = createSpriteMorph(gl, refs[lo], refs[hi], opts);
      _spritePairs.set(k9, m9);
    }
    return m9;
  };
  // Pairs are built on first visit, NOT at creation as the shape timeline's pairs are: each is a morph bundle of its own (built at creation, a sheet
  // of thousands of frames would take tens of GB at defaults in the loading call). Held frames are views and cost nothing.

  function setTime(time) {
    if (disposed) return;
    time = +time;
    if (time !== time) time = keys[0].time; // NaN reads as the first key, as setT(NaN) reads as 0
    if (time === lastTime) return;
    lastTime = time;
    const { iLo, iHi, localT } = timelineBracketAt(keys, time);
    const loRef = keys[iLo].refIndex;
    const hiRef = keys[iHi].refIndex;

    // (a 'hold' key shows its own frame until the next key: its bracket's morph would sit at t = 0, which is the held sprite exactly)
    if (loRef === hiRef || keys[iLo].interp === 'hold') {
      current = buildHold(loRef);
      return;
    }
    // Distinct refs → blend. Reuse the live bracket morph if the pair is
    // unchanged; otherwise switch to the cached pair morph (building it on
    // first visit).
    if (!(bracketMorph && curLoRef === loRef && curHiRef === hiRef)) {
      // KEPT per pair for the timeline's life (same rationale as the shape
      // timeline: flipbooks revisit the same pairs, so a pair morph is never
      // disposed on a bracket change — only at dispose()).
      bracketMorph = pairMorph(loRef, hiRef);
      curLoRef = loRef;
      curHiRef = hiRef;
    }
    bracketMorph.setT(timelineEase(keys[iLo], localT));
    current = bracketMorph;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const m9 of _spritePairs.values()) {
      try {
        m9.dispose();
      } catch {}
    }
    _spritePairs.clear();
    bracketMorph = null;
    for (const h of holds.values()) h.dispose();
    holds.clear();
    current = null;
    curLoRef = curHiRef = -1;
  }

  return {
    setTime,
    get duration() {
      return duration;
    },
    get currentMorph() {
      return current && !current.bundle._spriteOf ? current : null;
    },
    get bundle() {
      return disposed ? null : (current || buildHold(keys[0].refIndex)).bundle;
    },
    /// the current frame's sprite when it is a held frame (its `bundle` is then a view of the sheet), else null (a morph between two frames)
    get sprite() {
      const c = disposed ? null : current || buildHold(keys[0].refIndex);
      return c && c.bundle._spriteOf ? c.sprite : null;
    },
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
// `tangents`: { outTan, inTan } — each a Float32Array the same
// length as the source bundle's curveFloats. Set to zero for any
// texel that should use a straight line.
export function createSpatialBezierMorph(gl, srcBundle, dstBundle, tangents, opts) {
  if (!tangents?.outTan || !tangents?.inTan)
    throw new Error('createSpatialBezierMorph: tangents.outTan + tangents.inTan required');
  const src = srcBundle,
    dst = dstBundle;
  if (!curvePoseLayout(src) || !curvePoseLayout(dst))
    throw new Error('createSpatialBezierMorph: materialized v3 bundles required');
  if (
    tangents.outTan.length !== src.curveFloats.length ||
    tangents.inTan.length !== src.curveFloats.length
  )
    throw new Error('createSpatialBezierMorph: tangents must match source curveFloats length');
  const morph = createShapeMorph(gl, src, dst, opts),
    plan = morph.plan;
  const morphSource = morph.bundle._morphSrc;
  const srcF = morphSource.mergedCurveF32,
    dstF = morphSource.dstCurveF32;
  const poseLayout = curvePoseLayout(morph.bundle, srcF);
  const arcs = new Set(morphSource.arcOffsets || []);
  const outTan = tangents.outTan;
  const inTan = tangents.inTan;
  const scratch = new Float32Array(srcF.length);

  function setT(t) {
    t = clamp01(t);
    const omt = 1 - t;
    const k0 = omt * omt * omt;
    const k1 = 3 * omt * omt * t;
    const k2 = 3 * omt * t * t;
    const k3 = t * t * t;
    const source = morphSource.srcEpCurveF32 || srcF,
      target = morphSource.dstEpCurveF32 || dstF;
    scratch.set(source);
    for (const match of plan.matched)
      for (const record of poseLayout.rows[match.srcIdx]) {
        const { h, d, type } = record,
          arc = arcs.has(h);
        if (type === 3 && !arc) continue;
        const count = arc ? 4 : type === 0 ? 4 : type === 1 ? 6 : 8;
        for (let k = 0; k < count; k++) {
          const slot = d + k,
            tangentSlot = arc ? h + 12 + k : slot;
          const p0 = source[slot],
            p3 = target[slot];
          scratch[slot] =
            k0 * p0 + k1 * (p0 + outTan[tangentSlot]) + k2 * (p3 - inTan[tangentSlot]) + k3 * p3;
        }
        if (arc)
          for (const k of [8, 9, 10]) scratch[h + k] = source[h + k] * omt + target[h + k] * t;
      }
    applyArcFlagSteps(scratch, morphSource.arcFlagSteps, t);
    for (const h of arcs) {
      const startX = scratch[h + 4],
        startY = scratch[h + 5],
        endX = scratch[h + 6],
        endY = scratch[h + 7];
      arcRecordToCenter(scratch, h);
      scratch[h + 12] = startX;
      scratch[h + 13] = startY;
      scratch[h + 14] = endX;
      scratch[h + 15] = endY;
    }
    restoreArcEndPoses(scratch, morphSource.arcEndPoseRanges, t, srcF, dstF);
    sampleDrivenPaint(gl, morph, morphSource, t);
    adoptCurvePose(gl, morph.bundle, scratch, poseLayout);
  }

  return {
    get bundle() {
      return morph.bundle;
    },
    get plan() {
      return morph.plan;
    },
    get overrides() {
      return morph.overrides;
    },
    setT,
    dispose() {
      morph.dispose();
    },
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

export function createPathDeltaMorph(gl, baseBundle, deltas) {
  if (!gl) throw new Error('createPathDeltaMorph: gl required');
  if (!baseBundle) throw new Error('createPathDeltaMorph: baseBundle required');
  if (!Array.isArray(deltas) || deltas.length < 1)
    throw new Error('createPathDeltaMorph: deltas[] required');
  const baseF = extractCurveFloats(baseBundle).slice();
  const poseLayout = curvePoseLayout(baseBundle, baseF);
  if (!poseLayout) throw new Error('createPathDeltaMorph: materialized v3 bundle required');
  for (const d of deltas) {
    if (!d || !Number.isFinite(d.time))
      throw new Error('createPathDeltaMorph: delta times must be finite numbers');
    if (!d.vertexDeltas || d.vertexDeltas.length !== baseF.length)
      throw new Error(
        'createPathDeltaMorph: each delta.vertexDeltas must match baseBundle.curveFloats length',
      );
  }

  const sorted = deltas.slice().sort((a, b) => a.time - b.time);
  const duration = sorted[sorted.length - 1].time - sorted[0].time;
  const scratch = baseF.slice();
  let lastTime = NaN,
    disposed = false;

  function setTime(time) {
    if (disposed) return;
    time = +time;
    if (time !== time) time = sorted[0].time; // NaN reads as the first key, as in createShapeTimeline
    if (time === lastTime) return;
    lastTime = time;
    // Find the bracketing pair.
    let iLo = 0,
      iHi = 0,
      localT = 0;
    if (time <= sorted[0].time) {
      iLo = iHi = 0;
      localT = 0;
    } else if (time >= sorted[sorted.length - 1].time) {
      iLo = iHi = sorted.length - 1;
      localT = 1;
    } else {
      let lo = 0,
        hi = sorted.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].time <= time) lo = mid;
        else hi = mid;
      }
      iLo = lo;
      iHi = hi;
      const dt = sorted[hi].time - sorted[lo].time;
      localT = dt > 0 ? (time - sorted[lo].time) / dt : 0;
    }
    const dLo = sorted[iLo].vertexDeltas,
      dHi = sorted[iHi].vertexDeltas;
    for (const i of poseLayout.coordinates)
      scratch[i] = baseF[i] + dLo[i] * (1 - localT) + dHi[i] * localT;
    adoptCurvePose(gl, baseBundle, scratch, poseLayout);
  }

  function dispose() {
    disposed = true;
  }

  return {
    get bundle() {
      return baseBundle;
    },
    get duration() {
      return duration;
    },
    setTime,
    dispose,
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
  const baseF = extractCurveFloats(baseBundle).slice();
  const poseLayout = curvePoseLayout(baseBundle, baseF);
  if (!poseLayout) throw new Error('createSkinnedMorph: materialized v3 bundle required');
  const nVerts = baseF.length >>> 1;
  if (boneWeights.length !== nVerts)
    throw new Error(
      `createSkinnedMorph: boneWeights.length ${boneWeights.length} must equal vertex count ${nVerts}`,
    );
  const scratch = baseF.slice();
  const positions = poseLayout.rows.flatMap((rs) =>
    rs.flatMap(({ d, type }) =>
      type === 3
        ? []
        : Array.from({ length: type === 0 ? 2 : type === 1 ? 3 : 4 }, (_, i) => (d + i * 2) / 2),
    ),
  );

  function setBoneMatrices(matrices) {
    // matrices: flat Float32Array of (numBones × 6) — [m00,m01,m10,m11,tx,ty] per bone.
    if (!matrices) return;
    scratch.set(baseF);
    const arcTransforms = new Map();
    for (const records of poseLayout.rows)
      for (const { h, d, type } of records)
        if (type === 3) {
          const ws = boneWeights[d / 2] || [];
          // An ellipse has one affine frame. Independent endpoint frames would no
          // longer describe an ellipse and require a different authoring primitive.
          for (const slot of [d + 8, d + 10]) {
            const other = boneWeights[slot / 2];
            if (other?.length && JSON.stringify(other) !== JSON.stringify(ws))
              throw new Error(
                'createSkinnedMorph: arc endpoints must share the center bone weights',
              );
          }
          if (!ws.length) continue;
          const m = [0, 0, 0, 0, 0, 0];
          for (const { boneId, weight } of ws) {
            const i = boneId * 6;
            m[0] += weight * matrices[i];
            m[1] += weight * matrices[i + 2];
            m[2] += weight * matrices[i + 1];
            m[3] += weight * matrices[i + 3];
            m[4] += weight * matrices[i + 4];
            m[5] += weight * matrices[i + 5];
          }
          arcTransforms.set(h, m);
        }
    for (const v of positions) {
      const ws = boneWeights[v];
      if (!ws || ws.length === 0) continue; // leave at rest
      const restX = baseF[v * 2];
      const restY = baseF[v * 2 + 1];
      let outX = 0,
        outY = 0;
      for (let k = 0; k < ws.length; k++) {
        const { boneId, weight } = ws[k];
        const off = boneId * 6;
        const m00 = matrices[off],
          m01 = matrices[off + 1];
        const m10 = matrices[off + 2],
          m11 = matrices[off + 3];
        const tx = matrices[off + 4],
          ty = matrices[off + 5];
        const wx = m00 * restX + m01 * restY + tx;
        const wy = m10 * restX + m11 * restY + ty;
        outX += weight * wx;
        outY += weight * wy;
      }
      scratch[v * 2] = outX;
      scratch[v * 2 + 1] = outY;
    }
    adoptCurvePose(gl, baseBundle, scratch, poseLayout, arcTransforms);
  }

  function dispose() {}

  return {
    get bundle() {
      return baseBundle;
    },
    get numVertices() {
      return nVerts;
    },
    setBoneMatrices,
    dispose,
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
// `bundles`: array of N bundles (named).
// State: poseA / poseB / poseC indices + tAB / tBC weights.
//   At rest: poseA = current, poseB = poseA, tAB = 0.
//   Transition start: set poseB = target, tAB animates 0→1.
//   Pre-empted transition: poseC = new target, tBC animates 0→1.
//   When tBC hits 1, demote: poseA = poseC, poseB = poseC, tAB = 0.
export function createPoseStack(gl, bundles, opts) {
  if (!gl) throw new Error('createPoseStack: gl required');
  if (!Array.isArray(bundles) || bundles.length < 1)
    throw new Error('createPoseStack: bundles[] required');
  if (bundles.some((b) => !curvePoseLayout(b)))
    throw new Error('createPoseStack: materialized v3 bundles required');
  let poseA = 0,
    poseB = 0,
    poseC = 0;
  let tAB = 0,
    tBC = 0;
  // Cached morphs.
  let morphAB = null,
    morphBC = null;
  let cachedABKey = '';
  let currentMorph = null;
  let disposed = false;
  const drivenSources = new WeakMap();
  let drivenPairKey = '';
  let drivenAB = null,
    drivenABKey = '';

  const rememberSource = (m) => {
    let source = drivenSources.get(m);
    if (!source) {
      source = m.bundle._morphSrc;
      if (source) drivenSources.set(m, source);
    }
    return source;
  };

  function ensureAB(srcIdx, dstIdx) {
    const key = srcIdx + ':' + dstIdx;
    if (cachedABKey !== key) {
      if (morphAB) morphAB.dispose();
      morphAB = createShapeMorph(gl, bundles[srcIdx], bundles[dstIdx], opts);
      cachedABKey = key;
    }
    return morphAB;
  }

  // setState applies the blend math and uploads to GL via the
  // outermost morph (morphBC if it exists, else morphAB).
  function setState({ a = poseA, b = poseB, c = poseC, tAB: nTAB = tAB, tBC: nTBC = tBC } = {}) {
    if (disposed) return;
    // Validate before committing anything: a rejected index must leave the previous state usable.
    for (const [name, idx] of [
      ['a', a],
      ['b', b],
      ['c', c],
    ]) {
      if (!(Number.isInteger(idx) && idx >= 0 && idx < bundles.length))
        throw new Error(
          `createPoseStack: pose index ${name} = ${idx} out of range [0, ${bundles.length})`,
        );
    }
    poseA = a;
    poseB = b;
    poseC = c;
    tAB = clamp01(nTAB);
    tBC = clamp01(nTBC);
    // 2-level fast path: if tBC == 0 (no preempting transition),
    // just use morphAB with t=tAB. A pre-empting transition that
    // re-targets the in-flight destination (poseC === poseB) composes:
    //   lerp(lerp(A,B,tAB), B, tBC) = lerp(A, B, tAB + tBC·(1−tAB))
    // — ignoring tBC here popped the blend backwards.
    if (tBC === 0 || poseC === poseB) {
      const m = ensureAB(poseA, poseB);
      currentMorph = m;
      const source = rememberSource(m);
      if (source) m.bundle._morphSrc = source;
      m.setT(tBC > 0 && poseC === poseB ? tAB + tBC * (1 - tAB) : tAB);
      return;
    }

    const abKey = poseA + ':' + poseB;
    if (!drivenAB || drivenABKey !== abKey) {
      if (drivenAB) drivenAB.dispose();
      drivenAB = createShapeMorph(gl, bundles[poseA], bundles[poseB], opts);
      drivenABKey = abKey;
    }
    const ab = drivenAB,
      abSource = rememberSource(ab);
    const pose = sampleDrivenPaint(gl, ab, abSource, tAB);
    const abLayout = curvePoseLayout({ ...ab.bundle, curveRangesByShape: pose.ranges }, pose.curve);
    adoptCurvePose(gl, ab.bundle, pose.curve, abLayout);
    const key = poseA + ':' + poseB + ':' + poseC;
    if (!morphBC || drivenPairKey !== key) {
      if (morphBC) morphBC.dispose();
      morphBC = createShapeMorph(gl, ab.bundle, bundles[poseC], opts);
      drivenSources.set(morphBC, morphBC.bundle._morphSrc);
      drivenPairKey = key;
    }
    const bcSource = drivenSources.get(morphBC),
      src = ab.bundle;
    bcSource.mergedCurveF32.set(src.curveFloats);
    const stride = bcSource.metaStride,
      visibility = ab.overrides.packedBuffer;
    for (let row = 0; row < src.numShapes; row++) {
      const o = row * stride;
      bcSource.mergedMetaF32.set(src.metaFloats.subarray(o, o + stride), o);
      const vis = visibility ? visibility[row * 24 + 6] : 1;
      bcSource.mergedMetaF32[o + 7] *= vis;
      bcSource.mergedMetaF32[o + 11] *= vis;
      const fid = Math.round(src.metaFloats[o + 32]);
      const own =
        (src._drivenFilterOpacities?.get(row) ??
          (fid > 0 ? 1 - src.lastFilterFloats[(fid - 1) * 24 + 23] : 1)) * vis;
      const pair = bcSource.filterOpacityPairs.get(row);
      if (pair) pair[0] = own;
      else bcSource.filterOpacityPairs.set(row, [own, own]);
    }
    if (src.gradientFloats && bcSource.gradientParams)
      bcSource.gradientParams.set(src.gradientFloats);
    if (src.gradientStopsBytes && bcSource.gradientStops)
      bcSource.gradientStops.set(src.gradientStopsBytes);
    const arc = prepareDrivenArcMorph(
      src,
      morphBC.plan,
      4096,
      bcSource.mergedCurveF32,
      bcSource.dstCurveF32,
      false,
      opts?.compat === 'chrome',
      opts?.arcRotation === 'shortest',
    );
    bcSource.srcEpCurveF32 = arc.srcEp;
    bcSource.dstEpCurveF32 = arc.dstEp;
    bcSource.arcOffsets = arc.arcs;
    bcSource.arcEndPoseRanges = arc.endPoseRanges || null;
    bcSource.arcFlagSteps = arc.flagSteps || null;
    const current = sampleDrivenPaint(gl, morphBC, bcSource, tBC);
    const layout = curvePoseLayout(
      { ...morphBC.bundle, curveRangesByShape: current.ranges },
      current.curve,
    );
    adoptCurvePose(gl, morphBC.bundle, current.curve, layout);
    currentMorph = morphBC;
  }

  function bundle() {
    return currentMorph ? currentMorph.bundle : bundles[poseA];
  }

  function dispose() {
    disposed = true;
    if (drivenAB) drivenAB.dispose();
    drivenAB = null;
    if (morphAB) morphAB.dispose();
    if (morphBC) morphBC.dispose();
    morphAB = morphBC = currentMorph = null;
    cachedABKey = '';
    drivenABKey = '';
    drivenPairKey = '';
  }

  return {
    setState,
    get poseA() {
      return poseA;
    },
    get poseB() {
      return poseB;
    },
    get poseC() {
      return poseC;
    },
    get tAB() {
      return tAB;
    },
    get tBC() {
      return tBC;
    },
    get bundle() {
      return bundle();
    },
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

/// The morph parameter as a number in [0, 1]: a numeric string coerces, NaN reads as 0, +-Infinity clamp.
function clamp01(x) {
  x = +x;
  return x > 1 ? 1 : x > 0 ? x : 0;
}

// Internal surface for the no-WebGL fallback: the pure-CPU timeline
// bracket + easing helpers. Not public package API.
export {
  timelineBracketAt as _timelineBracketAt,
  timelineEase as _timelineEase,
} from '../core/morphCore.js';

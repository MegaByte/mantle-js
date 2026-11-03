// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillRouteClass — which fill route class a bundle belongs to: the unified stream (Loop-Blinn / CPatch / primitive meshes beside cover quads and
// strokes in one draw) or the plain cover pass.
//
// WHY A CLASS AND NOT A PER-SCALE RULE. Timed against the cover pass with the same content from 512 px up to a high-DPI backing size, a STATIC bundle is
// generally faster on the cover pass (by tens of percent, and more on some drawings), and the unified route wins only where a GPU lerp, a stream or a
// pre-built mesh is the point: morphs (roughly twice as fast or better), streamed geometry, and pure-Loop-Blinn drawings at very large sizes. A class is decided by what the BUNDLE
// IS (a morph, a stream, an incremental stroke) and by what the HOST PINNED (unifiedFill 'force', a pinned Loop-Blinn mode, CPatch), never by a size, so it is the same
// at every scale and there is no epsilon to calibrate. It also decides what is built and warmed: a static bundle in 'auto' gets no Loop-Blinn mesh build and no
// MANTLE_LB_FILL variant (an exhaustive warm would otherwise compile dozens of unified programs even for a two-rect background).
//
// The answer depends only on bundle fields that change when the bundle's KIND changes (createShapeMorph stamps `_morphSrc`, streaming stamps `_lbStream`) and on
// renderer options, so it is stable for a bundle's life and changes exactly when the bundle becomes a morph or a stream.

/** Class reasons that take the unified route. Anything else is the cover pass. */
export const UNIFIED_REASONS = Object.freeze([
  'force',
  'stream',
  'no-cover-quads',
  'incremental',
  'morph',
  'cpatch-pinned',
  'cpatch-auto',
  'pinned-mode',
  'primitives-on',
  'engine-requested',
  'static-unified',
]);

/**
 * @param {{ opts?: any, _lbFillMode?: string, _forcedPrimitivesOn?: any }} R  the renderer context
 * @param {any} bundle
 * @returns {string} the reason; in UNIFIED_REASONS = unified route, 'static-cover' = cover pass under 'auto', 'opt-off' / 'no-bundle' = no unified route
 */
export function fillRouteReason(R, bundle) {
  if (!bundle) return 'no-bundle';
  const o = (R && R.opts) || {};
  if (o.unifiedFill === false) return 'opt-off';
  if (o.unifiedFill === 'force') return 'force';
  if (bundle._lbStream) return 'stream';
  // A lightweight build (buildStreamableSections({lightweight:true})) carries no cover quads: the cover pass has nothing to draw, so its only route is the stream.
  const cq = bundle.coverQuadVboFloats || bundle.coverQuadFloats;
  if (bundle.numShapes > 0 && (!cq || cq.length === 0)) return 'no-cover-quads';
  if (bundle._incStroke) return 'incremental';
  if (bundle._morphSrc || bundle._morphMeshes) return 'morph';
  if (o.cpatchFill === true) return 'cpatch-pinned';
  if (R && R._lbFillMode !== 'auto') return 'pinned-mode';
  if (o.cpatchAuto === true) return 'cpatch-auto';
  // An explicit setFillEngine({ primitives: 'on' }) asks for SDF primitive meshes, which exist only in the unified stream: honor the request.
  if (R && R._forcedPrimitivesOn === true) return 'primitives-on';
  // awaitEngine(bundle, 'lb' | 'cpatch') asked for that engine on this bundle: a requested engine has to be able to draw, so the bundle takes the unified route.
  if (bundle._engineRequested === true) return 'engine-requested';
  // The pre-route-class behavior, opt-in: static bundles with meshes ride the unified stream under the per-shape 'auto' picks (tests of that policy, A/B timing).
  if (o.staticUnified === true) return 'static-unified';
  return 'static-cover';
}

/** True when the class takes the unified route. */
export const fillRouteUnified = (R, bundle) => UNIFIED_REASONS.includes(fillRouteReason(R, bundle));

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Central engine-selection predicates for drawing and preparation.
// Each draw path uses the same selection state to honor route and kernel pins.

import { mantleDebugFlag } from '../core/diagnostics.js';

/// Every path that can put a shape on screen through something other than a plain cover quad.
///
///   static       a static bundle's analytic route (Loop-Blinn / CPatch meshes)
///   morph        the GPU-resident morph route
///   stream       a lightweight geometry stream (`_lbStream`) — built WITHOUT cover quads
///   prim         a recognized SDF primitive: a peer of the analytic engines, not a Loop-Blinn
///                result, which is why the route being off does not turn it off
///   build        building analytic meshes at all (the off-thread builder, the idle preparer,
///                prepareBundle) — a build nobody may draw is pure cost on the run measuring it
///   aac-points   the AAC small-shape point kernel, which takes the draw precisely when the
///                analytic route declines
export const DRAW_PATHS = ['static', 'morph', 'stream', 'prim', 'build', 'aac-points'];

/// Read every engine-selecting switch once, as a plain value. Takes the fields rather than the
/// renderer so it can be built by hand in a test.
/// @param {{_lbFillMode?:string, _lbSlugOnly?:boolean, _lbSlugFallback?:boolean, opts?:any}} R
export function engineSelection(R) {
  const opts = (R && R.opts) || {};
  return {
    // `forceSlug` is both AXES: no analytic geometry may draw, and cover fragments take the Slug
    // kernel. The name promises the second half and a measurement taken with it set assumes both —
    // it read as a route-only switch, so a run meant to price Slug reported AAC's point kernel.
    // The narrower questions have their own switches: `setLoopBlinnFill('off')` turns the route off
    // while keeping primitives, `setSdfPrimitives(false)` turns primitives off on their own, and
    // `setFillEngine({ kernel })` selects the cover kernel.
    forceSlug: mantleDebugFlag('forceSlug'),
    // A COVER ROUTE THE CALLER FORCED (setFillEngine({ route: 'none' ... })) is the PLAIN cover pass: a recognized primitive does
    // not push the bundle onto the unified route or bind the MANTLE_LB_FILL program. The legacy
    // setLoopBlinnFill('off') still means "the route is off, primitives stay"; `setFillEngine({ ..., primitives: 'on' })`
    // restores that for a forced cover arm. Any pin (route none/lb/cpatch, kernel slug/aac) is honored -- primitives stay only under
    // 'auto' or an explicit primitives: 'on'.
    forcedCover: !!(
      R &&
      (R._forcedCover === true || R._forcedKernel === true) &&
      R._forcedPrimitivesOn !== true
    ),
    // Undefined preserves the default; false is an explicit primitive-axis veto.
    primitivesOff: !!(R && R._forcedPrimitivesOn === false),
    mode: (R && R._lbFillMode) || 'auto',
    slugOnly: !!(R && R._lbSlugOnly),
    cpatch: opts.cpatchFill === true,
    cpatchAuto: opts.cpatchAuto === true,
    forceUnified: opts.unifiedFill === 'force',
  };
}

/// May analytic geometry be built or drawn on `path`? `{ allow, reason }` — `reason` names the
/// switch that denied it, or, when a switch CANNOT be honored, why not.
///
/// The one place it cannot be honored is a lightweight stream: it is built with no cover quads at
/// all, so "draw this with Slug" has no geometry to draw and the alternatives are the analytic
/// route or a blank frame. That is reported (`'force-slug-stream'` with `allow` true) rather than
/// swallowed, because silently taking the route is what made the switch untrustworthy.
/// @param {ReturnType<typeof engineSelection>} sel
/// @param {string} path one of DRAW_PATHS
export function analyticAllowed(sel, path) {
  if (path === 'stream') {
    // The route veto does not apply to a published stream either — its perf decision is taken at
    // stream time, and there is nothing else to draw it with.
    if (sel.forceSlug) return { allow: true, reason: 'force-slug-stream' };
    return { allow: true, reason: 'ok' };
  }
  if (sel.forceSlug) return { allow: false, reason: 'force-slug' };
  if (path === 'aac-points') return { allow: true, reason: 'ok' };

  if (path === 'prim' && sel.primitivesOff) return { allow: false, reason: 'primitives-off' };
  if (path === 'prim')
    return sel.forcedCover
      ? { allow: false, reason: 'forced-cover' }
      : { allow: true, reason: 'ok' };
  if (sel.mode === 'off' || sel.slugOnly) return { allow: false, reason: 'lb-off' };
  return { allow: true, reason: 'ok' };
}

/// The whole selection as one short string, for a consumer that CACHES a rendered result instead of
/// re-deciding per draw. Without it a raster baked under one selection is blitted forever under the
/// next — which is the same defect one level up: the switch holds on every live path and not on the
/// one that replays a picture.
/// @param {{_lbFillMode?:string, _lbSlugOnly?:boolean, _lbSlugFallback?:boolean, opts?:any}} R
export function engineSelKey(R) {
  const sel = engineSelection(R);
  const opts = (R && R.opts) || {};
  return (
    (sel.forceSlug ? 'F' : '-') +
    (sel.forcedCover ? 'c' : '-') +
    (sel.primitivesOff ? 'p' : '-') +
    sel.mode +
    (sel.slugOnly ? 'o' : '-') +
    (R && R._lbSlugFallback ? 'f' : '-') +
    (sel.cpatch ? 'c' : sel.cpatchAuto ? 'a' : '-') +
    (sel.forceUnified ? 'u' : opts.unifiedFill === false ? 'x' : '-') +
    (opts.fillKernel || (opts.aacFill === 'auto' ? 'auto' : opts.aacFill ? 'aac' : 'slug'))
  );
}

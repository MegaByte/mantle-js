// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeReach.js — how far a stroke's ink reaches from its path, in half-widths.

// The consumers: the importer's stroke band membership pad and cover quad (svg/bundleFinalize.js),
// the morph band rebuild (core/morphCore.js), and the hit test's bbox cull and tree prune
// (hitTest/hitTest.js). The shader's own search radius is the same bound, written in GLSL
// (_coverage.glsl strokeBandAccum, _reach). The view and occlusion culls (renderer/) take the join
// part only: their pads already cover a square cap (viewCull adds at least halfW to a meta bbox
// that is halfW-padded, and isStrokeBandContained samples the cap corners at reach * (t +- n)).
//
// joinStyle: 0 miter, 1 round, 2 bevel, 3 miter-clip, 4 arcs. cap: 0 butt, 1 round, 2 square.
import {
  META_CAP_STYLE,
  META_JOIN_STYLE,
  META_MITER_LIMIT,
  META_PRIM_KIND,
  META_END_CAP_OR_RX,
} from './layout.js';

/// The largest miter ratio any join can have: buildTexturesShape turns a join whose cos(phi/2) is under 1e-6 into an
/// infinite ratio (a reversal), which fails every finite limit and takes the bevel. A miter limit above this is therefore
/// no further reach than this: a stroke-miterlimit of 1e16 padded the cover box by 1e16 half-widths and blanked it.
export const MAX_MITER_RATIO = 1e6;

/** The largest distance from the path, in half-widths, that the stroke's ink reaches. */
export function strokeReachFactor(joinStyle, miterLimit, startCap = 1, endCap = startCap) {
  const ml = Math.min(Math.max(1, miterLimit || 4), MAX_MITER_RATIO);
  const j = joinStyle | 0;
  let f = 1;
  if (j === 0) f = ml;
  else if (j === 3 || j === 4) f = Math.sqrt(ml * ml + 1);
  if ((startCap | 0) === 2 || (endCap | 0) === 2) f = Math.max(f, Math.SQRT2);
  return f;
}

/** strokeReachFactor for the meta row at float offset `o` (endCap from slot 46, as meta.js packs it). */
export function metaStrokeReachFactor(meta, o) {
  const cap = meta[o + META_CAP_STYLE] | 0;
  const enc =
    (meta[o + META_PRIM_KIND] | 0) === 3 ? 0 : Math.round(meta[o + META_END_CAP_OR_RX]) | 0;
  return strokeReachFactor(
    meta[o + META_JOIN_STYLE],
    meta[o + META_MITER_LIMIT],
    cap,
    enc > 0 ? enc - 1 : cap,
  );
}

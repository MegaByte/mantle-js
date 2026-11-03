// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitBits.js — what part of a shape the pointer can target (SVG 2 interact.html 'pointer-events').
//
// A shape's HIT BITS say which of its regions answer a point: FILL (the interior by the fill rule), STROKE (the exact
// stroked outline) or BBOX (the geometry bounding box, pointer-events: bounding-box). They are resolved at import from
// pointer-events, visibility and whether fill / stroke are `none`; the hit test then needs no paint, alpha or cascade.
// `opacity`, `fill-opacity`, `stroke-opacity`, `mask`, `filter` and blend never enter: a paint other than `none` is
// painted whatever its alpha.

import {
  META_FILL_A,
  META_FILL_GRAD,
  META_IMAGE_ID,
  META_STROKE_W,
  META_STROKE_A,
  META_STROKE_GRAD,
} from '../bundle/layout.js';

export const HIT_FILL = 1,
  HIT_STROKE = 2,
  HIT_BBOX = 4;
/// Set on the hit bits of a row kept hidden (importSvg keepHidden): the other bits are what the row answers once it is revealed
/// (displayed and visible); until then it answers nothing. The pointer-events of a hidden `visibility` leaf that can still be
/// targeted ride the hit-only table, as they always did.
export const HIT_HIDDEN = 0x80;

/// The bits of a shape with computed `pe` (a lowercase pointer-events value), `visible` (visibility is `visible`),
/// `fillPainted` / `strokePainted` (the paint is not `none`) and `hasStroke` (stroke width > 0).
export function hitBitsOf(pe, visible, fillPainted, strokePainted, hasStroke) {
  let fill = false,
    stroke = false;
  switch (pe) {
    case 'none':
      return 0;
    case 'bounding-box':
      return HIT_BBOX;
    case 'visiblefill':
      fill = visible;
      break;
    case 'visiblestroke':
      stroke = visible;
      break;
    case 'visible':
      fill = stroke = visible;
      break;
    case 'painted':
      fill = fillPainted;
      stroke = strokePainted;
      break;
    case 'fill':
      fill = true;
      break;
    case 'stroke':
      stroke = true;
      break;
    case 'all':
      fill = stroke = true;
      break;
    default:
      fill = visible && fillPainted;
      stroke = visible && strokePainted;
      break; // auto, visiblepainted
  }
  return (fill ? HIT_FILL : 0) | (stroke && hasStroke ? HIT_STROKE : 0);
}

/// Whether the importer draws the shape's fill / stroke row (the exact gates of bundleFinalize's emit rows).
export function fillRowDrawn(sd, keepInvisible) {
  if (sd.hitVis === false) return false;
  return (
    sd.fillRgba[3] > 0 ||
    (!!keepInvisible &&
      (sd.fillNone !== true || keepInvisible === 2) &&
      !!sd.segs &&
      sd.segs.length > 0)
  );
}
export function strokeRowDrawn(sd, keepInvisible) {
  if (sd.hitVis === false || !(sd.sw > 0)) return false;
  return (
    sd.strokeRgba[3] > 0 || (!!keepInvisible && !sd.strokeNone && !!sd.segs && sd.segs.length > 0)
  );
}

/// How far an import keeps content that draws nothing as a drawn row of alpha 0 (a fill or stroke whose alpha is 0), so a morph, a timeline,
/// an override or a hit test finds it. The default is to keep; `keepInvisibleShapes: false` is the optimizing mode that drops it.
/// Returns 0 (drop), 1 (keep alpha-0 fills and strokes: the default) or 2 (`keepInvisibleShapes: 'all'`: also keep a fill of `none`, so a
/// stroke-only shape has a fill row a morph or an override can reach; costs a row per stroke-only shape).
export function keepInvisibleOf(opts) {
  if (!opts || opts.keepInvisibleShapes === undefined || opts.keepInvisibleShapes === true)
    return 1;
  return opts.keepInvisibleShapes === 'all' ? 2 : 0;
}

/// Whether an import keeps content the document marks as not drawn: `display:none` subtrees, `visibility:hidden` / `collapse` leaves, and the
/// degenerate content of a displayed element (zero-size shapes, zero-width strokes, markers at stroke width 0). `keepHidden: true` keeps all of
/// it as rows that draw nothing until a runtime API reveals them; the default drops it, counts it in `bundle.dropped` and warns once.
export function keepHiddenOf(opts) {
  return !!opts && opts.keepHidden === true;
}

/// The regions of `sd` that can be targeted but that no row draws: { fill, stroke }, or null when none.
export function hitOnlyNeeds(sd, keepInvisible) {
  const bits = sd.hitBits | 0;
  if (!bits || sd.isLayer || sd._marker || sd.kind || !sd.segs || !sd.segs.length) return null;
  const fill = (bits & (HIT_FILL | HIT_BBOX)) !== 0 && !fillRowDrawn(sd, keepInvisible);
  const stroke = (bits & HIT_STROKE) !== 0 && !strokeRowDrawn(sd, keepInvisible);
  return fill || stroke ? { fill, stroke } : null;
}

/// The bits of a row of a bundle that carries none (a programmatic or text bundle): the paint it carries, alpha as paint.
export function paintHitBits(meta, off) {
  let b = 0;
  if (
    meta[off + META_FILL_A] > 0 ||
    Math.round(meta[off + META_FILL_GRAD]) > 0 ||
    Math.round(meta[off + META_IMAGE_ID]) > 0
  )
    b |= HIT_FILL;
  if (
    meta[off + META_STROKE_W] > 0 &&
    (meta[off + META_STROKE_A] > 0 || Math.round(meta[off + META_STROKE_GRAD]) > 0)
  )
    b |= HIT_STROKE;
  return b;
}

/// A bundle's hit bits for row `i`: its own table when it has one, else what its paint implies.
export function rowHitBits(bundle, i) {
  if (bundle.hitBits) return bundle.hitBits[i] | 0;
  const stride = bundle.metaFloatsPerShape | 0;
  return bundle.metaFloats && stride > 0 ? paintHitBits(bundle.metaFloats, i * stride) : 0;
}

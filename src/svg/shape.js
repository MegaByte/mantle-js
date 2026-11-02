// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { svgElementName } from './utils.js';
// svg/shape.js — SVG primitive element (<rect>, <circle>, <ellipse>,
// <line>, <polyline>, <polygon>, <path>) → Segment[].
//
// Path parsing delegates to svg/path.js;
// the primitives synthesise segs inline. Rounded rects use native
// SVG_ARC corners (precise, not cubic-approximated).

import { mkLine, mkArc, arcToNative } from './segment.js';
import { parsePathD, parseNumberList } from './path.js';
import { parseLengthOr } from './length.js';
import { getStyleProp } from './style.js';

// SVG 2 §10: x, y, width, height, cx, cy, r, rx and ry are geometry PROPERTIES, so a style attribute or a stylesheet
// rule sets them and the attribute is the lowest layer of the cascade.
const geom = (el, name) => getStyleProp(el, name, null);

// Resolve once for both the curve geometry and the primitive shader tag.
// Missing or invalid radii copy the other axis; an explicit zero disables rounding.
export function resolveRectRadii(el, width, height, vp) {
  let rx = parseLengthOr(geom(el, 'rx'), NaN, vp ? { ...vp, axis: 'x' } : undefined);
  let ry = parseLengthOr(geom(el, 'ry'), NaN, vp ? { ...vp, axis: 'y' } : undefined);
  if (rx < 0) rx = NaN;
  if (ry < 0) ry = NaN;
  if (!Number.isFinite(rx)) rx = Number.isFinite(ry) ? ry : 0;
  if (!Number.isFinite(ry)) ry = rx;
  rx = Math.min(rx, width / 2);
  ry = Math.min(ry, height / 2);
  return rx === 0 || ry === 0 ? [0, 0] : [rx, ry];
}

/// Convert a primitive SVG element to its segment list. Returns [] for
/// degenerate inputs (zero-extent rects, zero-radius circles, etc.) so
/// downstream code can skip the shape without a special case.
/// `vp` ({ parentWidth, parentHeight }, optional) resolves percentage
/// lengths against the viewport (SVG 1.1 §7.10: x/width vs the width,
/// y/height vs the height, r vs the normalized diagonal).
export function parseShape(el, vp) {
  const vx = vp ? { ...vp, axis: 'x' } : undefined;
  const vy = vp ? { ...vp, axis: 'y' } : undefined;
  const vd = vp ? { ...vp, axis: 'd' } : undefined;
  const tag = svgElementName(el);
  if (tag === 'path') {
    const d = el.getAttribute('d');
    if (d) return parsePathD(d);
    return [];
  }
  if (tag === 'rect') {
    const x = parseLengthOr(geom(el, 'x'), 0, vx);
    const y = parseLengthOr(geom(el, 'y'), 0, vy);
    const w = parseLengthOr(geom(el, 'width'), 0, vx);
    const h = parseLengthOr(geom(el, 'height'), 0, vy);
    if (w <= 0 || h <= 0) return [];
    const [rx, ry] = resolveRectRadii(el, w, h, vp);
    if (rx === 0 && ry === 0) {
      return [
        mkLine([x, y], [x + w, y]),
        mkLine([x + w, y], [x + w, y + h]),
        mkLine([x + w, y + h], [x, y + h]),
        mkLine([x, y + h], [x, y]),
      ];
    }
    return [
      mkLine([x + rx, y], [x + w - rx, y]),
      arcToNative([x + w - rx, y], rx, ry, 0, 0, 1, [x + w, y + ry]),
      mkLine([x + w, y + ry], [x + w, y + h - ry]),
      arcToNative([x + w, y + h - ry], rx, ry, 0, 0, 1, [x + w - rx, y + h]),
      mkLine([x + w - rx, y + h], [x + rx, y + h]),
      arcToNative([x + rx, y + h], rx, ry, 0, 0, 1, [x, y + h - ry]),
      mkLine([x, y + h - ry], [x, y + ry]),
      arcToNative([x, y + ry], rx, ry, 0, 0, 1, [x + rx, y]),
    ];
  }
  if (tag === 'circle' || tag === 'ellipse') {
    const cx = parseLengthOr(geom(el, 'cx'), 0, vx);
    const cy = parseLengthOr(geom(el, 'cy'), 0, vy);
    let rx, ry;
    if (tag === 'circle') {
      rx = parseLengthOr(geom(el, 'r'), 0, vd);
      ry = rx;
    } else {
      // SVG 2 §10.4: rx and ry default to `auto`, which takes the other radius' used value; a negative or
      // unparseable one is auto too, as on a <rect>. Both auto draws nothing, and an explicit 0 disables the shape.
      rx = parseLengthOr(geom(el, 'rx'), NaN, vx);
      ry = parseLengthOr(geom(el, 'ry'), NaN, vy);
      if (rx < 0) rx = NaN;
      if (ry < 0) ry = NaN;
      if (!Number.isFinite(rx)) rx = Number.isFinite(ry) ? ry : 0;
      if (!Number.isFinite(ry)) ry = rx;
    }
    if (rx <= 0 || ry <= 0) return [];
    // SVG 2 starts a circle/ellipse at (cx + rx, cy) and runs clockwise on screen (toward +y): the contour is
    // M cx+rx,cy  A rx ry 0 0 1 cx,cy+ry  A ... back to the start. The start point owns the dash phase
    // (stroke-dasharray / stroke-dashoffset) and the point pairing of a morph, so the arc runs theta 0 -> 2PI
    // rather than -PI -> PI, which would begin at (cx - rx, cy) and move every dash by half the circumference.
    // Both ends are the exact point (no cos/sin of 2PI residue), as a closed contour needs.
    return [mkArc(cx, cy, rx, ry, 0, 2 * Math.PI, 0, 1, 1, [cx + rx, cy], [cx + rx, cy])];
  }
  if (tag === 'line') {
    return [
      mkLine(
        [parseLengthOr(el.getAttribute('x1'), 0, vx), parseLengthOr(el.getAttribute('y1'), 0, vy)],
        [parseLengthOr(el.getAttribute('x2'), 0, vx), parseLengthOr(el.getAttribute('y2'), 0, vy)],
      ),
    ];
  }
  if (tag === 'polyline' || tag === 'polygon') {
    const raw = parseNumberList(el.getAttribute('points') || '');
    // Spec: the points list is processed UP TO the first error, so stop at a
    // token that is not a number ("10,10 20,abc 30,30" keeps only the first
    // pair) as well as at an incomplete trailing pair. Either one becoming a
    // NaN endpoint would poison pathBbox and then the bundle's globalBBox.
    let stop = raw.length;
    for (let i = 0; i < raw.length; i++) {
      if (!Number.isFinite(raw[i])) {
        stop = i;
        break;
      }
    }
    const pts = stop === raw.length ? raw : raw.slice(0, stop);
    const n = pts.length & ~1;
    const segs = [];
    for (let i = 0; i < n - 2; i += 2) {
      segs.push(mkLine([pts[i], pts[i + 1]], [pts[i + 2], pts[i + 3]]));
    }
    if (tag === 'polygon' && n >= 4) {
      segs.push(mkLine([pts[n - 2], pts[n - 1]], [pts[0], pts[1]]));
    }
    return segs;
  }
  return [];
}

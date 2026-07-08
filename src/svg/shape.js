// svg/shape.js — SVG primitive element (<rect>, <circle>, <ellipse>,
// <line>, <polyline>, <polygon>, <path>) → Segment[].
//
// Path parsing delegates to svg/path.js;
// the primitives synthesise segs inline. Rounded rects use native
// SVG_ARC corners (precise, not cubic-approximated).

import { mkLine, mkArc, arcToNative } from './segment.js';
import { parsePathD } from './path.js';
import { parseLengthOr } from './length.js';

/// Convert a primitive SVG element to its segment list. Returns [] for
/// degenerate inputs (zero-extent rects, zero-radius circles, etc.) so
/// downstream code can skip the shape without a special case.
export function parseShape(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'path') {
    const d = el.getAttribute('d');
    if (d) return parsePathD(d);
    return [];
  }
  if (tag === 'rect') {
    const x = parseLengthOr(el.getAttribute('x'), 0);
    const y = parseLengthOr(el.getAttribute('y'), 0);
    const w = parseLengthOr(el.getAttribute('width'), 0);
    const h = parseLengthOr(el.getAttribute('height'), 0);
    if (w <= 0 || h <= 0) return [];
    let rx = parseLengthOr(el.getAttribute('rx'), 0);
    let ry = parseLengthOr(el.getAttribute('ry'), 0);
    if (rx === 0 && ry > 0) rx = ry;
    if (ry === 0 && rx > 0) ry = rx;
    rx = Math.min(rx, w/2); ry = Math.min(ry, h/2);
    if (rx === 0 && ry === 0) {
      return [
        mkLine([x, y], [x+w, y]),
        mkLine([x+w, y], [x+w, y+h]),
        mkLine([x+w, y+h], [x, y+h]),
        mkLine([x, y+h], [x, y]),
      ];
    }
    return [
      mkLine([x+rx, y], [x+w-rx, y]),
      arcToNative([x+w-rx, y], rx, ry, 0, 0, 1, [x+w, y+ry]),
      mkLine([x+w, y+ry], [x+w, y+h-ry]),
      arcToNative([x+w, y+h-ry], rx, ry, 0, 0, 1, [x+w-rx, y+h]),
      mkLine([x+w-rx, y+h], [x+rx, y+h]),
      arcToNative([x+rx, y+h], rx, ry, 0, 0, 1, [x, y+h-ry]),
      mkLine([x, y+h-ry], [x, y+ry]),
      arcToNative([x, y+ry], rx, ry, 0, 0, 1, [x+rx, y]),
    ];
  }
  if (tag === 'circle' || tag === 'ellipse') {
    const cx = parseLengthOr(el.getAttribute('cx'), 0);
    const cy = parseLengthOr(el.getAttribute('cy'), 0);
    let rx, ry;
    if (tag === 'circle') { rx = parseLengthOr(el.getAttribute('r'), 0); ry = rx; }
    else { rx = parseLengthOr(el.getAttribute('rx'), 0); ry = parseLengthOr(el.getAttribute('ry'), 0); }
    if (rx <= 0 || ry <= 0) return [];
    return [mkArc(cx, cy, rx, ry, -Math.PI, Math.PI, 0, 1, 1)];
  }
  if (tag === 'line') {
    return [mkLine(
      [parseLengthOr(el.getAttribute('x1'), 0), parseLengthOr(el.getAttribute('y1'), 0)],
      [parseLengthOr(el.getAttribute('x2'), 0), parseLengthOr(el.getAttribute('y2'), 0)],
    )];
  }
  if (tag === 'polyline' || tag === 'polygon') {
    const pts = (el.getAttribute('points') || '').split(/[,\s]+/).filter(s => s).map(parseFloat);
    const segs = [];
    for (let i = 0; i < pts.length - 2; i += 2) {
      segs.push(mkLine([pts[i], pts[i+1]], [pts[i+2], pts[i+3]]));
    }
    if (tag === 'polygon' && pts.length >= 4) {
      segs.push(mkLine([pts[pts.length-2], pts[pts.length-1]], [pts[0], pts[1]]));
    }
    return segs;
  }
  return [];
}

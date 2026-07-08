// svg/marker.js — <marker> defs parser + per-vertex instantiation.
//
// The parser collects sub-shape descriptions (segs + paint state) per
// marker child; instantiateMarker transforms each child to a specific
// endpoint along a stroked path, applying the marker's orient /
// refX/refY / markerUnits semantics.

import { elementChildren } from './utils.js';
import { parseShape } from './shape.js';
import { transformSegInto } from './transform.js';
import { parseLength, parseLengthOr } from './length.js';
import {
  getStyleProp, getShapeStyles, getCapsJoins, getFillRule,
} from './style.js';

/// Transform a marker's pre-collected sub-shapes to the vertex (vx, vy)
/// along a stroked path with tangent angle `tangentAngle` and current
/// stroke width `strokeWidth`. Returns a flat array of sub-shapes with
/// segs already in user space.
export function instantiateMarker(marker, vx, vy, tangentAngle, strokeWidth) {
  if (!marker || !marker.children.length) return [];
  let angle = 0;
  const ori = marker.orient;
  if (ori === 'auto') angle = tangentAngle;
  else if (ori === 'auto-start-reverse') angle = tangentAngle + Math.PI;
  else angle = (parseLengthOr(ori, 0)) * Math.PI / 180;
  // markerUnits=strokeWidth scales the marker by the shape's strokeWidth.
  // userSpaceOnUse leaves marker coords as-is.
  const unitScale = (marker.units === 'userSpaceOnUse') ? 1 : strokeWidth;
  // viewBox maps marker content's local space to (markerWidth, markerHeight).
  const vbW = marker.vbox[2] || marker.mw;
  const vbH = marker.vbox[3] || marker.mh;
  const sx = (marker.mw / vbW) * unitScale;
  const sy = (marker.mh / vbH) * unitScale;
  // Build the marker-space → user-space affine. For a local point p:
  //   p' = vx + ca*sx*(p.x - refX) - sa*sy*(p.y - refY)
  //   p'.y = vy + sa*sx*(p.x - refX) + ca*sy*(p.y - refY)
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const A = ca * sx;
  const B = sa * sx;
  const C = -sa * sy;
  const D = ca * sy;
  const E = vx - A * marker.refX - C * marker.refY;
  const F = vy - B * marker.refX - D * marker.refY;
  const M = [A, B, C, D, E, F];
  const out = [];
  for (const child of marker.children) {
    const xformed = [];
    for (const sg of child.segs) transformSegInto(sg, M, xformed);
    out.push(Object.assign({}, child, { segs: xformed }));
  }
  return out;
}

/// Walk <marker> defs into a per-id registry. Each entry holds the
/// marker's geometry attrs + a pre-parsed list of sub-shape children
/// (segs + paint state). Children are emitted in document order; the
/// per-shape walker calls instantiateMarker at marker-start / mid /
/// end vertex positions during stroke fan-out.
export function parseMarkers(root) {
  const markers = {};
  const visit = el => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'marker') {
      const id = el.getAttribute('id');
      if (id) {
        const vbox = (el.getAttribute('viewBox') || '0 0 3 3').trim()
          .split(/[\s,]+/).map(parseFloat);
        const mw = parseLengthOr(el.getAttribute('markerWidth') || '3', 3);
        const mh = parseLengthOr(el.getAttribute('markerHeight') || '3', 3);
        const refX = parseLengthOr(el.getAttribute('refX') || '0', 0);
        const refY = parseLengthOr(el.getAttribute('refY') || '0', 0);
        const units = (el.getAttribute('markerUnits') || 'strokeWidth').trim();
        const orient = (el.getAttribute('orient') || '0').trim();
        // Collect rendered children as sub-shape descriptions. Same
        // fields as the shapesData entries built by the main walk; we
        // re-walk lightweight here because the marker children inherit
        // the marker's attrs only (not the calling shape's).
        const children = [];
        const collectShape = (n, pf, ps, pw) => {
          const ntag = (n.tagName || '').toLowerCase();
          if (ntag === 'defs' || ntag === 'clippath' || ntag === 'mask' ||
              ntag === 'lineargradient' || ntag === 'radialgradient' ||
              ntag === 'pattern' || ntag === 'symbol' || ntag === 'marker' ||
              ntag === 'filter') return;
          const f = getStyleProp(n, 'fill', pf);
          const s = getStyleProp(n, 'stroke', ps);
          const w = parseLengthOr(getStyleProp(n, 'stroke-width', String(pw)), pw);
          if (['path','rect','circle','ellipse','line','polyline','polygon'].includes(ntag)) {
            const segs = parseShape(n);
            if (segs.length) {
              const styles = getShapeStyles(n, f, s, w);
              const cj = getCapsJoins(n);
              children.push({
                segs,
                fillRgba: styles.fillRgba,
                strokeRgba: styles.strokeRgba,
                sw: styles.sw,
                fillRule: getFillRule(n),
                ...cj,
                fillGradId: 0,
                strokeGradId: 0,
                flagsShape: 0,
                dashArray: [],
                dashOffset: 0,
                clipId: 0,
                maskId: 0,
              });
            }
          }
          const ks = elementChildren(n);
          for (let i = 0; i < ks.length; i++) collectShape(ks[i], f, s, w);
        };
        const kids = elementChildren(el);
        for (let i = 0; i < kids.length; i++) {
          collectShape(kids[i], 'black', 'none', 1);
        }
        markers[id] = { vbox, refX, refY, mw, mh, units, orient, children };
      }
    }
    const kids = elementChildren(el);
    for (let i = 0; i < kids.length; i++) visit(kids[i]);
  };
  visit(root);
  return markers;
}

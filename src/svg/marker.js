// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/marker.js — <marker> defs parser + per-vertex instantiation.
//
// The parser collects sub-shape descriptions (segs + paint state) per
// marker child; instantiateMarker transforms each child to a specific
// endpoint along a stroked path, applying the marker's orient /
// refX/refY / markerUnits semantics.

import { svgElementName, elementChildren, isFirstWithId } from './utils.js';
import { parseShape } from './shape.js';
import { transformSegInto, matMul, IDENT } from './transform.js';
import { strokeFrameOf, ctmSingular } from '../bundle/strokeFrame.js';
import { pathBbox } from './bbox.js';
import { segStart, segEnd } from './segment.js';
import { segTangentAt } from './textures.js';
import { parseLength, parseLengthOr, parseAngle } from './length.js';
import { hasCssTransformProps } from './cssTransform.js';
import {
  getStyleProp,
  getShapeStyles,
  getStrokeWidth,
  getStrokeDashes,
  getCapsJoins,
  getFillRule,
  getInheritedStyleProp,
  inheritedChannelOpacities,
  parseAlphaOr,
  isDisplayed,
  isEffectivelyVisible,
} from './style.js';

/// Transform a marker's pre-collected sub-shapes to the vertex (vx, vy)
/// along a stroked path with tangent angle `tangentAngle` and current
/// stroke width `strokeWidth`. `isStart` marks marker-start placement —
/// per SVG 2 §13.4.3, orient="auto-start-reverse" flips 180° only there
/// (from marker-mid/end it behaves as plain "auto"). Returns a flat
/// array of sub-shapes with segs already in user space.
///
/// The path's own space. SVG places a marker in the user space of the path that references it -- the
/// vertex, the tangent angle and the stroke width are all LOCAL -- and the path's CTM then transforms the marker with the
/// path. So the caller passes local quantities and the path's `ctm`, and the marker's full transform is ctm times its
/// placement: under a non-uniform scale or a skew the marker is distorted as the path is, and under a reflection it is
/// mirrored. Each child's own stroke takes that transform as a shape's does: its stroke-width is in MARKER units,
/// so it scales with the placement (a markerUnits="strokeWidth" marker's child stroke included),
/// and a non-conformal transform draws it in stroke space through the frame N (bundle/strokeFrame.js).
export function markerPlacement(
  marker,
  vx,
  vy,
  tangentAngle,
  strokeWidth,
  isStart = false,
  ctm = IDENT,
) {
  if (!marker) return null;
  let angle = 0;
  const ori = marker.orient;
  if (ori === 'auto') angle = tangentAngle;
  else if (ori === 'auto-start-reverse') angle = tangentAngle + (isStart ? Math.PI : 0);
  else {
    // <angle>: a bare number is degrees; deg, grad, rad and turn convert. (parseLength already turns those units
    // into radians, so scaling its result again by pi/180 made orient="90deg" rotate 1.57 degrees.)
    angle = parseAngle(ori);
    if (!Number.isFinite(angle)) angle = 0;
  }
  // markerUnits=strokeWidth scales the marker by the shape's strokeWidth.
  // userSpaceOnUse leaves marker coords as-is.
  const unitScale = marker.units === 'userSpaceOnUse' ? 1 : strokeWidth;
  // viewBox maps marker content's local space to (markerWidth, markerHeight).
  // SVG 1.1 §7.7: a NEGATIVE viewBox width/height is an error and zero
  // disables rendering. `|| mw` already covered zero, NaN and a missing value,
  // but a negative passed straight through and silently MIRRORED the marker.
  // Require > 0, matching the three other viewBox parses in this package.
  //
  // The fit. The viewBox is fitted into the marker's viewport by preserveAspectRatio, whose default is
  // "xMidYMid meet": ONE scale, the smaller of the two ratios ("slice" the larger); only "none" stretches each axis on its
  // own. The alignment moves the fitted content inside the viewport, and refX/refY
  // are in the content's coordinates, so it moves the reference point with it: the placement (content point minus the
  // reference point, scaled) does not see it -- it only says what the marker's overflow clip keeps. With
  // NO viewBox the content is in the viewport's own units, unscaled: fitting it as if the viewBox were "0 0 3 3"
  // would draw any marker without one whose markerWidth or markerHeight is not 3 too big or too small by that ratio.
  const _vbW = marker.vbox ? marker.vbox[2] : NaN,
    _vbH = marker.vbox ? marker.vbox[3] : NaN;
  const hasVb = Number.isFinite(_vbW) && _vbW > 0 && Number.isFinite(_vbH) && _vbH > 0;
  let rx = hasVb ? marker.mw / _vbW : 1,
    ry = hasVb ? marker.mh / _vbH : 1;
  if (hasVb && marker.par !== 'none') {
    const k = marker.par === 'slice' ? Math.max(rx, ry) : Math.min(rx, ry);
    rx = k;
    ry = k;
  }
  const sx = rx * unitScale;
  const sy = ry * unitScale;
  // A zero (or non-finite) scale -- stroke-width 0 under markerUnits="strokeWidth" -- or a zero markerWidth /
  // markerHeight, which disables rendering with or without a viewBox, draws nothing: emit no shapes rather than shapes
  // collapsed to a point.
  if (!(marker.mw > 0 && marker.mh > 0)) return null;
  // ...and so does a viewBox of zero width or height (a negative one is an error, and no viewBox).
  if (
    marker.vbox &&
    marker.vbox.length === 4 &&
    marker.vbox.every(Number.isFinite) &&
    _vbW >= 0 &&
    _vbH >= 0 &&
    (_vbW === 0 || _vbH === 0)
  )
    return null;
  if (!(Number.isFinite(sx) && Number.isFinite(sy) && sx !== 0 && sy !== 0)) return null;
  // Build the marker-space → user-space affine. For a local point p:
  //   p' = vx + ca*sx*(p.x - refX) - sa*sy*(p.y - refY)
  //   p'.y = vy + sa*sx*(p.x - refX) + ca*sy*(p.y - refY)
  const ca = Math.cos(angle),
    sa = Math.sin(angle);
  const A = ca * sx;
  const B = sa * sx;
  const C = -sa * sy;
  const D = ca * sy;
  const E = vx - A * marker.refX - C * marker.refY;
  const F = vy - B * marker.refX - D * marker.refY;
  const M = ctm === IDENT ? [A, B, C, D, E, F] : matMul(ctm, [A, B, C, D, E, F]);
  // the child stroke's scale under M: its one scale when conformal, else sMax with the frame
  const frameCandidate = strokeFrameOf(M);
  const frame = frameCandidate?.representable === false ? null : frameCandidate;
  const scale =
    ctmSingular(M) || frameCandidate?.representable === false
      ? 0
      : frame
        ? frame.sMax
        : 0.5 * (Math.hypot(M[0], M[1]) + Math.hypot(M[2], M[3]));
  return { M, hasVb, k: rx, frame, scale };
}

/// A marker's sub-shape records at one vertex (the legacy flat form: segments pre-collected by parseMarkers, placed
/// by markerPlacement). A marker whose content needs the main walker (`marker.walked`) is placed by it instead.
export function instantiateMarker(
  marker,
  vx,
  vy,
  tangentAngle,
  strokeWidth,
  isStart = false,
  ctm = IDENT,
) {
  if (!marker || !marker.children.length) return [];
  const place = markerPlacement(marker, vx, vy, tangentAngle, strokeWidth, isStart, ctm);
  if (!place) return [];
  const { M, hasVb, k, frame, scale } = place;
  const out = [];
  out.viewport = markerViewport(marker, hasVb, k, M);
  for (const child of marker.children) {
    const xformed = [];
    for (const sg of child.segs) transformSegInto(sg, M, xformed);
    const sw = (child.sw || 0) * scale;
    out.push(
      Object.assign({}, child, {
        segs: xformed,
        sw,
        dashArray: child.dashArray.map((v) => v * scale),
        dashOffset: child.dashOffset * scale,
        strokeFrame: frame && child.sw > 0 ? frame.N : null,
        swMin: frame && child.sw > 0 ? child.sw * frame.sMin : sw,
      }),
    );
  }
  return out;
}

/// THE MARKER'S VIEWPORT CLIP, as the polygon it maps to in document space, or null for none. A marker draws
/// its content in a viewport markerWidth x markerHeight, and the UA style sheet gives <marker> `overflow: hidden` (SVG 2
/// §13.7.2), so content outside the viewport is clipped away unless the marker says `visible` (or `auto`). The viewport
/// is the rect [0, w] x [0, h] of its own coordinates; taken back through the viewBox fit it is, in content coordinates:
///   no viewBox   the rect itself (the content is in the viewport's units);
///   "none"       the viewBox;
///   meet/slice   the viewBox grown or cut to the viewport's shape about the alignment point -- with "meet" the viewport
///                reaches past the viewBox on one axis, with "slice" it keeps a band of it.
/// `k` is the fit's one scale (meet / slice), and `M` maps content to document space (the placement and the path's
/// CTM). Content wholly inside its viewport -- a stroke's reach included -- takes no clip: it would cut nothing.
export function markerViewport(marker, hasVb, k, M, force = false) {
  if (!marker.clips) return null;
  let r;
  if (!hasVb) r = [0, 0, marker.mw, marker.mh];
  else {
    const [vx, vy, vw, vh] = marker.vbox;
    if (marker.par === 'none') r = [vx, vy, vx + vw, vy + vh];
    else {
      const tx = (marker.mw - vw * k) * marker.align[0],
        ty = (marker.mh - vh * k) * marker.align[1];
      r = [vx - tx / k, vy - ty / k, vx + (marker.mw - tx) / k, vy + (marker.mh - ty) / k];
    }
  }
  let inside = !force;
  for (const c of force ? [] : marker.children) {
    // what a child paints: its fill, and its stroke, which reaches halfW out, a square cap sqrt(2) halfW, a miter
    // (clipped or not) up to sqrt(ml^2 + 1) halfW
    const stroked = c.sw > 0 && c.strokeRgba && c.strokeRgba[3] > 0;
    if (!stroked && !(c.fillRgba && c.fillRgba[3] > 0)) continue;
    const bb = pathBbox(c.segs);
    const reach = stroked ? 0.5 * c.sw * strokeReachOver(c) : 0;
    if (!(
      bb[0] - reach >= r[0] &&
      bb[1] - reach >= r[1] &&
      bb[2] + reach <= r[2] &&
      bb[3] + reach <= r[3]
    )) {
      inside = false;
      break;
    }
  }
  if (inside) return null;
  const ap = (x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  return [ap(r[0], r[1]), ap(r[2], r[1]), ap(r[2], r[3]), ap(r[0], r[3])];
}

/// How far a child's stroke reaches past its path, over its half-width: 1 at a side, a butt or round end and a round or
/// bevel join; sqrt(2) at a square cap's corner; at a miter join 1 / sin(theta / 2) where that is within the limit (a
/// bevel past it); a clipped miter (miter-clip) past the limit sqrt(ml^2 + 1), its clip line's corners; and an arcs
/// join, whose arcs can outrun the straight miter, sqrt(ml^2 + 1) at every join.
function strokeReachOver(c) {
  let k = c.capStyle === 2 ? Math.SQRT2 : 1;
  if (c.joinStyle === 1 || c.joinStyle === 2) return k;
  const ml = Math.max(Number.isFinite(c.miterLimit) ? c.miterLimit : 4, 1),
    clipped = Math.sqrt(ml * ml + 1);
  if (c.joinStyle === 4) return Math.max(k, clipped);
  const unit = (v) => {
    const l = Math.hypot(v[0], v[1]);
    return l > 0 ? [v[0] / l, v[1] / l] : v;
  };
  const join = (a, b) => {
    const tA = unit(segTangentAt(a, false)),
      tB = unit(segTangentAt(b, true));
    const s2 = Math.sqrt(Math.max(0, 0.5 * (1 + tA[0] * tB[0] + tA[1] * tB[1]))); // sin of half the interior angle
    const ratio = s2 > 0 ? 1 / s2 : Infinity;
    k = Math.max(k, ratio <= ml ? ratio : c.joinStyle === 3 ? clipped : 1);
  };
  const segs = c.segs;
  let first = 0;
  for (let i = 0; i < segs.length; i++) {
    const last = i + 1 === segs.length || segs[i + 1].subStart;
    if (!last) join(segs[i], segs[i + 1]);
    else {
      // a closed subpath joins its last segment to its first
      const p = segEnd(segs[i]),
        q = segStart(segs[first]);
      if (i > first && p[0] === q[0] && p[1] === q[1]) join(segs[i], segs[first]);
      first = i + 1;
    }
  }
  return k;
}

/// Whether a marker's content needs the main walker (importWalk.js walkMarkerContent) instead of the flat records
/// collectShape builds: those carry geometry and a SOLID paint only. Content with a transform (attribute or CSS), a
/// <use>, <image>, <text>, nested <svg> or <switch>, a gradient or pattern paint, a compositing group (opacity,
/// mix-blend-mode or isolation on a container, or a blend mode / isolation anywhere), or a clip-path, mask or filter
/// is walked; plain solid-paint shapes keep the flat form, so their output does not move.
function markerNeedsWalker(el, viewport) {
  const check = (n, pf, ps) => {
    const tag = svgElementName(n);
    if (
      tag === 'defs' ||
      tag === 'clippath' ||
      tag === 'mask' ||
      tag === 'lineargradient' ||
      tag === 'radialgradient' ||
      tag === 'pattern' ||
      tag === 'symbol' ||
      tag === 'marker' ||
      tag === 'filter'
    )
      return false;
    if (tag === 'use' || tag === 'image' || tag === 'text' || tag === 'svg' || tag === 'switch')
      return true;
    if (n.hasAttribute('transform') || hasCssTransformProps(n)) return true;
    const f = getStyleProp(n, 'fill', pf),
      s = getStyleProp(n, 'stroke', ps);
    if (/url\(/i.test(f) || /url\(/i.test(s)) return true;
    // context-fill / context-stroke take the paints of the path the marker is on: known only where it is instantiated
    if (/^\s*context-(?:fill|stroke)\s*$/i.test(f) || /^\s*context-(?:fill|stroke)\s*$/i.test(s))
      return true;
    // The flat records know nothing of what does not render, of pathLength, of vector-effect or of paint-order.
    if (
      !isDisplayed(n) ||
      !isEffectivelyVisible(n) ||
      n.hasAttribute('systemLanguage') ||
      n.hasAttribute('requiredExtensions') ||
      n.hasAttribute('pathLength') ||
      getStyleProp(n, 'vector-effect', '') ||
      (getInheritedStyleProp(n, 'paint-order', 'normal') || 'normal').trim().toLowerCase() !==
        'normal'
    )
      return true;
    for (const name of ['clip-path', 'mask', 'mask-image', 'filter']) {
      const v = (getStyleProp(n, name, '') || '').trim();
      if (v && v !== 'none') return true;
    }
    const blend = (getStyleProp(n, 'mix-blend-mode', 'normal') || 'normal').trim().toLowerCase();
    const isol = (getStyleProp(n, 'isolation', 'auto') || 'auto').trim().toLowerCase();
    if (blend !== 'normal' || isol === 'isolate') return true;
    const ks = elementChildren(n);
    if (ks.length) {
      const op = parseAlphaOr(getStyleProp(n, 'opacity', '1'), 1);
      if (Number.isFinite(op) && op < 1) return true;
    }
    for (let i = 0; i < ks.length; i++) if (check(ks[i], f, s)) return true;
    return false;
  };
  const pF = getInheritedStyleProp(el, 'fill', 'black'),
    pS = getInheritedStyleProp(el, 'stroke', 'none');
  const kids = elementChildren(el);
  for (let i = 0; i < kids.length; i++) if (check(kids[i], pF, pS)) return true;
  return false;
}

/// Walk <marker> defs into a per-id registry. Each entry holds the
/// marker's geometry attrs + a pre-parsed list of sub-shape children
/// (segs + paint state). Children are emitted in document order; the
/// per-shape walker calls instantiateMarker at marker-start / mid /
/// end vertex positions during stroke fan-out.
export function parseMarkers(root) {
  const markers = Object.create(null); // keyed by authored ids
  const visit = (el) => {
    const tag = svgElementName(el);
    if (tag === 'marker') {
      const id = el.getAttribute('id');
      if (id && isFirstWithId(root, el, id)) {
        // no viewBox, no fit (instantiateMarker): the content is in the viewport's own units
        const vbAttr = el.getAttribute('viewBox');
        const vbox = vbAttr
          ? vbAttr
              .trim()
              .split(/[\s,]+/)
              .map(parseFloat)
          : null;
        // preserveAspectRatio: 'none', or a uniform fit -- 'meet' (the default) or 'slice'; the alignment only
        // positions the fitted content, which the placement does not see (instantiateMarker)
        const parTok = (el.getAttribute('preserveAspectRatio') || '')
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t && t !== 'defer');
        const par = parTok[0] === 'none' ? 'none' : parTok.includes('slice') ? 'slice' : 'meet';
        // the alignment, for the overflow clip: xMin / xMid / xMax and yMin / yMid / yMax, xMidYMid by default
        const al = parTok[0] && parTok[0] !== 'none' ? parTok[0] : 'xmidymid';
        const align = [
          al.startsWith('xmin') ? 0 : al.startsWith('xmax') ? 1 : 0.5,
          al.endsWith('ymin') ? 0 : al.endsWith('ymax') ? 1 : 0.5,
        ];
        // `overflow`: `visible` and `auto` show the content outside the viewport; anything else, the initial `hidden`
        // included, clips it
        const ov = (getStyleProp(el, 'overflow', '') || el.getAttribute('overflow') || '')
          .trim()
          .toLowerCase();
        const clips = ov !== 'visible' && ov !== 'auto';
        const mw = parseLengthOr(el.getAttribute('markerWidth') || '3', 3);
        const mh = parseLengthOr(el.getAttribute('markerHeight') || '3', 3);
        // refX / refY: a coordinate, or a keyword for the viewBox's edge or middle, the viewport's without a viewBox (SVG 2 13.7.1).
        const refOf = (name, near, far, start, size, viewportSize) => {
          const raw = (el.getAttribute(name) || '0').trim();
          const span = size > 0 ? [start, size] : [0, viewportSize];
          return raw === near
            ? span[0]
            : raw === 'center'
              ? span[0] + span[1] / 2
              : raw === far
                ? span[0] + span[1]
                : parseLengthOr(raw, 0);
        };
        const vb4 = vbox && vbox.length === 4 && vbox.every(Number.isFinite) ? vbox : [0, 0, 0, 0];
        const refX = refOf('refX', 'left', 'right', vb4[0], vb4[2], mw);
        const refY = refOf('refY', 'top', 'bottom', vb4[1], vb4[3], mh);
        const units = (el.getAttribute('markerUnits') || 'strokeWidth').trim();
        const orient = (el.getAttribute('orient') || '0').trim();

        const viewport = {
          parentWidth: vbox && vbox[2] > 0 ? vbox[2] : mw,
          parentHeight: vbox && vbox[3] > 0 ? vbox[3] : mh,
        };
        const children = [];
        const collectShape = (n, pf, ps, pw, pfo, pso) => {
          const ntag = svgElementName(n);
          if (
            ntag === 'defs' ||
            ntag === 'clippath' ||
            ntag === 'mask' ||
            ntag === 'lineargradient' ||
            ntag === 'radialgradient' ||
            ntag === 'pattern' ||
            ntag === 'symbol' ||
            ntag === 'marker' ||
            ntag === 'filter'
          )
            return;
          const f = getStyleProp(n, 'fill', pf);
          const s = getStyleProp(n, 'stroke', ps);
          const w = getStrokeWidth(n, pw, viewport, false);
          const { fo, so } = inheritedChannelOpacities(n, pfo, pso);
          if (['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(ntag)) {
            const segs = parseShape(n, viewport);
            if (segs.length) {
              const styles = getShapeStyles(n, f, s, w, fo, so, viewport);
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
                ...getStrokeDashes(n, viewport),
                flagsShape: 0,
                clipId: 0,
                maskId: 0,
              });
            }
          }
          const ks = elementChildren(n);
          for (let i = 0; i < ks.length; i++) collectShape(ks[i], f, s, w, fo, so);
        };
        // Marker content inherits from the <marker> and ITS ancestors, never from the shape that
        // references it (SVG 2 §13.7.2), so the DOM walk is the right one here: fill-/stroke-opacity
        // and the paint itself -- starting fill, stroke and stroke-width from black / none / 1
        // would draw a <marker fill="red">'s content black.
        const pF = getInheritedStyleProp(el, 'fill', 'black');
        const pS = getInheritedStyleProp(el, 'stroke', 'none');
        const pW = getStrokeWidth(el, 1, viewport);
        const mfo = parseAlphaOr(getInheritedStyleProp(el, 'fill-opacity', null), 1);
        const mso = parseAlphaOr(getInheritedStyleProp(el, 'stroke-opacity', null), 1);
        const kids = elementChildren(el);
        for (let i = 0; i < kids.length; i++) {
          collectShape(kids[i], pF, pS, pW, mfo, mso);
        }
        markers[id] = {
          vbox,
          par,
          align,
          clips,
          refX,
          refY,
          mw,
          mh,
          units,
          orient,
          children,
          el,
          viewport,
          walked: markerNeedsWalker(el, viewport),
        };
      }
    }
    const kids = elementChildren(el);
    for (let i = 0; i < kids.length; i++) visit(kids[i]);
  };
  visit(root);
  return markers;
}

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// glyphReader.js — glyph outline extractor.
//
// Simple-glyph contour walker with TTF-midpoint-trick handling, plus
// composite-glyph recursion with 2x2 affine + translation. Emits
// SEG_QUAD natively: the coverage walker's quadratic root finder is
// numerically more robust than the cubic solver on the near-degenerate
// cubics that TTF quad→cubic elevation produces (cy.x ≈ 0 makes
// Cardano's discriminant flip sign quasi-periodically along inner
// contours, producing dashed-hairline coverage errors).

import { mkLine, mkQuad, mkCubic } from '../primitives/seg.js';
import { getReaderCtor, tryNewReader } from './readerRegistry.js';
import { mantleWarn } from '../core/diagnostics.js';
import { noteMalformedTable } from './fontTableGuard.js';

// CFF outlines + gvar deltas are opt-in (see readerRegistry.js). A
// glyf-only TrueType consumer never pulls the ~30 KB CFF interpreter
// or the ~10 KB gvar reader. The full `@kontek/mantle/font` barrel and
// the `font/formats/cff` + `font/variations` subpaths register them.
let _warnedNoCff = false;
function _buildCffReader(tables, which /* 'cff' | 'cff2' */) {
  const Ctor = getReaderCtor('cff');
  if (!Ctor) {
    if (!_warnedNoCff) {
      _warnedNoCff = true;
      mantleWarn(
        '[mantle] CFF/CFF2-outline font loaded but the CFF reader is not ' +
          'registered — glyphs will be blank. Import ' +
          '`@kontek/mantle/font/formats/cff` and call registerCffReader(), ' +
          'or import `@kontek/mantle/font` (registers everything).',
      );
    }
    return null;
  }
  const rec = tables[which]; // [offset, length]
  // A CFF that does not parse has no outlines to offer, and its glyphs draw blank.
  try {
    return new Ctor(tables.bytes, rec[0], rec[1], which === 'cff' ? 1 : 2);
  } catch (e) {
    noteMalformedTable(
      tables,
      which === 'cff' ? 'CFF ' : 'CFF2',
      e,
      'unreadable, its glyphs blank',
    );
    return null;
  }
}

// Simple-glyph flag bits.
const F_ON_CURVE = 0x01;
const F_X_SHORT = 0x02;
const F_Y_SHORT = 0x04;
const F_REPEAT = 0x08;
const F_X_SAME_OR_POS = 0x10;
const F_Y_SAME_OR_POS = 0x20;

// Composite-glyph flag bits.
const C_ARG_1_AND_2_ARE_WORDS = 0x0001;
const C_ARGS_ARE_XY_VALUES = 0x0002;
const C_WE_HAVE_A_SCALE = 0x0008;
const C_MORE_COMPONENTS = 0x0020;
const C_WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const C_WE_HAVE_A_TWO_BY_TWO = 0x0080;
const C_SCALED_COMPONENT_OFFSET = 0x0800;
const C_UNSCALED_COMPONENT_OFFSET = 0x1000;

/**
 * @param {object} tables result of parseTtfTables()
 * @param {number} glyphIndex
 * @param {number[]} [varCoords]  Normalized variation coords (F2DOT14
 *   ∈ [-1,+1] per axis). When non-null and the font has gvar, per-glyph
 *   point deltas are applied before contour-to-seg conversion. Pass
 *   null (default) for static rendering.
 * @returns {Array|null} array of segs (or null for empty glyphs)
 */
export function readGlyph(tables, glyphIndex, varCoords = null) {
  // CFF-outlined fonts (.otf) take a separate decode path; glyf table
  // is absent so glyphRange would return [0,0] regardless. The
  // CffReader is built lazily on first access and cached on the
  // tables object.
  // `undefined` = not yet attempted; `null` = attempted but no reader
  // registered (blank glyph, warned once). Cache either outcome.
  if (tables.cff) {
    if (tables._cffReader === undefined) tables._cffReader = _buildCffReader(tables, 'cff');
    // CFF1: static outlines only. varCoords ignored.
    return tables._cffReader ? tables._cffReader.readGlyph(glyphIndex) : null;
  }
  if (tables.cff2) {
    if (tables._cff2Reader === undefined) tables._cff2Reader = _buildCffReader(tables, 'cff2');
    if (!tables._cff2Reader) return null;
    // CFF2: outlines morph via blend operators consuming the VarStore
    // at the supplied normalized coords. When varCoords is null the
    // charstring's default values flow through unchanged.
    const nCoords = varCoords != null ? varCoords : null;
    return tables._cff2Reader.readGlyph(glyphIndex, nCoords);
  }
  // Lazily build the gvar reader the first time a glyph asks for
  // variation. Static reads skip the parse entirely; an unregistered
  // gvar reader (null) leaves outlines at their default position.
  if (varCoords != null && tables.gvar && tables._gvarReader === undefined) {
    tables._gvarReader = tryNewReader('gvar', tables); // null if unregistered
  }
  const glyph = _readGlyph(tables, glyphIndex, 0, varCoords, { visits: 0, work: 0 });
  if (!glyph) return glyph;
  const origin = glyph._originX || 0;
  delete glyph._originX;
  delete glyph._ttPoints;
  if (!origin) return glyph;
  const point = (p) => [p[0] - origin, p[1]];
  return glyph.map((seg) =>
    seg.type === 0
      ? mkLine(point(seg.p1), point(seg.p2))
      : seg.type === 1
        ? mkQuad(point(seg.p1), point(seg.p2), point(seg.p3))
        : mkCubic(point(seg.p1), point(seg.p2), point(seg.p3), point(seg.p4)),
  );
}

/// A corrupt glyf/loca can make composites reference each other with a fan-out
/// of N per level (N^16 reads) or name tens of thousands of components. One
/// top-level glyph read may visit this many glyphs, carry this many components
/// in one composite, and copy this many segments across all its levels.
export const MAX_GLYPH_VISITS = 1024;
export const MAX_COMPOSITE_COMPONENTS = 1024;
export const MAX_COMPOSITE_WORK = 1 << 21;

/// Thrown for a glyph outline that is malformed or exceeds the composite budget above.
export class GlyphOutlineError extends RangeError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GlyphOutlineError';
  }
}

function _readGlyph(tables, gid, depth, varCoords, budget) {
  if (depth > 16) throw new GlyphOutlineError('Composite glyph recursion too deep');
  if (++budget.visits > MAX_GLYPH_VISITS)
    throw new GlyphOutlineError(
      `Composite glyph ${gid} exceeds ${MAX_GLYPH_VISITS} component visits`,
    );
  const [off, len] = tables.glyphRange(gid);
  if (len === 0) return null;
  const v = tables.view;
  const numContours = v.getInt16(off, false);
  if (numContours === 0) return null;
  if (numContours > 0) return _readSimple(tables, off + 10, numContours, gid, varCoords, depth > 0);
  return _readComposite(tables, off + 10, depth, varCoords, gid, budget);
}

function _parseSimpleCoords(tables, p, numContours) {
  const v = tables.view,
    b = tables.bytes;

  const endPts = new Array(numContours);
  for (let i = 0; i < numContours; i++) {
    endPts[i] = v.getUint16(p, false);
    p += 2;
  }
  const numPoints = endPts[numContours - 1] + 1;

  const instrLen = v.getUint16(p, false);
  p += 2 + instrLen;

  const flags = new Uint8Array(numPoints);
  let fi = 0;
  while (fi < numPoints) {
    const fl = b[p++];
    flags[fi++] = fl;
    if (fl & F_REPEAT) {
      const repeat = b[p++];
      for (let k = 0; k < repeat && fi < numPoints; k++) flags[fi++] = fl;
    }
  }

  const xs = new Int32Array(numPoints);
  let x = 0;
  for (let i = 0; i < numPoints; i++) {
    const fl = flags[i];
    if (fl & F_X_SHORT) {
      let vv = b[p++];
      if (!(fl & F_X_SAME_OR_POS)) vv = -vv;
      x += vv;
    } else if (!(fl & F_X_SAME_OR_POS)) {
      x += v.getInt16(p, false);
      p += 2;
    }
    xs[i] = x;
  }

  const ys = new Int32Array(numPoints);
  let y = 0;
  for (let i = 0; i < numPoints; i++) {
    const fl = flags[i];
    if (fl & F_Y_SHORT) {
      let vv = b[p++];
      if (!(fl & F_Y_SAME_OR_POS)) vv = -vv;
      y += vv;
    } else if (!(fl & F_Y_SAME_OR_POS)) {
      y += v.getInt16(p, false);
      p += 2;
    }
    ys[i] = y;
  }

  // The loops above read flags and short coords straight off the byte array
  // for speed, which skips the bounds check every DataView read here performs.
  // Unchecked, a truncated glyph would behave two different ways for the same
  // corruption: a long coord (getInt16) throws RangeError, while a short one
  // reads `undefined` and — because xs/ys are Int32Array — silently stores 0,
  // yielding a wrong-but-finite outline with no error anywhere.
  //
  // `p` only ever advances, so if any read went past the end it is still past
  // the end now: one comparison per glyph makes both paths fail the same way,
  // without putting a check in the per-point loops.
  if (p > b.length) {
    throw new RangeError(`glyph outline truncated: needed ${p} bytes of ${b.length}`);
  }
  return { numPoints, xs, ys, flags, endPts };
}

function _readSimple(tables, p, numContours, gid, varCoords, retainPoints = false) {
  const { numPoints, xs, ys, flags, endPts } = _parseSimpleCoords(tables, p, numContours);
  let originX = tables.view.getInt16(p - 8, false) - tables.glyphLeftSideBearing(gid);
  // Apply gvar deltas BEFORE contour-to-seg conversion. Phantom
  // points (LSB / RSB / TSB / BSB) are seeded from metrics/bbox so
  // shared-point tuples that touch phantoms apply correctly.
  if (varCoords != null && tables._gvarReader && tables._gvarReader.hasGvar) {
    const [goff] = tables.glyphRange(gid);
    const v = tables.view;
    const xMin = v.getInt16(goff + 2, false);
    const yMin = v.getInt16(goff + 4, false);
    const yMax = v.getInt16(goff + 8, false);
    const lsb = tables.glyphLeftSideBearing(gid);
    const adv = tables.glyphAdvanceWidth(gid);
    const totalPoints = numPoints + 4;
    const pts = new Float64Array(totalPoints * 2);
    for (let i = 0; i < numPoints; i++) {
      pts[i * 2] = xs[i];
      pts[i * 2 + 1] = ys[i];
    }
    const ph = numPoints;
    pts[ph * 2] = xMin - lsb;
    pts[ph * 2 + 1] = 0;
    pts[(ph + 1) * 2] = xMin - lsb + adv;
    pts[(ph + 1) * 2 + 1] = 0;
    pts[(ph + 2) * 2] = xMin;
    pts[(ph + 2) * 2 + 1] = yMax;
    pts[(ph + 3) * 2] = xMin;
    pts[(ph + 3) * 2 + 1] = yMin;
    tables._gvarReader.applyDeltas(gid, pts, numPoints, varCoords, endPts);
    originX = Math.round(pts[ph * 2]);
    for (let i = 0; i < numPoints; i++) {
      xs[i] = Math.round(pts[i * 2]);
      ys[i] = Math.round(pts[i * 2 + 1]);
    }
  }

  const glyph = _contoursToSegs(xs, ys, flags, endPts);
  glyph._originX = originX;
  if (retainPoints) glyph._ttPoints = { x: xs, y: ys };
  return glyph;
}

function _contoursToSegs(xs, ys, flags, endPts) {
  const segs = [];
  let contourStart = 0;
  // Valid contours tile the points, so the walk totals numPoints. Descending
  // end points restart a contour at an earlier point and re-walk it: bound the
  // total instead of letting 65535 contours each walk 65536 points.
  let walked = 0;
  const walkLimit = 2 * xs.length + 16;
  for (let c = 0; c < endPts.length; c++) {
    const contourEnd = endPts[c];
    const n = contourEnd - contourStart + 1;
    if (n < 2) {
      contourStart = contourEnd + 1;
      continue;
    }
    walked += n;
    if (walked > walkLimit)
      throw new GlyphOutlineError(
        'Simple glyph contours re-walk their points (end points are not ascending)',
      );
    const idx = (k) => contourStart + (((k % n) + n) % n);

    const firstOn = (flags[idx(0)] & F_ON_CURVE) !== 0;
    let startX, startY, seedK;
    if (firstOn) {
      startX = xs[idx(0)];
      startY = ys[idx(0)];
      seedK = 0;
    } else {
      const lastOn = (flags[idx(n - 1)] & F_ON_CURVE) !== 0;
      if (lastOn) {
        startX = xs[idx(n - 1)];
        startY = ys[idx(n - 1)];
        seedK = -1;
      } else {
        startX = (xs[idx(n - 1)] + xs[idx(0)]) * 0.5;
        startY = (ys[idx(n - 1)] + ys[idx(0)]) * 0.5;
        seedK = -1;
      }
    }

    let curX = startX,
      curY = startY;

    const steps = n;
    let k = seedK + 1;
    for (let s = 0; s < steps; s++) {
      const i = idx(k);
      const on = (flags[i] & F_ON_CURVE) !== 0;
      const px = xs[i],
        py = ys[i];
      if (on) {
        if (curX !== px || curY !== py) segs.push(mkLine([curX, curY], [px, py]));
        curX = px;
        curY = py;
      } else {
        const i2 = idx(k + 1);
        const on2 = (flags[i2] & F_ON_CURVE) !== 0;
        let endX, endY;
        if (on2) {
          endX = xs[i2];
          endY = ys[i2];
          k++;
          s++;
        } else {
          endX = (px + xs[i2]) * 0.5;
          endY = (py + ys[i2]) * 0.5;
        }
        segs.push(mkQuad([curX, curY], [px, py], [endX, endY]));
        curX = endX;
        curY = endY;
      }
      k++;
    }

    if (curX !== startX || curY !== startY) segs.push(mkLine([curX, curY], [startX, startY]));

    contourStart = contourEnd + 1;
  }
  return segs;
}

function _readComposite(tables, p, depth, varCoords, gid, budget) {
  const glyphOffset = p - 10;
  let originX = tables.view.getInt16(glyphOffset + 2, false) - tables.glyphLeftSideBearing(gid);
  const v = tables.view,
    b = tables.bytes;
  // Pass 1: parse every component record. Deferring the child reads lets
  // the composite's own gvar tuple apply first — its "points" are the
  // component dx/dy offsets, so a variable font moves accents with the
  // axes (skipping this froze components at their default positions).
  const comps = [];
  let flags,
    metricOwner = -1;
  do {
    flags = v.getUint16(p, false);
    const childIdx = v.getUint16(p + 2, false);
    if ((flags & 0x0200) !== 0) metricOwner = childIdx;
    p += 4;

    let dx, dy;
    const isXY = (flags & C_ARGS_ARE_XY_VALUES) !== 0;
    if (flags & C_ARG_1_AND_2_ARE_WORDS) {
      const a1 = isXY ? v.getInt16(p, false) : v.getUint16(p, false);
      const a2 = isXY ? v.getInt16(p + 2, false) : v.getUint16(p + 2, false);
      dx = a1;
      dy = a2;
      p += 4;
    } else {
      // Byte-sized args: signed when ARGS_ARE_XY_VALUES, unsigned otherwise.
      // DataView, not b[p]: these become plain numbers (no Int32Array coercion
      // to hide it), so an out-of-range read would reach the transform as NaN.
      const a1raw = v.getUint8(p),
        a2raw = v.getUint8(p + 1);
      const sext = (n) => (n & 0x80 ? n - 0x100 : n);
      dx = isXY ? sext(a1raw) : a1raw;
      dy = isXY ? sext(a2raw) : a2raw;
      p += 2;
    }
    const parentPoint = isXY ? -1 : dx,
      childPoint = isXY ? -1 : dy;
    if (!isXY) {
      dx = 0;
      dy = 0;
    }

    let xx = 1,
      xy = 0,
      yx = 0,
      yy = 1;
    if (flags & C_WE_HAVE_A_SCALE) {
      const s = v.getInt16(p, false) / 16384;
      p += 2;
      xx = s;
      yy = s;
    } else if (flags & C_WE_HAVE_AN_X_AND_Y_SCALE) {
      xx = v.getInt16(p, false) / 16384;
      yy = v.getInt16(p + 2, false) / 16384;
      p += 4;
    } else if (flags & C_WE_HAVE_A_TWO_BY_TWO) {
      xx = v.getInt16(p, false) / 16384;
      yx = v.getInt16(p + 2, false) / 16384;
      xy = v.getInt16(p + 4, false) / 16384;
      yy = v.getInt16(p + 6, false) / 16384;
      p += 8;
    }
    // SCALED_COMPONENT_OFFSET: the offset goes through the component's matrix too (Apple's convention; fontTools and HarfBuzz read it
    // so). The default, and both flags together, leave it unscaled.
    const scaledOffset =
      (flags & (C_SCALED_COMPONENT_OFFSET | C_UNSCALED_COMPONENT_OFFSET)) ===
      C_SCALED_COMPONENT_OFFSET;
    comps.push({ childIdx, dx, dy, xx, xy, yx, yy, isXY, parentPoint, childPoint, scaledOffset });
    if (comps.length > MAX_COMPOSITE_COMPONENTS)
      throw new GlyphOutlineError(
        `Composite glyph ${gid} has more than ${MAX_COMPOSITE_COMPONENTS} components`,
      );
  } while (flags & C_MORE_COMPONENTS);

  // The composite's own gvar deltas (per-component offset points + the
  // 4 phantoms). No IUP for composites (contourEnds null); rounding
  // matches the simple path (Math.round — half toward +∞).
  if (varCoords != null && tables._gvarReader && tables._gvarReader.hasGvar && gid != null) {
    const pts = new Float64Array((comps.length + 4) * 2);
    for (let k = 0; k < comps.length; k++) {
      pts[k * 2] = comps[k].dx;
      pts[k * 2 + 1] = comps[k].dy;
    }
    pts[comps.length * 2] = originX;
    pts[(comps.length + 1) * 2] = originX + tables.glyphAdvanceWidth(gid);
    tables._gvarReader.applyDeltas(gid, pts, comps.length, varCoords, null);
    originX = Math.round(pts[comps.length * 2]);
    for (let k = 0; k < comps.length; k++) {
      if (!comps[k].isXY) continue; // point-matching offsets don't vary
      comps[k].dx = Math.round(pts[k * 2]);
      comps[k].dy = Math.round(pts[k * 2 + 1]);
    }
  }

  if (depth === 0 && metricOwner >= 0 && varCoords?.some((value) => value !== 0)) {
    const inherited = glyphGvarMetricFu(metricOwner, tables, varCoords, 3, 0);
    if (inherited != null) originX = inherited;
  }

  const out = [],
    pointX = [],
    pointY = [];
  for (const c of comps) {
    const child = _readGlyph(tables, c.childIdx, depth + 1, varCoords, budget);
    if (child) {
      budget.work += child.length + (child._ttPoints ? child._ttPoints.x.length : 0);
      if (budget.work > MAX_COMPOSITE_WORK)
        throw new GlyphOutlineError(`Composite glyph ${gid} exceeds its outline work budget`);
      const { xx, xy, yx, yy } = c;
      let { dx, dy } = c;
      const points = child._ttPoints;
      if (!c.isXY) {
        if (!points || c.parentPoint >= pointX.length || c.childPoint >= points.x.length)
          throw new Error('Invalid TrueType component point attachment');
        const x = points.x[c.childPoint],
          y = points.y[c.childPoint];
        dx = pointX[c.parentPoint] - (xx * x + xy * y);
        dy = pointY[c.parentPoint] - (yx * x + yy * y);
      } else if (c.scaledOffset) {
        const ox = dx,
          oy = dy;
        dx = xx * ox + xy * oy;
        dy = yx * ox + yy * oy;
      }
      if (points)
        for (let i = 0; i < points.x.length; i++) {
          pointX.push(xx * points.x[i] + xy * points.y[i] + dx);
          pointY.push(yx * points.x[i] + yy * points.y[i] + dy);
        }
      const X = (q) => [xx * q[0] + xy * q[1] + dx, yx * q[0] + yy * q[1] + dy];
      for (const seg of child) {
        if (seg.type === 0) out.push(mkLine(X(seg.p1), X(seg.p2)));
        else if (seg.type === 1) out.push(mkQuad(X(seg.p1), X(seg.p2), X(seg.p3)));
        else if (seg.type === 2) out.push(mkCubic(X(seg.p1), X(seg.p2), X(seg.p3), X(seg.p4)));
      }
    }
  }

  if (!out.length && !pointX.length) return null;
  out._ttPoints = { x: pointX, y: pointY };
  out._originX = originX;
  return out;
}

/// Variation-aware advance from explicitly varied gvar phantom points.
export function glyphGvarAdvanceFu(gid, tables, nCoords, vertical = false) {
  return glyphGvarMetricFu(gid, tables, nCoords, vertical ? 1 : 0);
}

/// Top phantom in font units, including metric ownership and optional variation.
export function glyphVerticalOriginFu(gid, tables, nCoords = null) {
  return glyphGvarMetricFu(gid, tables, nCoords, 2);
}

function glyphGvarMetricFu(gid, tables, nCoords, metric, depth = 0) {
  if (depth > 16) return null;
  if ((nCoords == null && metric !== 2) || gid < 0 || gid >= tables.numGlyphs) return null;
  const varied = nCoords != null && nCoords.some((value) => value !== 0);
  if ((varied || metric !== 2) && tables._gvarReader === undefined)
    tables._gvarReader = tryNewReader('gvar', tables);
  const gvar = tables._gvarReader;
  if (metric !== 2 && !gvar?.hasGvar) return null;
  const [goff, len] = tables.glyphRange(gid);
  const v = tables.view;
  let numPoints = 0,
    xMin = 0,
    yMax = 0;
  if (len) {
    if (len < 10) return null;
    xMin = v.getInt16(goff + 2, false);
    yMax = v.getInt16(goff + 8, false);
    const contours = v.getInt16(goff, false);
    if (contours > 0) {
      if (10 + contours * 2 > len) return null;
      numPoints = v.getUint16(goff + 10 + (contours - 1) * 2, false) + 1;
    } else if (contours < 0) {
      let p = goff + 10,
        flags,
        metricChild = -1;
      do {
        if (p + 4 > goff + len) return null;
        flags = v.getUint16(p, false);
        const child = v.getUint16(p + 2, false);
        p += 4 + (flags & C_ARG_1_AND_2_ARE_WORDS ? 4 : 2);
        const transformBytes =
          flags & C_WE_HAVE_A_SCALE
            ? 2
            : flags & C_WE_HAVE_AN_X_AND_Y_SCALE
              ? 4
              : flags & C_WE_HAVE_A_TWO_BY_TWO
                ? 8
                : 0;
        if (p + transformBytes > goff + len) return null;
        if ((flags & 0x0200) !== 0) {
          metricChild = child;
        }
        p += transformBytes;
        numPoints++;
      } while (flags & C_MORE_COMPONENTS);
      // The last USE_MY_METRICS component owns the composite phantoms.
      // Its positioning offsets and the parent's phantom deltas do not apply.
      if (metricChild >= 0) {
        const inherited = glyphGvarMetricFu(metricChild, tables, nCoords, metric, depth + 1);
        return inherited;
      }
    }
  }
  if (!varied || !gvar?.hasGvar) {
    return metric === 2
      ? yMax + tables.glyphTopSideBearing(gid)
      : metric === 3
        ? xMin - tables.glyphLeftSideBearing(gid)
        : metric === 1
          ? tables.glyphAdvanceHeight(gid)
          : tables.glyphAdvanceWidth(gid);
  }
  const ph = numPoints,
    pts = new Float64Array((numPoints + 4) * 2);
  const left = xMin - tables.glyphLeftSideBearing(gid);
  const top = yMax + tables.glyphTopSideBearing(gid);
  pts[ph * 2] = left;
  pts[(ph + 1) * 2] = left + tables.glyphAdvanceWidth(gid);
  pts[(ph + 2) * 2 + 1] = top;
  pts[(ph + 3) * 2 + 1] = top - tables.glyphAdvanceHeight(gid);
  // Phantom points take only explicit deltas. Their values do not require
  // decoding outline coordinates or interpolating untouched contour points.
  gvar.applyDeltas(gid, pts, numPoints, nCoords, null);
  return Math.round(
    metric === 2
      ? pts[(ph + 2) * 2 + 1]
      : metric === 3
        ? pts[ph * 2]
        : metric === 1
          ? pts[(ph + 2) * 2 + 1] - pts[(ph + 3) * 2 + 1]
          : pts[(ph + 1) * 2] - pts[ph * 2],
  );
}

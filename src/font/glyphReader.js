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
        "`@kontek/mantle/font/formats/cff` and call registerCffReader(), " +
        'or import `@kontek/mantle/font` (registers everything).');
    }
    return null;
  }
  const rec = tables[which];               // [offset, length]
  return new Ctor(tables.bytes, rec[0], rec[1], which === 'cff' ? 1 : 2);
}

// Simple-glyph flag bits.
const F_ON_CURVE        = 0x01;
const F_X_SHORT         = 0x02;
const F_Y_SHORT         = 0x04;
const F_REPEAT          = 0x08;
const F_X_SAME_OR_POS   = 0x10;
const F_Y_SAME_OR_POS   = 0x20;

// Composite-glyph flag bits.
const C_ARG_1_AND_2_ARE_WORDS  = 0x0001;
const C_ARGS_ARE_XY_VALUES     = 0x0002;
const C_WE_HAVE_A_SCALE        = 0x0008;
const C_MORE_COMPONENTS        = 0x0020;
const C_WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const C_WE_HAVE_A_TWO_BY_TWO   = 0x0080;

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
    if (tables._cffReader === undefined)
      tables._cffReader = _buildCffReader(tables, 'cff');
    // CFF1: static outlines only. varCoords ignored.
    return tables._cffReader ? tables._cffReader.readGlyph(glyphIndex) : null;
  }
  if (tables.cff2) {
    if (tables._cff2Reader === undefined)
      tables._cff2Reader = _buildCffReader(tables, 'cff2');
    if (!tables._cff2Reader) return null;
    // CFF2: outlines morph via blend operators consuming the VarStore
    // at the supplied normalized coords. When varCoords is null the
    // charstring's default values flow through unchanged.
    const nCoords = (varCoords != null) ? varCoords : null;
    return tables._cff2Reader.readGlyph(glyphIndex, nCoords);
  }
  // Lazily build the gvar reader the first time a glyph asks for
  // variation. Static reads skip the parse entirely; an unregistered
  // gvar reader (null) leaves outlines at their default position.
  if (varCoords != null && tables.gvar && tables._gvarReader === undefined) {
    tables._gvarReader = tryNewReader('gvar', tables);   // null if unregistered
  }
  return _readGlyph(tables, glyphIndex, 0, varCoords);
}

function _readGlyph(tables, gid, depth, varCoords) {
  if (depth > 16) throw new Error('Composite glyph recursion too deep');
  const [off, len] = tables.glyphRange(gid);
  if (len === 0) return null;
  const v = tables.view;
  const numContours = v.getInt16(off, false);
  if (numContours === 0) return null;
  if (numContours > 0)  return _readSimple(tables, off + 10, numContours, gid, varCoords);
  return _readComposite(tables, off + 10, depth, varCoords);
}

function _parseSimpleCoords(tables, p, numContours) {
  const v = tables.view, b = tables.bytes;

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

  return { numPoints, xs, ys, flags, endPts };
}

function _readSimple(tables, p, numContours, gid, varCoords) {
  const { numPoints, xs, ys, flags, endPts } = _parseSimpleCoords(tables, p, numContours);
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
      pts[i * 2]     = xs[i];
      pts[i * 2 + 1] = ys[i];
    }
    const ph = numPoints;
    pts[ph * 2]         = lsb;
    pts[ph * 2 + 1]     = 0;
    pts[(ph + 1) * 2]     = lsb + adv;
    pts[(ph + 1) * 2 + 1] = 0;
    pts[(ph + 2) * 2]     = xMin;
    pts[(ph + 2) * 2 + 1] = yMax;
    pts[(ph + 3) * 2]     = xMin;
    pts[(ph + 3) * 2 + 1] = yMin;
    tables._gvarReader.applyDeltas(gid, pts, numPoints, varCoords, endPts);
    for (let i = 0; i < numPoints; i++) {
      xs[i] = Math.round(pts[i * 2]);
      ys[i] = Math.round(pts[i * 2 + 1]);
    }
  }

  return _contoursToSegs(xs, ys, flags, endPts);
}

function _contoursToSegs(xs, ys, flags, endPts) {
  const segs = [];
  let contourStart = 0;
  for (let c = 0; c < endPts.length; c++) {
    const contourEnd = endPts[c];
    const n = contourEnd - contourStart + 1;
    if (n < 2) { contourStart = contourEnd + 1; continue; }
    const idx = (k) => contourStart + ((k % n) + n) % n;

    const firstOn = (flags[idx(0)] & F_ON_CURVE) !== 0;
    let startX, startY, seedK;
    if (firstOn) {
      startX = xs[idx(0)]; startY = ys[idx(0)]; seedK = 0;
    } else {
      const lastOn = (flags[idx(n - 1)] & F_ON_CURVE) !== 0;
      if (lastOn) {
        startX = xs[idx(n - 1)]; startY = ys[idx(n - 1)]; seedK = -1;
      } else {
        startX = (xs[idx(n - 1)] + xs[idx(0)]) * 0.5;
        startY = (ys[idx(n - 1)] + ys[idx(0)]) * 0.5;
        seedK  = -1;
      }
    }

    let curX = startX, curY = startY;
    // Walk exactly n contour points per iteration. The on-curve-ends-
    // a-quad branch advances s by 2 (inner s++ + for-loop s++), so the
    // counter ticks naturally past consumed on-curve points; the
    // firstOff + lastOn case starts at k=0 having pre-consumed pt(n-1)
    // as the start, so we still walk n raw indices total.
    const steps = n;
    let k = seedK + 1;
    for (let s = 0; s < steps; s++) {
      const i = idx(k);
      const on = (flags[i] & F_ON_CURVE) !== 0;
      const px = xs[i], py = ys[i];
      if (on) {
        if (curX !== px || curY !== py) segs.push(mkLine([curX, curY], [px, py]));
        curX = px; curY = py;
      } else {
        const i2 = idx(k + 1);
        const on2 = (flags[i2] & F_ON_CURVE) !== 0;
        let endX, endY;
        if (on2) {
          endX = xs[i2]; endY = ys[i2];
          k++; s++;
        } else {
          endX = (px + xs[i2]) * 0.5;
          endY = (py + ys[i2]) * 0.5;
        }
        segs.push(mkQuad([curX, curY], [px, py], [endX, endY]));
        curX = endX; curY = endY;
      }
      k++;
    }

    if (curX !== startX || curY !== startY)
      segs.push(mkLine([curX, curY], [startX, startY]));

    contourStart = contourEnd + 1;
  }
  return segs;
}

function _readComposite(tables, p, depth, varCoords) {
  const v = tables.view, b = tables.bytes;
  const out = [];
  let flags;
  do {
    flags = v.getUint16(p, false);
    const childIdx = v.getUint16(p + 2, false);
    p += 4;

    let dx, dy;
    if (flags & C_ARG_1_AND_2_ARE_WORDS) {
      const a1 = (flags & C_ARGS_ARE_XY_VALUES) ? v.getInt16(p, false)     : v.getUint16(p, false);
      const a2 = (flags & C_ARGS_ARE_XY_VALUES) ? v.getInt16(p + 2, false) : v.getUint16(p + 2, false);
      dx = a1; dy = a2;
      p += 4;
    } else {
      // Byte-sized args: signed when ARGS_ARE_XY_VALUES, unsigned otherwise.
      const a1raw = b[p], a2raw = b[p + 1];
      const sext = (n) => (n & 0x80) ? n - 0x100 : n;
      dx = (flags & C_ARGS_ARE_XY_VALUES) ? sext(a1raw) : a1raw;
      dy = (flags & C_ARGS_ARE_XY_VALUES) ? sext(a2raw) : a2raw;
      p += 2;
    }

    let xx = 1, xy = 0, yx = 0, yy = 1;
    if (flags & C_WE_HAVE_A_SCALE) {
      const s = v.getInt16(p, false) / 16384;
      p += 2; xx = s; yy = s;
    } else if (flags & C_WE_HAVE_AN_X_AND_Y_SCALE) {
      xx = v.getInt16(p, false) / 16384;
      yy = v.getInt16(p + 2, false) / 16384;
      p += 4;
    } else if (flags & C_WE_HAVE_A_TWO_BY_TWO) {
      xx = v.getInt16(p, false)     / 16384;
      xy = v.getInt16(p + 2, false) / 16384;
      yx = v.getInt16(p + 4, false) / 16384;
      yy = v.getInt16(p + 6, false) / 16384;
      p += 8;
    }

    const child = _readGlyph(tables, childIdx, depth + 1, varCoords);
    if (child) {
      const X = (q) => [xx * q[0] + xy * q[1] + dx, yx * q[0] + yy * q[1] + dy];
      for (const seg of child) {
        if (seg.type === 0) out.push(mkLine(X(seg.p1), X(seg.p2)));
        else if (seg.type === 1) out.push(mkQuad(X(seg.p1), X(seg.p2), X(seg.p3)));
        else if (seg.type === 2) out.push(mkCubic(X(seg.p1), X(seg.p2), X(seg.p3), X(seg.p4)));
      }
    }
  } while (flags & C_MORE_COMPONENTS);

  return out.length === 0 ? null : out;
}

/// Variation-aware advance in font units via gvar phantom points when HVAR
/// is absent. Returns null when gvar can't answer (no table, composite glyph).
export function glyphGvarAdvanceFu(gid, tables, nCoords) {
  if (nCoords == null) return null;
  if (tables._gvarReader === undefined) {
    tables._gvarReader = tryNewReader('gvar', tables);
  }
  const gvar = tables._gvarReader;
  if (!gvar || !gvar.hasGvar) return null;

  const [goff, len] = tables.glyphRange(gid);
  if (len === 0) return null;
  const v = tables.view;
  const numContours = v.getInt16(goff, false);
  if (numContours <= 0) return null;

  const xMin = v.getInt16(goff + 2, false);
  const yMin = v.getInt16(goff + 4, false);
  const yMax = v.getInt16(goff + 8, false);
  const lsb = tables.glyphLeftSideBearing(gid);
  const adv = tables.glyphAdvanceWidth(gid);

  const { numPoints, xs, ys, endPts } = _parseSimpleCoords(tables, goff + 10, numContours);
  const totalPoints = numPoints + 4;
  const pts = new Float64Array(totalPoints * 2);
  for (let i = 0; i < numPoints; i++) {
    pts[i * 2]     = xs[i];
    pts[i * 2 + 1] = ys[i];
  }
  const ph = numPoints;
  pts[ph * 2]         = lsb;
  pts[ph * 2 + 1]     = 0;
  pts[(ph + 1) * 2]     = lsb + adv;
  pts[(ph + 1) * 2 + 1] = 0;
  pts[(ph + 2) * 2]     = xMin;
  pts[(ph + 2) * 2 + 1] = yMax;
  pts[(ph + 3) * 2]     = xMin;
  pts[(ph + 3) * 2 + 1] = yMin;

  gvar.applyDeltas(gid, pts, numPoints, nCoords, endPts);
  return Math.round(pts[(ph + 1) * 2] - pts[ph * 2]);
}

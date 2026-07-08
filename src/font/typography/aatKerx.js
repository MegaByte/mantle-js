// aatKerx.js — Apple Advanced Typography 'kerx' (extended kerning).
//
// The AAT counterpart to GPOS pair kerning. Reads the horizontal,
// non-cross-stream subtables and exposes getPairKerning(left, right) →
// FUnits, summed across all applicable subtables (matching the 'kern'
// reader's surface so text layout can treat them interchangeably).
//
// Subtable coverage:
//   format 0 (sorted pair list) + format 2 (class array) — pairwise,
//     applied in the layout pen loop via getPairKerning.
//   format 1 (state-machine contextual kerning) — per-glyph advance /
//     offset deltas.
//   format 4 (anchor / control-point attachment) — all three action
//     types: 0 (glyph outline control points, via raw glyf points),
//     1 ('ankr' table anchors), 2 (inline coordinates). Each attaches a
//     glyph to a marked predecessor.
// Formats 1/4 are run-based positioning (applyContextualKerning), applied
// by the post-layout AAT kerning pass.
//
// Ref: https://learn.microsoft.com/en-us/typography/opentype/spec/kerx

import { aatLookup } from './aatLookup.js';

export class AatKerx {
  constructor(tables) {
    this._view = tables.view;
    this._numGlyphs = tables.numGlyphs;
    this._tables = tables;     // for 'ankr' (fmt4 type1) + glyf points (type0)
    this._subtables = null;    // parsed lazily: [{format, off, ...}]
    this._off = -1;
    if (!tables.kerx) return;
    this._off = tables.kerx[0];
  }

  /// 'ankr' anchor for (glyph, anchorIndex) → { x, y } font units, or null.
  /// Header: version u16, flags u16, lookupTableOffset u32, anchorDataOffset
  /// u32. lookupTable (AAT lookup) → a u16 offset into anchorData; each
  /// glyph's anchors are { numAnchors u32, Anchor[]{x s16, y s16} }.
  _ankrAnchor(glyph, anchorIndex) {
    const t = this._tables;
    if (!t.ankr) return null;
    const v = this._view, off = t.ankr[0];
    if (v.getUint16(off, false) !== 0) return null;        // version 0
    const lookupOff = off + v.getUint32(off + 4, false);
    const anchorDataOff = off + v.getUint32(off + 8, false);
    const rel = aatLookup(v, lookupOff, glyph, this._numGlyphs);
    if (rel < 0) return null;
    const anchors = anchorDataOff + rel;
    const num = v.getUint32(anchors, false);
    if (anchorIndex >= num) return null;
    const a = anchors + 4 + anchorIndex * 4;
    return { x: v.getInt16(a, false), y: v.getInt16(a + 2, false) };
  }

  get hasKerx() { this._ensure(); return this._subtables && this._subtables.length > 0; }

  /// Sum of kerning adjustments (font units) for the ordered pair
  /// (leftGid, rightGid) across all horizontal format-0/2 subtables.
  getPairKerning(left, right) {
    this._ensure();
    if (!this._subtables) return 0;
    let total = 0;
    for (const st of this._subtables) {
      if (st.format === 0) total += _kerx0(this._view, st, left, right);
      else if (st.format === 2) total += _kerx2(this._view, st, left, right, this._numGlyphs);
      else if (st.format === 6) total += _kerx6(this._view, st, left, right, this._numGlyphs);
    }
    return total;
  }

  /// True when any format-1 (state-machine contextual) or format-4
  /// (anchor / control-point) subtable is present — the kinds that need a
  /// run-based positioning pass rather than pairwise lookup.
  get hasContextualKerning() {
    this._ensure();
    return this._subtables && this._subtables.some((st) => st.format === 1 || st.format === 4);
  }

  /// Run the contextual (format 1) and anchor (format 4) kerning state
  /// machines over a glyph-id run IN LOGICAL ORDER. Returns:
  ///   { xAdvance, xOffset, yOffset, attach }
  /// where xAdvance/xOffset/yOffset are per-glyph FONT-UNIT deltas from
  /// format 1 (xAdvance shifts following glyphs; the offsets shift the
  /// glyph), and `attach` is a list of format-4 mark attachments
  ///   { idx, markIdx, dxFu, dyFu }
  /// positioning glyph `idx` at `markIdx`'s pen + (dx, dy). Format 0/2
  /// (pairwise) are applied separately via getPairKerning.
  applyContextualKerning(gids) {
    this._ensure();
    const n = gids.length;
    const xAdvance = new Array(n).fill(0);
    const xOffset = new Array(n).fill(0);
    const yOffset = new Array(n).fill(0);
    const attach = [];
    if (!this._subtables) return { xAdvance, xOffset, yOffset, attach };
    for (const st of this._subtables) {
      if (st.format === 1) _kerx1(this._view, st, gids, this._numGlyphs, xAdvance, xOffset, yOffset);
      else if (st.format === 4) _kerx4(this, st, gids, attach);
    }
    return { xAdvance, xOffset, yOffset, attach };
  }

  _ensure() {
    if (this._subtables != null) return;
    this._subtables = [];
    if (this._off < 0) return;
    const v = this._view, off = this._off;
    const nTables = v.getUint32(off + 4, false);
    let p = off + 8;
    for (let i = 0; i < nTables; i++) {
      const length = v.getUint32(p, false);
      const coverage = v.getUint32(p + 4, false);
      // coverage: bit31 vertical, bit30 cross-stream, bit29 variation;
      // low byte = format. We process horizontal subtables (formats 0/2
      // pairwise; 1 state-machine; 4 anchor). Cross-stream is honored by
      // the contextual machines (y-offset) but skipped for pairwise.
      const format = coverage & 0xFF;
      const vertical = (coverage & 0x80000000) !== 0;
      const crossStream = (coverage & 0x40000000) !== 0;
      const body = p + 12;   // after { length u32, coverage u32, tupleCount u32 }
      if (!vertical) {
        if ((format === 0 || format === 2 || format === 6) && !crossStream)
          this._subtables.push({ format, off: body, crossStream });
        else if (format === 1 || format === 4)
          this._subtables.push({ format, off: body, crossStream });
      }
      p += length;
    }
  }
}

// Format 1: extended state machine (like morx) + a kern value stack.
// Layout (from subtable body `st.off`): StateTable header
//   nClasses(u32), classTableOffset(u32), stateArrayOffset(u32),
//   entryTableOffset(u32)  — offsets relative to the body — then a
//   kernAction offset(u32). Entries are { newState(u16 index), flags(u16),
//   kernActionIndex(u16) }. On Push, the glyph index is pushed; on action,
//   FWORD values are popped onto the stacked glyphs (low bit = list end).
function _kerx1(v, st, gids, numGlyphs, xAdvance, xOffset, yOffset) {
  const o = st.off;
  const nClasses = v.getUint32(o, false);
  const classOff = o + v.getUint32(o + 4, false);
  const stateOff = o + v.getUint32(o + 8, false);
  const entryOff = o + v.getUint32(o + 12, false);
  const kernActOff = o + v.getUint32(o + 16, false);
  const stack = [];
  let state = 0, i = 0, guard = 0;
  const guardMax = gids.length * 4 + 16;
  while (guard++ < guardMax) {
    const atEnd = i >= gids.length;
    const cls = atEnd ? 0 /* end of text */ : _classExt(v, classOff, gids[i], numGlyphs);
    const entryIdx = v.getUint16(stateOff + (state * nClasses + cls) * 2, false);
    const eOff = entryOff + entryIdx * 6;
    const newState = v.getUint16(eOff, false);
    const flags = v.getUint16(eOff + 2, false);
    const kernActionIndex = v.getUint16(eOff + 4, false);
    if (flags & 0x2000) stack.length = 0;                 // Reset
    if ((flags & 0x8000) && !atEnd) stack.push(i);        // Push
    if (kernActionIndex !== 0xFFFF && stack.length > 0) {
      let aOff = kernActOff + (kernActionIndex & ~1);      // byteOffsetToIndex (extended ÷2 ×2)
      let last = false;
      while (!last && stack.length > 0) {
        const idx = stack.pop();
        let val = v.getInt16(aOff, false); aOff += 2;
        last = (val & 1) !== 0;
        val &= ~1;
        if (st.crossStream) {
          if (val !== -0x8000) yOffset[idx] += val;        // cross-stream → y shift
        } else {
          xAdvance[idx] += val;                            // normal → advance + offset
          xOffset[idx] += val;
        }
      }
    }
    state = newState;
    if (atEnd) break;
    if ((flags & 0x4000) === 0) i += 1;                    // advance unless DontAdvance
  }
}

// Extended class lookup: AAT lookup → class, default out-of-bounds (1).
function _classExt(v, classOff, gid, numGlyphs) {
  const c = aatLookup(v, classOff, gid, numGlyphs);
  return c < 0 ? 1 : c;
}

// Format 6: 2D class array for large fonts. flags(u32, bit0 ValuesAreLong),
// rowCount(u16), columnCount(u16), then rowIndexTable / columnIndexTable /
// array offsets (u32) and a vector offset (u32). The row/column AAT lookups
// give pre-scaled indices whose sum indexes the kern `array` (s16 short /
// s32 long). Pairwise — summed via getPairKerning.
//
// Gotcha: format-6 offsets are relative to the SUBTABLE start (the 12-byte
// header included), NOT the body — unlike the format-1/4 state tables whose
// offsets are machine-relative.
function _kerx6(v, st, left, right, numGlyphs) {
  const o = st.off;
  // Offsets are relative to the SUBTABLE start (12-byte header included),
  // i.e. o - 12 — unlike the format-1/4 state tables (machine-relative).
  const sub = o - 12;
  const isLong = (v.getUint32(o, false) & 1) !== 0;
  const rowTableOff = sub + v.getUint32(o + 8, false);
  const colTableOff = sub + v.getUint32(o + 12, false);
  const arrayOff = sub + v.getUint32(o + 16, false);
  const l = aatLookup(v, rowTableOff, left, numGlyphs, isLong ? 4 : 2);
  const r = aatLookup(v, colTableOff, right, numGlyphs, isLong ? 4 : 2);
  const offset = (l < 0 ? 0 : l) + (r < 0 ? 0 : r);
  return isLong ? v.getInt32(arrayOff + offset * 4, false) : v.getInt16(arrayOff + offset * 2, false);
}

// Format 4: anchor / control-point attachment. Same extended state
// machine as format 1, plus a u32 `flags` (at machine+16) whose top 2
// bits are the action type and low 24 bits (0x00FFFFFF) an offset to the
// action-data table. A Mark flag (0x8000) records the marked glyph; an
// entry with ankrActionIndex != 0xFFFF attaches the CURRENT glyph to the
// mark. Action types — `dx = markX - currX`, `dy = markY - currY`:
//   type 0 control point  — 2×u16 {markPt, currPt}; coords from the glyph
//     OUTLINE's Nth point (raw glyf contour points).
//   type 1 anchor         — 2×u16 {markPt, currPt}; coords from the 'ankr'
//     table per glyph.
//   type 2 coordinate     — 4×FWORD {markX, markY, currX, currY} inline.
function _kerx4(self, st, gids, attach) {
  const v = self._view, o = st.off;
  const nClasses = v.getUint32(o, false);
  const classOff = o + v.getUint32(o + 4, false);
  const stateOff = o + v.getUint32(o + 8, false);
  const entryOff = o + v.getUint32(o + 12, false);
  const tableFlags = v.getUint32(o + 16, false);
  const actionType = (tableFlags >>> 30) & 3;
  const dataOff = o + (tableFlags & 0x00FFFFFF);
  let state = 0, i = 0, guard = 0, markIdx = -1;
  const guardMax = gids.length * 4 + 16;
  while (guard++ < guardMax) {
    const atEnd = i >= gids.length;
    const cls = atEnd ? 0 : _classExt(v, classOff, gids[i], self._numGlyphs);
    const entryIdx = v.getUint16(stateOff + (state * nClasses + cls) * 2, false);
    const eOff = entryOff + entryIdx * 6;
    const newState = v.getUint16(eOff, false);
    const flags = v.getUint16(eOff + 2, false);
    const ankrActionIndex = v.getUint16(eOff + 4, false);
    if (markIdx >= 0 && ankrActionIndex !== 0xFFFF && !atEnd) {
      let mark = null, curr = null;
      if (actionType === 2) {
        const d = dataOff + ankrActionIndex * 8;
        mark = { x: v.getInt16(d, false), y: v.getInt16(d + 2, false) };
        curr = { x: v.getInt16(d + 4, false), y: v.getInt16(d + 6, false) };
      } else {
        const d = dataOff + ankrActionIndex * 4;   // 2 × u16 point indices
        const markPt = v.getUint16(d, false), currPt = v.getUint16(d + 2, false);
        if (actionType === 1) {
          mark = self._ankrAnchor(gids[markIdx], markPt);
          curr = self._ankrAnchor(gids[i], currPt);
        } else { // type 0: glyph outline control points
          mark = _contourPoint(self._tables, gids[markIdx], markPt);
          curr = _contourPoint(self._tables, gids[i], currPt);
        }
      }
      if (mark && curr) attach.push({ idx: i, markIdx, dxFu: mark.x - curr.x, dyFu: mark.y - curr.y });
    }
    if ((flags & 0x8000) && !atEnd) markIdx = i;     // Mark
    state = newState;
    if (atEnd) break;
    if ((flags & 0x4000) === 0) i += 1;               // advance unless DontAdvance
  }
}

// Nth on/off-curve point of a simple TrueType glyph outline (font units).
// Returns null for composite glyphs / out-of-range indices (control-point
// kerning targets simple glyphs). Parallels FreeType/HarfBuzz contour-point
// lookup. Reads raw glyf flags + delta-encoded x/y coordinate arrays.
function _contourPoint(t, gid, pointIndex) {
  const [go, glen] = t.glyphRange(gid);
  if (glen === 0) return null;
  const v = t.view;
  const numContours = v.getInt16(go, false);
  if (numContours < 0) return null;                 // composite — unsupported here
  const endPtsOff = go + 10;
  const numPoints = numContours === 0 ? 0 : v.getUint16(endPtsOff + (numContours - 1) * 2, false) + 1;
  if (pointIndex >= numPoints) return null;
  const insLenOff = endPtsOff + numContours * 2;
  const insLen = v.getUint16(insLenOff, false);
  let p = insLenOff + 2 + insLen;                   // flags array start
  // Parse flags (run-length encoded via the REPEAT bit 0x08).
  const flags = new Uint8Array(numPoints);
  for (let k = 0; k < numPoints;) {
    const f = v.getUint8(p++); flags[k++] = f;
    if (f & 0x08) { let r = v.getUint8(p++); while (r-- > 0 && k < numPoints) flags[k++] = f; }
  }
  // X coords (flag bits: 0x02 = short, 0x10 = same/positive).
  let x = 0, tx = -1;
  for (let k = 0; k <= pointIndex; k++) {
    const f = flags[k];
    if (f & 0x02) { const dx = v.getUint8(p++); x += (f & 0x10) ? dx : -dx; }
    else if (!(f & 0x10)) { x += v.getInt16(p, false); p += 2; }
    if (k === pointIndex) tx = x;
  }
  // Y coords (must skip the rest of X first — re-walk all X to find Y start).
  // p currently points just past the X bytes consumed up to pointIndex, so
  // continue consuming the remaining X bytes for points > pointIndex.
  for (let k = pointIndex + 1; k < numPoints; k++) {
    const f = flags[k];
    if (f & 0x02) p += 1;
    else if (!(f & 0x10)) p += 2;
  }
  let y = 0, ty = 0;
  for (let k = 0; k <= pointIndex; k++) {
    const f = flags[k];
    if (f & 0x04) { const dy = v.getUint8(p++); y += (f & 0x20) ? dy : -dy; }
    else if (!(f & 0x20)) { y += v.getInt16(p, false); p += 2; }
    if (k === pointIndex) ty = y;
  }
  return { x: tx, y: ty };
}

// Format 0: nPairs(u32) searchRange(u32) entrySelector(u32) rangeShift(u32)
// then pairs { left u16, right u16, value s16 } sorted by (left,right).
function _kerx0(v, st, left, right) {
  const o = st.off;
  const nPairs = v.getUint32(o, false);
  const base = o + 16;
  const key = (left * 0x10000) + right;
  let lo = 0, hi = nPairs - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const u = base + mid * 6;
    const k = v.getUint16(u, false) * 0x10000 + v.getUint16(u + 2, false);
    if (key < k) hi = mid - 1;
    else if (key > k) lo = mid + 1;
    else return v.getInt16(u + 4, false);
  }
  return 0;
}

// Format 2: rowWidth(u32) leftOffsetTable(u32) rightOffsetTable(u32)
// arrayOffset(u32). The left/right class lookups return BYTE offsets
// (left = row offset already × rowWidth; right = column offset). The
// kerning value is the s16 at arrayBase + leftVal + rightVal. All
// offsets are relative to the SUBTABLE BODY start (st.off).
function _kerx2(v, st, left, right, numGlyphs) {
  const o = st.off;
  const leftTableOff  = o + v.getUint32(o + 4, false);
  const rightTableOff = o + v.getUint32(o + 8, false);
  const arrayOff      = o + v.getUint32(o + 12, false);
  const lv = aatLookup(v, leftTableOff, left, numGlyphs);
  const rv = aatLookup(v, rightTableOff, right, numGlyphs);
  const leftVal  = lv < 0 ? 0 : lv;
  const rightVal = rv < 0 ? 0 : rv;
  return v.getInt16(arrayOff + leftVal + rightVal, false);
}

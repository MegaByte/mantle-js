// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aatLookup.js — AAT Lookup table (glyph → value). Shared by morx /
// mort / kerx state machines and kerx format-0/2/6 value tables.
//
// Returns -1 when the glyph isn't found. `valueBytes` is the value
// width: 2 (u16, default) or 4 (u32) — kerx format-6 "long" lookups
// carry u32 values; everything else is u16.

// Width-dispatched value read as a plain function — this lookup sits
// inside per-glyph-pair binary-search loops, so a per-call reader
// closure would be measurable allocation churn.
function _rdVal(v, o, valueBytes) {
  return valueBytes === 4 ? v.getUint32(o, false) : v.getUint16(o, false);
}

export function aatLookup(v, off, gid, numGlyphs, valueBytes = 2) {
  const format = v.getUint16(off, false);
  switch (format) {
    case 0: {
      // simple array: value[numGlyphs]
      if (gid >= numGlyphs) return -1;
      return _rdVal(v, off + 2 + gid * valueBytes, valueBytes);
    }
    case 2: {
      // segment single value
      return _binSearchSegments(v, off, gid, false, valueBytes);
    }
    case 4: {
      // segment array (offset to per-glyph values)
      return _binSearchSegments(v, off, gid, true, valueBytes);
    }
    case 6: {
      // single glyph table
      const unitSize = v.getUint16(off + 2, false);
      const nUnits = v.getUint16(off + 4, false);
      const base = off + 12;
      let lo = 0,
        hi = nUnits - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const u = base + mid * unitSize;
        const g = v.getUint16(u, false);
        if (gid < g) hi = mid - 1;
        else if (gid > g) lo = mid + 1;
        else return _rdVal(v, u + 2, valueBytes);
      }
      return -1;
    }
    case 8: {
      // trimmed array
      const first = v.getUint16(off + 2, false);
      const count = v.getUint16(off + 4, false);
      if (gid < first || gid >= first + count) return -1;
      return _rdVal(v, off + 6 + (gid - first) * valueBytes, valueBytes);
    }
    case 10: {
      // trimmed array with variable unit size
      const unitSize = v.getUint16(off + 2, false); // 1, 2, or 4 bytes
      const first = v.getUint16(off + 4, false);
      const count = v.getUint16(off + 6, false);
      if (gid < first || gid >= first + count) return -1;
      const u = off + 8 + (gid - first) * unitSize;
      if (unitSize === 1) return v.getUint8(u);
      if (unitSize === 4) return v.getUint32(u, false);
      return v.getUint16(u, false);
    }
    default:
      return -1;
  }
}

// Formats 2 & 4 share a BinSrchHeader + segments[{lastGlyph, firstGlyph,
// value-or-offset}]. When `valuesByOffset`, the third u16 is an offset
// (from the subtable start `off`) to a per-glyph u16 value array.
function _binSearchSegments(v, off, gid, valuesByOffset, valueBytes = 2) {
  const unitSize = v.getUint16(off + 2, false); // = 6
  const nUnits = v.getUint16(off + 4, false);
  const base = off + 12;
  let lo = 0,
    hi = nUnits - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const u = base + mid * unitSize;
    const last = v.getUint16(u, false);
    const firstG = v.getUint16(u + 2, false);
    if (last === 0xffff && firstG === 0xffff) {
      hi = mid - 1;
      continue;
    } // terminator guard
    if (gid < firstG) hi = mid - 1;
    else if (gid > last) lo = mid + 1;
    else {
      if (!valuesByOffset) return _rdVal(v, u + 4, valueBytes);
      const valuesOff = off + v.getUint16(u + 4, false);
      return _rdVal(v, valuesOff + (gid - firstG) * valueBytes, valueBytes);
    }
  }
  return -1;
}

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gvarReader.js — OpenType 'gvar' table reader.
//
// Decodes per-glyph point deltas across variation axes. For a normalized
// coordinate vector (one F2DOT14 per axis ∈ [-1, +1]), applyDeltas morphs
// each point by the weighted sum of every tuple's contribution.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/gvar

const FLAG_LONG_GLYPH_OFFSETS = 0x0001;

// TupleVariationHeader tupleIndex bits:
const EMBEDDED_PEAK_TUPLE = 0x8000;
const INTERMEDIATE_REGION = 0x4000;
const PRIVATE_POINT_NUMBERS = 0x2000;
const TUPLE_INDEX_MASK = 0x0fff;
// TupleVariationCount header bits:
const SHARED_POINT_NUMBERS = 0x8000;
const COUNT_MASK = 0x0fff;

// Point/delta-run flag bits:
const POINTS_ARE_WORDS = 0x80;
const POINTS_RUN_COUNT_MASK = 0x7f;
const DELTAS_ARE_ZERO = 0x80;
const DELTAS_ARE_WORDS = 0x40;
const DELTA_RUN_COUNT_MASK = 0x3f;

function readF2dot14(view, off) {
  const i = view.getInt16(off, false);
  return i / 16384;
}

// Reused per-tuple scratch (single-threaded reader; sized up on demand,
// length-clamped per use). Slot 0/1 = packed dx/dy (plain arrays —
// decodePackedDeltas writes every element); IUP slots are typed and
// zero-filled per call.
const _deltaScratch = [null, null];
function _scratchDeltas(slot, n) {
  let a = _deltaScratch[slot];
  if (!a || a.length < n) a = _deltaScratch[slot] = new Array(n);
  a.length = n;
  return a;
}
const _iupScratch = [null, null, null];
function _scratchIup(slot, n) {
  let a = _iupScratch[slot];
  if (!a || a.length < n) {
    a = _iupScratch[slot] = slot === 2 ? new Uint8Array(n) : new Float64Array(n);
  }
  const view = a.length === n ? a : a.subarray(0, n);
  view.fill(0);
  return view;
}

export class GvarTable {
  constructor(tables) {
    this._tables = tables;
    this._present = false;
    if (!tables.gvar) return;
    const v = tables.view;
    const off = tables.gvar[0];
    const major = v.getUint16(off + 0, false);
    if (major !== 1) return;
    this._tableOff = off;
    this._axisCount = v.getUint16(off + 4, false);
    this._sharedTupleCount = v.getUint16(off + 6, false);
    this._sharedTuplesOff = off + v.getUint32(off + 8, false);
    this._glyphCount = v.getUint16(off + 12, false);
    this._flags = v.getUint16(off + 14, false);
    this._glyphVarDataArrayOff = off + v.getUint32(off + 16, false);
    this._glyphOffsets = new Array(this._glyphCount + 1);
    const isLong = (this._flags & FLAG_LONG_GLYPH_OFFSETS) !== 0;
    let p = off + 20;
    for (let i = 0; i <= this._glyphCount; i++) {
      if (isLong) {
        this._glyphOffsets[i] = v.getUint32(p, false);
        p += 4;
      } else {
        // Per spec, short offsets are DIVIDED BY 2 in storage.
        this._glyphOffsets[i] = v.getUint16(p, false) * 2;
        p += 2;
      }
    }
    this._present = true;
  }

  get hasGvar() {
    return this._present;
  }
  get axisCount() {
    return this._axisCount;
  }
  get glyphCount() {
    return this._glyphCount;
  }

  /// Apply gvar deltas to `pointsXY` (Float64Array [x0,y0, x1,y1, ...])
  /// for glyph `gid` at normalized coords `nCoords` (F2DOT14 ∈ [-1, +1],
  /// one per axis). Mutates pointsXY in place.
  ///
  /// `nPoints` is the count of REAL points. gvar also addresses 4
  /// trailing phantom points (LSB / RSB / TSB / BSB) — pass an array
  /// sized for (nPoints + 4) * 2 floats to receive phantom deltas.
  applyDeltas(gid, pointsXY, nPoints, nCoords, contourEnds = null) {
    if (!this._present || gid < 0 || gid >= this._glyphCount) return;
    const dataStart = this._glyphVarDataArrayOff + this._glyphOffsets[gid];
    const dataEnd = this._glyphVarDataArrayOff + this._glyphOffsets[gid + 1];
    if (dataEnd <= dataStart) return; // no deltas for this glyph

    const v = this._tables.view;
    const bytes = this._tables.bytes;
    const totalPoints = nPoints + 4; // 4 phantom points

    // Original (default-master) coords for IUP inference of un-referenced
    // points — captured before any tuple mutates pointsXY. Only simple glyphs
    // (contourEnds supplied) do IUP; composites apply listed points only.
    let origX = null,
      origY = null;
    if (contourEnds) {
      origX = new Float64Array(totalPoints);
      origY = new Float64Array(totalPoints);
      for (let i = 0; i < totalPoints; i++) {
        origX[i] = pointsXY[i * 2];
        origY[i] = pointsXY[i * 2 + 1];
      }
    }

    const tvCountAndFlags = v.getUint16(dataStart + 0, false);
    const tupleCount = tvCountAndFlags & COUNT_MASK;
    const sharedPointNumbers = (tvCountAndFlags & SHARED_POINT_NUMBERS) !== 0;
    let serializedDataOff = dataStart + v.getUint16(dataStart + 2, false);

    let headersOff = dataStart + 4;

    // If shared point numbers are present, decode them first at the
    // top of serializedData.
    let sharedPoints = null;
    if (sharedPointNumbers) {
      const r = decodePackedPointNumbers(bytes, serializedDataOff);
      sharedPoints = r.points;
      serializedDataOff = r.cursor;
    }

    // For each tuple variation header.
    for (let ti = 0; ti < tupleCount; ti++) {
      const variationDataSize = v.getUint16(headersOff + 0, false);
      const tupleIndex = v.getUint16(headersOff + 2, false);
      headersOff += 4;

      const embeddedPeak = (tupleIndex & EMBEDDED_PEAK_TUPLE) !== 0;
      const intermediateRegion = (tupleIndex & INTERMEDIATE_REGION) !== 0;
      const privatePoints = (tupleIndex & PRIVATE_POINT_NUMBERS) !== 0;
      const sharedTupleIdx = tupleIndex & TUPLE_INDEX_MASK;

      // Peak tuple.
      const peak = new Array(this._axisCount);
      if (embeddedPeak) {
        for (let a = 0; a < this._axisCount; a++) {
          peak[a] = readF2dot14(v, headersOff);
          headersOff += 2;
        }
      } else {
        if (sharedTupleIdx >= this._sharedTupleCount) {
          // Malformed; skip the rest of this tuple's data.
          serializedDataOff += variationDataSize;
          continue;
        }
        const sharedOff = this._sharedTuplesOff + sharedTupleIdx * this._axisCount * 2;
        for (let a = 0; a < this._axisCount; a++) {
          peak[a] = readF2dot14(v, sharedOff + a * 2);
        }
      }
      // Intermediate region tuples (optional).
      let interStart = null,
        interEnd = null;
      if (intermediateRegion) {
        interStart = new Array(this._axisCount);
        interEnd = new Array(this._axisCount);
        for (let a = 0; a < this._axisCount; a++) {
          interStart[a] = readF2dot14(v, headersOff);
          headersOff += 2;
        }
        for (let a = 0; a < this._axisCount; a++) {
          interEnd[a] = readF2dot14(v, headersOff);
          headersOff += 2;
        }
      }

      // Compute scalar for this tuple at nCoords.
      const scalar = tupleScalar(this._axisCount, nCoords, peak, interStart, interEnd);
      // Always advance through the tuple's serialized data, even
      // when scalar is 0 — the headers loop relies on serializedDataOff
      // ending up at the next tuple's data block.
      const dataBlockEnd = serializedDataOff + variationDataSize;
      if (scalar === 0) {
        serializedDataOff = dataBlockEnd;
        continue;
      }

      let cursor = serializedDataOff;
      // Point numbers (private or shared).
      let pointNums;
      if (privatePoints) {
        const r = decodePackedPointNumbers(bytes, cursor);
        pointNums = r.points;
        cursor = r.cursor;
      } else {
        pointNums = sharedPoints; // may be null = "all points"
      }
      const targetCount = pointNums == null ? totalPoints : pointNums.length;
      // Deltas X then Y — reused scratch (this runs per tuple per glyph,
      // per FRAME for animated variable fonts; fresh arrays here were the
      // VF morph path's dominant allocation).
      const dx = _scratchDeltas(0, targetCount);
      const dy = _scratchDeltas(1, targetCount);
      cursor = decodePackedDeltas(bytes, cursor, dx);
      cursor = decodePackedDeltas(bytes, cursor, dy);
      serializedDataOff = dataBlockEnd;

      if (pointNums == null) {
        // Apply to every point (real + phantom).
        for (let i = 0; i < totalPoints; i++) {
          pointsXY[i * 2] += scalar * dx[i];
          pointsXY[i * 2 + 1] += scalar * dy[i];
        }
      } else if (contourEnds) {
        // Partial point list on a simple glyph: fill the un-referenced points
        // via IUP (Interpolation of Untouched Points), then apply every point.
        // Reused scratch, zero-filled per tuple (IUP requires clean slates).
        const rdx = _scratchIup(0, totalPoints);
        const rdy = _scratchIup(1, totalPoints);
        const touched = _scratchIup(2, totalPoints);
        for (let k = 0; k < pointNums.length; k++) {
          const pn = pointNums[k];
          if (pn < 0 || pn >= totalPoints) continue;
          rdx[pn] = dx[k];
          rdy[pn] = dy[k];
          touched[pn] = 1;
        }
        inferIupDeltas(rdx, rdy, touched, origX, origY, contourEnds, nPoints);
        for (let i = 0; i < totalPoints; i++) {
          pointsXY[i * 2] += scalar * rdx[i];
          pointsXY[i * 2 + 1] += scalar * rdy[i];
        }
      } else {
        // Composite (no contour structure): apply the listed points only.
        for (let k = 0; k < pointNums.length; k++) {
          const pn = pointNums[k];
          if (pn < 0 || pn >= totalPoints) continue;
          pointsXY[pn * 2] += scalar * dx[k];
          pointsXY[pn * 2 + 1] += scalar * dy[k];
        }
      }
    }
  }
}

/// IUP (Interpolation of Untouched Points). A gvar tuple may list only some
/// outline points; the rest are inferred within each real contour. Phantom
/// points retain only their explicit deltas. Unreferenced contour points are
/// interpolated from the ORIGINAL coordinates, X and Y independently. Mutates
/// dx/dy (full-length raw-delta arrays) in place. `touched[i]` marks referenced
/// points; `contourEnds` are the real-contour end indices; phantoms occupy
/// [nPoints, nPoints+3].
export function inferIupDeltas(dx, dy, touched, origX, origY, contourEnds, nPoints) {
  let start = 0;
  for (let c = 0; c < contourEnds.length; c++) {
    iupContour(dx, dy, touched, origX, origY, start, contourEnds[c]);
    start = contourEnds[c] + 1;
  }
  // Metric phantom points do not form an outline contour.
}

function iupContour(dx, dy, touched, ox, oy, start, end) {
  if (end < start) return;
  const t = [];
  for (let i = start; i <= end; i++) if (touched[i]) t.push(i);
  if (t.length === 0) return; // whole contour untouched → 0
  for (let k = 0; k < t.length; k++) {
    const a = t[k];
    const b = t[(k + 1) % t.length];
    let i = a === end ? start : a + 1;
    while (i !== b) {
      dx[i] = iupInterp(ox[i], ox[a], dx[a], ox[b], dx[b]);
      dy[i] = iupInterp(oy[i], oy[a], dy[a], oy[b], dy[b]);
      i = i === end ? start : i + 1;
    }
  }
}

/// Infer one point's delta from the two bracketing referenced points, using the
/// original coordinate on this axis. Clamp to the nearer delta outside the
/// bracket; linearly interpolate inside; equal coords → shared delta or 0.
function iupInterp(gp, g1, d1, g2, d2) {
  if (g1 === g2) return d1 === d2 ? d1 : 0;
  if (g1 > g2) {
    const tg = g1;
    g1 = g2;
    g2 = tg;
    const td = d1;
    d1 = d2;
    d2 = td;
  }
  if (gp <= g1) return d1;
  if (gp >= g2) return d2;
  return d1 + ((d2 - d1) * (gp - g1)) / (g2 - g1);
}

/// Per-tuple scalar contribution at nCoords. Returns 0 when the
/// tuple's region does not include nCoords (full spec §gvar tuple
/// support).
function tupleScalar(axisCount, n, peak, interStart, interEnd) {
  let s = 1.0;
  for (let a = 0; a < axisCount; a++) {
    const c = n[a];
    const p = peak[a];
    if (p === 0) continue; // axis irrelevant to this tuple
    if (interStart == null) {
      // Simple form: tent function peak at `p`.
      if (c === 0) return 0;
      if (c < Math.min(0, p) || c > Math.max(0, p)) return 0;
      if (c === p) continue; // s *= 1
      // Linear ramp between 0 and p.
      s *= c / p;
    } else {
      const lo = interStart[a];
      const hi = interEnd[a];
      // Region validity + peak ordering per fontTools supportScalar:
      // an out-of-order region, or one crossing zero, is IGNORED for
      // this axis; coord exactly at peak scores 1 even when the peak
      // sits on the region edge (peak == start or peak == end).
      if (lo > p || p > hi) continue;
      if (lo < 0 && hi > 0) continue;
      if (c === p) continue; // s *= 1
      if (c <= lo || c >= hi) return 0;
      if (c < p) s *= (c - lo) / (p - lo);
      else s *= (hi - c) / (hi - p);
    }
  }
  return s;
}

/// Packed point-numbers per OT spec. Returns { points: Uint16Array,
///   cursor: nextOffset }. `points` is null when the data encodes
///   "all points" (count == 0 with no follow-up).
function decodePackedPointNumbers(bytes, off) {
  let cursor = off;
  let firstByte = bytes[cursor++];
  // 0 = ALL points (no further bytes).
  if (firstByte === 0) return { points: null, cursor };
  let count;
  if ((firstByte & 0x80) !== 0) {
    count = ((firstByte & 0x7f) << 8) | bytes[cursor++];
  } else {
    count = firstByte;
  }
  const points = new Uint16Array(count);
  let pointAcc = 0;
  let written = 0;
  while (written < count) {
    const ctrl = bytes[cursor++];
    const isWords = (ctrl & POINTS_ARE_WORDS) !== 0;
    const runLen = (ctrl & POINTS_RUN_COUNT_MASK) + 1;
    for (let i = 0; i < runLen && written < count; i++) {
      let delta;
      if (isWords) {
        delta = (bytes[cursor] << 8) | bytes[cursor + 1];
        cursor += 2;
      } else {
        delta = bytes[cursor++];
      }
      pointAcc += delta;
      points[written++] = pointAcc;
    }
  }
  return { points, cursor };
}

/// Packed deltas per OT spec. Fills `out` in place; returns the
/// cursor offset after the last byte consumed.
function decodePackedDeltas(bytes, off, out) {
  let cursor = off;
  const count = out.length;
  let written = 0;
  while (written < count) {
    const ctrl = bytes[cursor++];
    const runLen = (ctrl & DELTA_RUN_COUNT_MASK) + 1;
    if ((ctrl & DELTAS_ARE_ZERO) !== 0) {
      for (let i = 0; i < runLen && written < count; i++) out[written++] = 0;
    } else if ((ctrl & DELTAS_ARE_WORDS) !== 0) {
      for (let i = 0; i < runLen && written < count; i++) {
        let v = (bytes[cursor] << 8) | bytes[cursor + 1];
        if (v >= 0x8000) v -= 0x10000;
        out[written++] = v;
        cursor += 2;
      }
    } else {
      for (let i = 0; i < runLen && written < count; i++) {
        let v = bytes[cursor++];
        if (v >= 0x80) v -= 0x100;
        out[written++] = v;
      }
    }
  }
  return cursor;
}

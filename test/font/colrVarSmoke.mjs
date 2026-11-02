// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrVarSmoke.mjs — COLRv1 PaintVar* axis interpolation smoke.
//
// Builds a minimal COLR + CPAL byte stream containing:
//   * One BaseGlyphPaintRecord whose paint is a PaintVarTranslate
//     wrapping a PaintGlyph wrapping a PaintSolid.
//   * One ItemVariationStore with a single region (1 axis, peak=1)
//     and one ItemVariationData carrying deltas (+100, +50) for the
//     two deltable fields (dx, dy) of PaintVarTranslate.
//   * No DeltaSetIndexMap — the reader's fallback path uses
//     (outer, inner) = (varIndexBase >> 16, varIndexBase & 0xFFFF).
//
// Walks the static + half-instance + full-instance paint trees and
// verifies dx/dy interpolate linearly along the axis. Also tests
// PaintVarSolid alpha interpolation (static format-3 case).

import { ColrReader } from '../../src/font/color/colrReader.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const approx = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ----- tiny big-endian byte builder ---------------------------------
class Be {
  constructor() {
    this.bytes = [];
  }
  u8(n) {
    this.bytes.push(n & 0xff);
  }
  u16(n) {
    this.bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  u24(n) {
    this.bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  u32(n) {
    this.bytes.push((n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  s16(n) {
    this.u16(n < 0 ? n + 0x10000 : n);
  }
  i32(n) {
    this.u32(n < 0 ? n >>> 0 : n);
  }
  pad(n) {
    while (this.bytes.length < n) this.bytes.push(0);
  }
  toUint8() {
    return new Uint8Array(this.bytes);
  }
}

// ----- build the COLR table -----------------------------------------
//
// Layout (offsets relative to the start of the COLR table):
//   0..33   v1 header
//   34..43  BaseGlyphList: count=1, record(gid=1, paintOff)
//   44..    Paint subtree: PaintVarTranslate → PaintGlyph → PaintSolid
//   then    ItemVariationStore (1 region, 1 IVD with 1 row of 2 deltas)
//
// PaintVarTranslate layout:
//   u8 format=15
//   Offset24 paintOffset (→ PaintGlyph, paint-relative)
//   FWORD dx=10, dy=20
//   u32 varIndexBase=0  (so outer=0, inner=0)
// PaintGlyph:
//   u8 format=10, Offset24 paintOff (→ PaintSolid), u16 glyphID=1
// PaintSolid:
//   u8 format=2, u16 paletteIndex=0, F2DOT14 alpha=1.0
//
// IVS layout (we use ItemVariationStore format 1):
//   u16 format=1
//   u32 regionListOffset (IVS-relative)
//   u16 ivdCount=1
//   u32 ivdOffset[0] (IVS-relative)
//   RegionList: u16 axisCount=1, u16 regionCount=1, region[0]: start=0, peak=1, end=1
//   IVD[0]: itemCount=2 (one row per deltable field — Mantle's IVS reads
//           inner index as the row index, NOT as a column within a row),
//           shortDeltaCount=1, regionIndexCount=1,
//           regionIndices=[0], rows: [+100], [+50]
//
// varIndexBase = 0 → with no DeltaSetIndexMap, decomposed as
//   field 0: idx=0 → outer=0, inner=0 → +100 (dx)
//   field 1: idx=1 → outer=0, inner=1 → +50  (dy)

function buildColrV1Bytes() {
  // === Compute layout ===
  const HEADER_LEN = 34;
  const baseGlyphListOff = HEADER_LEN; // 34
  const baseGlyphListLen = 4 + 6; // count(4) + record(6)
  const paintVarTranslateOff = baseGlyphListOff + baseGlyphListLen; // 44
  const paintVarTranslateLen = 1 + 3 + 2 + 2 + 4; // = 12
  const paintGlyphOff = paintVarTranslateOff + paintVarTranslateLen; // 56
  const paintGlyphLen = 1 + 3 + 2; // = 6
  const paintSolidOff = paintGlyphOff + paintGlyphLen; // 62
  const paintSolidLen = 1 + 2 + 2; // = 5
  // IVS placed after paint tables.
  const ivsOff = paintSolidOff + paintSolidLen; // 67
  // IVS:
  //   header: u16 format(1) + u32 regionListOff + u16 ivdCount(1) + u32 ivdOff[0]  = 12 bytes
  //   RegionList: u16 axisCount + u16 regionCount + 1 region × 1 axis × 6 bytes    = 10 bytes
  //   IVD: u16 itemCount + u16 shortDeltaCount + u16 regionIndexCount
  //        + u16 regionIndices[1] + s16 delta[0][0] + s16 delta[0][1]              = 12 bytes
  const ivsHeaderLen = 12;
  const ivsRegionListOff = ivsOff + ivsHeaderLen; // IVS-relative = 12
  const ivsRegionListLen = 4 + 1 * 1 * 6; // 10
  const ivsIvdOff = ivsRegionListOff + ivsRegionListLen; // IVS-relative = 22
  // const ivsIvdLen = 6 + 2 + (2 * 2);            // 12 (count(2)+shortCount(2)+regCount(2) + regIdx(2) + 2 rows × 2 bytes)

  // === Emit ===
  const b = new Be();
  // v1 header
  b.u16(1); // version
  b.u16(0); // numBaseGlyphRecords (v0)
  b.u32(0); // baseGlyphRecordsOffset (v0)
  b.u32(0); // layerRecordsOffset (v0)
  b.u16(0); // numLayerRecords (v0)
  b.u32(baseGlyphListOff); // baseGlyphListOffset
  b.u32(0); // layerListOffset
  b.u32(0); // clipListOffset
  b.u32(0); // varIndexMapOffset = 0 (no map → fallback decomp)
  b.u32(ivsOff); // itemVariationStoreOffset
  // BaseGlyphList: count + 1 record
  b.u32(1);
  b.u16(1); // glyphID
  b.u32(paintVarTranslateOff - baseGlyphListOff); // paintOff (BGL-relative)
  // PaintVarTranslate (format=15): paintOff → PaintGlyph, dx=10, dy=20, varIndexBase=0
  b.u8(15);
  b.u24(paintGlyphOff - paintVarTranslateOff); // Offset24 paintOff
  b.s16(10); // dx
  b.s16(20); // dy
  b.u32(0); // varIndexBase
  // PaintGlyph: paintOff → PaintSolid, glyphID=1
  b.u8(10);
  b.u24(paintSolidOff - paintGlyphOff); // Offset24 paintOff
  b.u16(1); // glyphID
  // PaintSolid: paletteIndex=0, alpha=1.0
  b.u8(2);
  b.u16(0);
  b.s16(16384);
  // === ItemVariationStore ===
  // u16 format=1, u32 regionListOff (IVS-relative), u16 ivdCount=1, u32 ivdOff
  b.u16(1);
  b.u32(ivsRegionListOff - ivsOff); // IVS-relative
  b.u16(1); // ivdCount
  b.u32(ivsIvdOff - ivsOff); // IVS-relative ivd[0] offset
  // RegionList
  b.u16(1); // axisCount
  b.u16(1); // regionCount
  // region[0] = single axis: start=0, peak=1, end=1 (F2DOT14)
  b.s16(0); // start = 0
  b.s16(16384); // peak = 1
  b.s16(16384); // end = 1
  // IVD[0]: itemCount=2 (one row per deltable field), shortDeltaCount=1,
  // regionIndexCount=1
  b.u16(2); // itemCount
  b.u16(1); // shortDeltaCount
  b.u16(1); // regionIndexCount
  b.u16(0); // regionIndices[0] = 0
  // Row 0 (inner=0): dx delta = +100
  b.s16(100);
  // Row 1 (inner=1): dy delta = +50
  b.s16(50);

  return b.toUint8();
}

// ----- build the CPAL table -----------------------------------------
function buildCpalBytes() {
  const b = new Be();
  b.u16(0); // version
  b.u16(1); // numPaletteEntries
  b.u16(1); // numPalettes
  b.u16(1); // numColorRecords
  // Header is 12 bytes; colorRecordIndices follows (u16[numPalettes] = 2);
  // colorRecords start at 12 + 2 = 14.
  b.u32(14);
  b.u16(0); // colorRecordIndices[0]
  // BGRA red, fully opaque
  b.u8(0x00);
  b.u8(0x00);
  b.u8(0xff);
  b.u8(0xff);
  return b.toUint8();
}

// ----- assemble a single buffer with both tables --------------------
function buildTables() {
  const colr = buildColrV1Bytes();
  const cpal = buildCpalBytes();
  // Pack [colr][cpal] into one buffer; tables.colr/.cpal point at it.
  const buf = new Uint8Array(colr.length + cpal.length);
  buf.set(colr, 0);
  buf.set(cpal, colr.length);
  return {
    view: new DataView(buf.buffer),
    bytes: buf,
    colr: [0, colr.length],
    cpal: [colr.length, cpal.length],
  };
}

// ====================================================================
// T1: static paint tree (coords=null) → dx=10, dy=20 (master values).
// ====================================================================
{
  const reader = new ColrReader(buildTables());
  if (!reader.hasColrV1) fail('T1 reader.hasColrV1 false');
  const paint = reader.getPaint(1, null);
  if (!paint) fail('T1 paint null');
  // PaintTranslate is format 14 in our normalized output (var → static).
  if (paint.format !== 14) fail(`T1 root format ${paint.format} (expected 14)`);
  if (paint.dx !== 10 || paint.dy !== 20) fail(`T1 static dx/dy = (${paint.dx}, ${paint.dy})`);
  else ok(`T1 static getPaint(coords=null): dx=10, dy=20`);
}

// ====================================================================
// T2: half-instance (coord = 0.5) → dx = 10 + 0.5*100 = 60, dy = 45.
// ====================================================================
{
  const reader = new ColrReader(buildTables());
  const paint = reader.getPaint(1, [0.5]);
  if (!paint) fail('T2 paint null');
  if (!approx(paint.dx, 60) || !approx(paint.dy, 45))
    fail(`T2 half dx/dy = (${paint.dx}, ${paint.dy}); expected (60, 45)`);
  else ok(`T2 coord=0.5: dx=${paint.dx}, dy=${paint.dy}`);
}

// ====================================================================
// T3: full-instance (coord = 1.0) → dx = 10 + 100 = 110, dy = 70.
// ====================================================================
{
  const reader = new ColrReader(buildTables());
  const paint = reader.getPaint(1, [1.0]);
  if (!approx(paint.dx, 110) || !approx(paint.dy, 70))
    fail(`T3 full dx/dy = (${paint.dx}, ${paint.dy}); expected (110, 70)`);
  else ok(`T3 coord=1.0: dx=${paint.dx}, dy=${paint.dy}`);
}

// ====================================================================
// T4: PaintVarSolid (format 3) — interpolates alpha along the axis.
// Build a minimal COLR with a single PaintVarSolid root, alpha=1.0,
// delta=-8192 (so coord=1.0 → alpha=0.5).
// ====================================================================
function buildSolidVar() {
  const HEADER_LEN = 34;
  const baseGlyphListOff = HEADER_LEN;
  const baseGlyphListLen = 4 + 6;
  const paintSolidOff = baseGlyphListOff + baseGlyphListLen; // 44
  const paintSolidLen = 1 + 2 + 2 + 4; // 9 (format=3 has +u32)
  const ivsOff = paintSolidOff + paintSolidLen; // 53
  const ivsHeaderLen = 12;
  const ivsRegionListOff = ivsOff + ivsHeaderLen;
  const ivsRegionListLen = 4 + 6;
  const ivsIvdOff = ivsRegionListOff + ivsRegionListLen;

  const b = new Be();
  // v1 header
  b.u16(1);
  b.u16(0);
  b.u32(0);
  b.u32(0);
  b.u16(0);
  b.u32(baseGlyphListOff);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  b.u32(ivsOff);
  // BaseGlyphList
  b.u32(1);
  b.u16(1);
  b.u32(paintSolidOff - baseGlyphListOff);
  // PaintVarSolid (format=3): paletteIndex=0, alpha=1.0, varIndexBase=0
  b.u8(3);
  b.u16(0);
  b.s16(16384);
  b.u32(0);
  // IVS — 1 region (peak=1 on single axis), 1 IVD with 1 short delta = -8192
  b.u16(1);
  b.u32(ivsRegionListOff - ivsOff);
  b.u16(1);
  b.u32(ivsIvdOff - ivsOff);
  b.u16(1);
  b.u16(1);
  b.s16(0);
  b.s16(16384);
  b.s16(16384);
  b.u16(1);
  b.u16(1);
  b.u16(1);
  b.u16(0);
  b.s16(-8192);

  const colr = b.toUint8();
  const cpal = buildCpalBytes();
  const buf = new Uint8Array(colr.length + cpal.length);
  buf.set(colr, 0);
  buf.set(cpal, colr.length);
  return {
    view: new DataView(buf.buffer),
    bytes: buf,
    colr: [0, colr.length],
    cpal: [colr.length, cpal.length],
  };
}

{
  const reader = new ColrReader(buildSolidVar());
  const staticPaint = reader.getPaint(1, null);
  if (!staticPaint) fail('T4 static paint null');
  else if (staticPaint.format !== 2 || !approx(staticPaint.alpha, 1.0))
    fail(`T4 static format=${staticPaint.format} alpha=${staticPaint.alpha}`);
  else ok(`T4 PaintVarSolid static: alpha=1.0`);

  const halfPaint = reader.getPaint(1, [0.5]);
  // alpha = 1.0 + 0.5 * (-8192)/16384 = 1.0 - 0.25 = 0.75
  if (!approx(halfPaint.alpha, 0.75)) fail(`T4 half alpha = ${halfPaint.alpha}; expected 0.75`);
  else ok(`T4 PaintVarSolid coord=0.5: alpha=${halfPaint.alpha}`);

  const fullPaint = reader.getPaint(1, [1.0]);
  if (!approx(fullPaint.alpha, 0.5)) fail(`T4 full alpha = ${fullPaint.alpha}; expected 0.5`);
  else ok(`T4 PaintVarSolid coord=1.0: alpha=${fullPaint.alpha}`);
}

// ====================================================================
// T5: rgba captures the var-interpolated alpha (so callers reading rgba
// directly see the interpolated result, not the master alpha).
// ====================================================================
{
  const reader = new ColrReader(buildSolidVar());
  const p = reader.getPaint(1, [1.0]);
  if (!p.rgba || !approx(p.rgba[3], 0.5)) fail(`T5 rgba.a = ${p.rgba && p.rgba[3]}; expected 0.5`);
  else ok(`T5 rgba.alpha reflects interpolated alpha (0.5)`);
}

// ====================================================================
// T6: PaintVarLinearGradient with VarColorLine — gradient endpoints
// (p0..p2) shift along axis AND per-stop offsets/alphas shift along
// axis. Build:
//   PaintVarLinearGradient root, p0=(0,0), p1=(100,0), p2=(0,100)
//   VarColorLine with 2 stops:
//     stop 0: offset=0.0 paletteIndex=0 alpha=1.0  varIndexBase=2
//     stop 1: offset=1.0 paletteIndex=0 alpha=1.0  varIndexBase=4
//   IVS has 6 items (6 rows of 1 short delta each):
//     row 0 (grad x0)        : +20
//     row 1 (grad y0)        : +30
//     row 2 (stop0 offset)   : +1638  (= +0.1 in F2DOT14)
//     row 3 (stop0 alpha)    : -8192  (= -0.5)
//     row 4 (stop1 offset)   : -1638  (= -0.1)
//     row 5 (stop1 alpha)    : 0
//   Gradient's varIndexBase=0 → fields 0..5 = items 0..5 in inner index;
//   only fields 0,1 carry non-zero deltas to keep the test focused.
//   Stop 0's varIndexBase=2 → fields 0,1 = items 2,3 (offset & alpha).
//   Stop 1's varIndexBase=4 → fields 0,1 = items 4,5.
// ====================================================================
function buildLinearGradVar() {
  const HEADER_LEN = 34;
  const baseGlyphListOff = HEADER_LEN;
  const baseGlyphListLen = 4 + 6;
  const paintGradOff = baseGlyphListOff + baseGlyphListLen; // 44
  // PaintVarLinearGradient = 1 + 3 + 12 + 4 = 20 bytes.
  const paintGradLen = 1 + 3 + 12 + 4;
  const clOff = paintGradOff + paintGradLen; // 64
  // VarColorLine: u8 extend + u16 numStops + 2 × 10-byte stops
  const clLen = 1 + 2 + 2 * 10; // 23
  const ivsOff = clOff + clLen; // 87
  const ivsHeaderLen = 12;
  const ivsRegionListOff = ivsOff + ivsHeaderLen;
  const ivsRegionListLen = 4 + 6;
  const ivsIvdOff = ivsRegionListOff + ivsRegionListLen;

  const b = new Be();
  // v1 header
  b.u16(1);
  b.u16(0);
  b.u32(0);
  b.u32(0);
  b.u16(0);
  b.u32(baseGlyphListOff);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  b.u32(ivsOff);
  // BaseGlyphList: 1 record → PaintVarLinearGradient at paintGradOff
  b.u32(1);
  b.u16(1);
  b.u32(paintGradOff - baseGlyphListOff);
  // PaintVarLinearGradient (format=5):
  //   Offset24 colorLineOffset (paint-relative)
  //   FWORD x0=0, y0=0, x1=100, y1=0, x2=0, y2=100
  //   u32 varIndexBase=0
  b.u8(5);
  b.u24(clOff - paintGradOff);
  b.s16(0);
  b.s16(0);
  b.s16(100);
  b.s16(0);
  b.s16(0);
  b.s16(100);
  b.u32(0);
  // VarColorLine:
  //   u8 extend=0(PAD), u16 numStops=2
  //   stop 0: offset=0.0 (s16=0), palIdx=0, alpha=1.0 (s16=16384),
  //           varIndexBase=2
  //   stop 1: offset=1.0 (s16=16384), palIdx=0, alpha=1.0 (s16=16384),
  //           varIndexBase=4
  b.u8(0);
  b.u16(2);
  b.s16(0);
  b.u16(0);
  b.s16(16384);
  b.u32(2);
  b.s16(16384);
  b.u16(0);
  b.s16(16384);
  b.u32(4);
  // === IVS ===
  // header
  b.u16(1);
  b.u32(ivsRegionListOff - ivsOff);
  b.u16(1);
  b.u32(ivsIvdOff - ivsOff);
  // RegionList: 1 axis, 1 region with peak=1
  b.u16(1);
  b.u16(1);
  b.s16(0);
  b.s16(16384);
  b.s16(16384);
  // IVD: itemCount=6 (6 rows, one per deltable field across the 3
  // var-aware records), shortDeltaCount=1 (=regionIndexCount; each row
  // is one short delta), regionIndexCount=1
  b.u16(6);
  b.u16(1);
  b.u16(1);
  b.u16(0);
  b.s16(20); // row 0 → grad x0 delta
  b.s16(30); // row 1 → grad y0 delta
  b.s16(1638); // row 2 → stop0 offset delta (+0.1)
  b.s16(-8192); // row 3 → stop0 alpha delta (-0.5)
  b.s16(-1638); // row 4 → stop1 offset delta (-0.1)
  b.s16(0); // row 5 → stop1 alpha delta

  const colr = b.toUint8();
  const cpal = buildCpalBytes();
  const buf = new Uint8Array(colr.length + cpal.length);
  buf.set(colr, 0);
  buf.set(cpal, colr.length);
  return {
    view: new DataView(buf.buffer),
    bytes: buf,
    colr: [0, colr.length],
    cpal: [colr.length, cpal.length],
  };
}

{
  const reader = new ColrReader(buildLinearGradVar());
  const staticPaint = reader.getPaint(1, null);
  if (!staticPaint || staticPaint.format !== 4)
    fail(`T6 static format ${staticPaint && staticPaint.format}`);
  else if (staticPaint.p0[0] !== 0 || staticPaint.p0[1] !== 0)
    fail(`T6 static p0 ${staticPaint.p0}`);
  else if (staticPaint.stops[0].offset !== 0 || staticPaint.stops[1].offset !== 1)
    fail(`T6 static stop offsets ${staticPaint.stops[0].offset}, ${staticPaint.stops[1].offset}`);
  else ok(`T6 PaintVarLinearGradient static: p0=(0,0), stops=[0, 1]`);

  const fullPaint = reader.getPaint(1, [1.0]);
  // Expected at coord=1: p0=(20,30), p1/p2/r unchanged because their
  // deltas are 0 (only items 0,1 are populated for the gradient).
  // Stops: stop0 offset = 0 + 0.1 = 0.1, alpha = 1 - 0.5 = 0.5;
  //        stop1 offset = 1 - 0.1 = 0.9, alpha = 1.0 (no change).
  if (!approx(fullPaint.p0[0], 20) || !approx(fullPaint.p0[1], 30))
    fail(`T6 full p0 ${fullPaint.p0}; expected (20, 30)`);
  else if (!approx(fullPaint.stops[0].offset, 0.1) || !approx(fullPaint.stops[0].alpha, 0.5))
    fail(
      `T6 full stop0 = { offset=${fullPaint.stops[0].offset}, alpha=${fullPaint.stops[0].alpha} }`,
    );
  else if (!approx(fullPaint.stops[1].offset, 0.9))
    fail(`T6 full stop1 offset = ${fullPaint.stops[1].offset}; expected 0.9`);
  else ok(`T6 PaintVarLinearGradient coord=1.0: p0=(20,30), stops=[(0.1, 0.5), (0.9, 1.0)]`);

  const halfPaint = reader.getPaint(1, [0.5]);
  // Half-scaled deltas: p0=(10,15), stop0=(0.05, 0.75), stop1=(0.95, 1).
  if (!approx(halfPaint.p0[0], 10) || !approx(halfPaint.p0[1], 15))
    fail(`T6 half p0 ${halfPaint.p0}`);
  else if (!approx(halfPaint.stops[0].offset, 0.05) || !approx(halfPaint.stops[0].alpha, 0.75))
    fail(
      `T6 half stop0 = { offset=${halfPaint.stops[0].offset}, alpha=${halfPaint.stops[0].alpha} }`,
    );
  else if (!approx(halfPaint.stops[1].offset, 0.95))
    fail(`T6 half stop1 offset = ${halfPaint.stops[1].offset}`);
  else ok(`T6 PaintVarLinearGradient coord=0.5: half-interp p0 + stops`);
}

console.log();
console.log(failures === 0 ? 'COLR-VAR PASS' : `COLR-VAR FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

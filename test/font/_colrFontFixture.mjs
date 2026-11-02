// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _colrFontFixture.mjs — builds a minimal sfnt with COLR v0 + CPAL
// in-memory so F8 tests don't need a vendored binary font.
//
// Tables: head, hhea, hmtx, maxp, cmap, loca, glyf, post, COLR, CPAL.
// Geometry is intentionally trivial — three glyphs forming a Trianon
// emoji: base glyph (gid 1) wraps two layer glyphs (gids 2 and 3),
// each a small square. Real fonts use much richer outlines; we
// just need enough that downstream code (glyph reader → segs) has
// real work to do.

const TAG = (s) =>
  (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3);

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
  s16(n) {
    this.u16(n & 0xffff);
  }
  u32(n) {
    this.bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  fixed(major, minor) {
    this.u16(major);
    this.u16(minor);
  }
  longDateTime(seconds) {
    this.u32(0); // upper 32 bits = 0 for any modern date
    this.u32(seconds & 0xffffffff);
  }
  raw(arr) {
    for (const b of arr) this.bytes.push(b & 0xff);
  }
  pad4() {
    while (this.bytes.length & 3) this.bytes.push(0);
  }
  get length() {
    return this.bytes.length;
  }
  toUint8() {
    return new Uint8Array(this.bytes);
  }
}

// ---- Per-table builders --------------------------------------------

function buildHead(unitsPerEm) {
  const b = new Be();
  b.fixed(1, 0); // version 1.0
  b.fixed(1, 0); // fontRevision
  b.u32(0); // checkSumAdjustment — patched after assembly
  b.u32(0x5f0f3cf5); // magicNumber
  b.u16(0); // flags
  b.u16(unitsPerEm);
  b.longDateTime(0); // created
  b.longDateTime(0); // modified
  b.s16(0);
  b.s16(-200); // xMin, yMin
  b.s16(unitsPerEm);
  b.s16(unitsPerEm); // xMax, yMax
  b.u16(0); // macStyle
  b.u16(8); // lowestRecPPEM
  b.s16(2); // fontDirectionHint
  b.s16(0); // indexToLocFormat — short
  b.s16(0); // glyphDataFormat
  return b.toUint8();
}

function buildHhea(unitsPerEm, numHMetrics) {
  const b = new Be();
  b.fixed(1, 0);
  b.s16(unitsPerEm); // ascender
  b.s16(-200); // descender
  b.s16(0); // lineGap
  b.u16(unitsPerEm); // advanceWidthMax
  b.s16(0);
  b.s16(0);
  b.s16(unitsPerEm); // minLSB / minRSB / xMaxExtent
  b.s16(1);
  b.s16(0); // caretSlopeRise / Run
  b.s16(0); // caretOffset
  b.s16(0);
  b.s16(0);
  b.s16(0);
  b.s16(0); // reserved
  b.s16(0); // metricDataFormat
  b.u16(numHMetrics);
  return b.toUint8();
}

function buildHmtx(advances, lsbs) {
  const b = new Be();
  for (let i = 0; i < advances.length; i++) {
    b.u16(advances[i]);
    b.s16(lsbs[i] || 0);
  }
  return b.toUint8();
}

function buildMaxp(numGlyphs, complete = false) {
  const b = new Be();
  b.fixed(1, 0);
  b.u16(numGlyphs);
  if (complete) {
    // maxPoints 4, maxContours 1 (every outline is one 4-point square), no composites, maxZones 2, the
    // rest zero -- values a browser's sanitizer can check against glyf.
    b.u16(4);
    b.u16(1);
    b.u16(0);
    b.u16(0);
    b.u16(2);
    for (let i = 0; i < 8; i++) b.u16(0);
    return b.toUint8();
  }
  // Rest of v1.0 maxp can be zeros — the parser doesn't validate.
  for (let i = 0; i < 13; i++) b.u16(0);
  return b.toUint8();
}

// OS/2 version 4 (96 bytes) and a Windows-platform name table: the two tables the fixture otherwise
// omits and a browser's font sanitizer (OTS) requires, so the same bytes can load in Chrome too.
function buildOs2(unitsPerEm) {
  const b = new Be();
  b.u16(4); // version
  b.s16(500); // xAvgCharWidth
  b.u16(400);
  b.u16(5);
  b.u16(0); // usWeightClass, usWidthClass, fsType (installable)
  for (let i = 0; i < 4; i++) b.s16(100); // ySubscriptXSize/YSize/XOffset/YOffset
  for (let i = 0; i < 4; i++) b.s16(100); // ySuperscript...
  b.s16(50);
  b.s16(250); // yStrikeoutSize, yStrikeoutPosition
  b.s16(0); // sFamilyClass
  for (let i = 0; i < 10; i++) b.u8(0); // panose
  b.u32(1);
  b.u32(0);
  b.u32(0);
  b.u32(0); // ulUnicodeRange1..4 (Basic Latin)
  b.u8(0x4d);
  b.u8(0x4e);
  b.u8(0x54);
  b.u8(0x4c); // achVendID 'MNTL'
  b.u16(0x40); // fsSelection: REGULAR
  b.u16(0x20);
  b.u16(0x7e); // usFirstCharIndex, usLastCharIndex
  b.s16(unitsPerEm);
  b.s16(-200);
  b.s16(0); // sTypoAscender, sTypoDescender, sTypoLineGap
  b.u16(unitsPerEm);
  b.u16(200); // usWinAscent, usWinDescent
  b.u32(1);
  b.u32(0); // ulCodePageRange1..2 (Latin 1)
  b.s16(500);
  b.s16(700); // sxHeight, sCapHeight
  b.u16(0);
  b.u16(0x20);
  b.u16(1); // usDefaultChar, usBreakChar, usMaxContext
  return b.toUint8();
}

function buildName(family) {
  const recs = [
    [1, family],
    [2, 'Regular'],
    [3, family + ' Regular'],
    [4, family],
    [6, family.replace(/\s+/g, '')],
  ];
  const strings = recs.map(([, t]) => {
    const a = [];
    for (const ch of t) {
      const c = ch.charCodeAt(0);
      a.push(c >> 8, c & 0xff);
    }
    return a;
  });
  const b = new Be();
  b.u16(0);
  b.u16(recs.length);
  b.u16(6 + 12 * recs.length);
  let off = 0;
  recs.forEach(([id], i) => {
    b.u16(3);
    b.u16(1);
    b.u16(0x409);
    b.u16(id);
    b.u16(strings[i].length);
    b.u16(off);
    off += strings[i].length;
  });
  for (const st of strings) b.raw(st);
  return b.toUint8();
}

// cmap format 4 — minimum two segments (the codepoint-range and the
// 0xFFFF sentinel). One codepoint → gid 1 (the COLR base glyph).
function buildCmap(codepoint) {
  // Encoding record: platform 3 (Windows), encoding 1 (UCS-2), offset 12.
  // Subtable: format 4 with two segments [cp, cp] + [0xFFFF, 0xFFFF].
  const sub = new Be();
  const lang = 0;
  const segCount = 2;
  const searchRange = 2 * 2; // 2 * floor(log2(segCount))
  const entrySelector = 1;
  const rangeShift = segCount * 2 - searchRange;
  // length = 16 (header) + 2*segCount*4 + 2 (reservedPad) + 2*segCount (idDelta)
  //   Wait: format 4 has endCount[segCount] (2*segCount) + reservedPad (2)
  //   + startCount[segCount] (2*segCount) + idDelta[segCount] (2*segCount)
  //   + idRangeOffset[segCount] (2*segCount). That's 16 + 8*segCount.
  const length = 16 + 8 * segCount;
  sub.u16(4); // format
  sub.u16(length); // length
  sub.u16(lang); // language
  sub.u16(segCount * 2); // segCountX2
  sub.u16(searchRange);
  sub.u16(entrySelector);
  sub.u16(rangeShift);
  sub.u16(codepoint);
  sub.u16(0xffff); // endCount
  sub.u16(0); // reservedPad
  sub.u16(codepoint);
  sub.u16(0xffff); // startCount
  // idDelta = gid - codepoint (mod 65536). gid=1 maps to codepoint.
  sub.s16((1 - codepoint) & 0xffff);
  sub.s16(1); // 0xFFFF → gid 1 (unused; never queried)
  sub.u16(0);
  sub.u16(0); // idRangeOffset (both 0 = use idDelta)

  const b = new Be();
  b.u16(0); // version
  b.u16(1); // numTables (1 encoding record)
  b.u16(3);
  b.u16(1);
  b.u32(12); // platform=3, encoding=1, offset=12
  b.raw(Array.from(sub.toUint8()));
  return b.toUint8();
}

// glyf table: 4 glyphs.
//   gid 0 = .notdef (empty)
//   gid 1 = the base glyph (also empty — COLR layers carry the geometry)
//   gid 2 = a small square (layer 0)
//   gid 3 = a wider square (layer 1)
// loca format: short (offsets divided by 2). Returned alongside.
function buildGlyfAndLoca() {
  // Each non-empty glyph = simple outline:
  //   numberOfContours (s16) = 1
  //   xMin, yMin, xMax, yMax (s16 each)
  //   endPtsOfContours (u16 × numContours)
  //   instructionLength (u16) = 0
  //   flags (u8 × numPts)
  //   xCoords (s8 or s16, per flag bit)
  //   yCoords (s8 or s16, per flag bit)
  function simpleSquare(xmin, ymin, xmax, ymax) {
    const b = new Be();
    b.s16(1); // numberOfContours
    b.s16(xmin);
    b.s16(ymin);
    b.s16(xmax);
    b.s16(ymax);
    b.u16(3); // endPt of contour (4 pts: 0..3)
    b.u16(0); // instructionLength
    // Flags: on-curve, x-short (positive), y-short (positive) when delta>=0.
    // We'll use x-short=1, y-short=1 always. Bits:
    //   0x01 on-curve, 0x02 xShort, 0x04 yShort,
    //   0x10 = xPositive (when xShort), 0x20 = yPositive (when yShort)
    // For simplicity, emit absolute coords as 4 pts in order:
    //   (xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax)
    // glyf stores deltas. We'll switch to 2-byte coord mode (no xShort/yShort flag).
    // flags byte: on-curve only (0x01) ⇒ deltas are 2-byte signed.
    for (let i = 0; i < 4; i++) b.u8(0x01);
    // x deltas: xmin, (xmax-xmin), 0, (xmin-xmax) — relative to previous
    b.s16(xmin);
    b.s16(xmax - xmin);
    b.s16(0);
    b.s16(xmin - xmax);
    // y deltas: ymin, 0, (ymax-ymin), 0
    b.s16(ymin);
    b.s16(0);
    b.s16(ymax - ymin);
    b.s16(0);
    b.pad4();
    return b.toUint8();
  }
  // gid 0 + gid 1 are empty (zero-length glyph records).
  const g0 = new Uint8Array(0);
  const g1 = new Uint8Array(0);
  const g2 = simpleSquare(50, 50, 350, 350);
  const g3 = simpleSquare(100, 100, 700, 400);

  // Concatenate, compute short loca offsets (offsets / 2).
  const glyf = new Be();
  const offs = [0];
  for (const g of [g0, g1, g2, g3]) {
    glyf.raw(Array.from(g));
    glyf.pad4();
    offs.push(glyf.length);
  }
  const loca = new Be();
  for (const off of offs) loca.u16(off >> 1); // short loca: divided by 2
  return { glyf: glyf.toUint8(), loca: loca.toUint8() };
}

function buildPost() {
  // Minimal post v3 (no glyph names).
  const b = new Be();
  b.fixed(3, 0); // version 3.0
  b.u32(0); // italicAngle (Fixed)
  b.s16(-100); // underlinePosition
  b.s16(50); // underlineThickness
  b.u32(1); // isFixedPitch
  b.u32(0);
  b.u32(0);
  b.u32(0);
  b.u32(0); // memory fields (4 × u32)
  return b.toUint8();
}

// COLR v0: gid 1 → [layer(gid=2, pal=0), layer(gid=3, pal=palOrFg)]
//   palOrFg = 1 (palette green) by default, or 0xFFFF (foreground
//   sentinel) when fgLayer1 is true. Lets the visual fixture
//   exercise both palette and run-color paths.
function buildColr({ fgLayer1 = false } = {}) {
  const b = new Be();
  b.u16(0); // version
  b.u16(1); // numBaseGlyphRecords
  b.u32(14); // baseGlyphRecordsOffset
  b.u32(14 + 6); // layerRecordsOffset
  b.u16(2); // numLayerRecords
  // BaseGlyphRecord: gid 1, firstLayer 0, numLayer 2
  b.u16(1);
  b.u16(0);
  b.u16(2);
  // LayerRecords
  b.u16(2);
  b.u16(0); // layer 0: gid 2, palette 0 (red)
  b.u16(3);
  b.u16(fgLayer1 ? 0xffff : 1); // layer 1: gid 3, palette 1 or fg sentinel
  return b.toUint8();
}

// COLR v1 with a small paint tree:
//   Base glyph 1 → PaintColrLayers (2 layers)
//     Layer 0 → PaintSolid (paletteIndex=0 red, alpha=1.0)
//     Layer 1 → PaintSolid (paletteIndex=1 green, alpha=0.5)
// No clipList/varIndexMap/itemVarStore (all offsets = 0).
//
// Header layout (32 bytes through itemVariationStoreOffset):
//   u16 version=1, u16 numBaseGlyphRecords=0,
//   u32 baseGlyphRecordsOffset=0, u32 layerRecordsOffset=0,
//   u16 numLayerRecords=0,
//   u32 baseGlyphListOffset, u32 layerListOffset,
//   u32 clipListOffset=0, u32 varIndexMapOffset=0,
//   u32 itemVariationStoreOffset=0
//
// We place the BaseGlyphList immediately after the header, then the
// LayerList, then the Paint tables. All offsets in the spec are
// relative to the START of the table that contains the reference,
// so BaseGlyphPaintRecord.paintOffset is BaseGlyphList-relative,
// LayerList Offset32 entries are LayerList-relative.
function buildColrV1() {
  // COLR v1 header is 34 bytes:
  //   u16 version=1                                   (0..1)
  //   u16 numBaseGlyphRecords (v0)                    (2..3)
  //   u32 baseGlyphRecordsOffset (v0)                 (4..7)
  //   u32 layerRecordsOffset (v0)                     (8..11)
  //   u16 numLayerRecords (v0)                        (12..13)
  //   u32 baseGlyphListOffset                         (14..17)
  //   u32 layerListOffset                             (18..21)
  //   u32 clipListOffset                              (22..25)
  //   u32 varIndexMapOffset                           (26..29)
  //   u32 itemVariationStoreOffset                    (30..33)
  //
  // Layout from the start of the COLR table:
  //   [0..33]  header
  //   [34..]   BaseGlyphList: u32 count=1 + record(u16 gid, u32 paintOff)
  //              record paintOff is BaseGlyphList-relative
  //   then     LayerList: u32 count=2 + Offset32[2] paint offsets
  //              each entry is LayerList-relative
  //   then     Paint tables (one PaintColrLayers + two PaintSolid)
  const headerLen = 34;
  const baseGlyphListOff = headerLen; // 34
  const baseGlyphListLen = 4 + 6; // count + 1 record
  const layerListOff = baseGlyphListOff + baseGlyphListLen; // 44
  const layerListLen = 4 + 2 * 4; // count + 2 Offset32
  const paint0Off = layerListOff + layerListLen; // PaintColrLayers (6 bytes)
  const paint1Off = paint0Off + 6; // PaintSolid layer 0 (5 bytes)
  const paint2Off = paint1Off + 5; // PaintSolid layer 1 (5 bytes)

  const b = new Be();
  // Header
  b.u16(1); // version
  b.u16(0); // numBaseGlyphRecords (v0)
  b.u32(0); // baseGlyphRecordsOffset (v0)
  b.u32(0); // layerRecordsOffset (v0)
  b.u16(0); // numLayerRecords (v0)
  b.u32(baseGlyphListOff); // baseGlyphListOffset
  b.u32(layerListOff); // layerListOffset
  b.u32(0); // clipListOffset
  b.u32(0); // varIndexMapOffset
  b.u32(0); // itemVariationStoreOffset
  // BaseGlyphList: count + 1 record
  b.u32(1); // numBaseGlyphPaintRecords
  b.u16(1); // glyphID 1
  // paintOffset: BaseGlyphList-relative position of PaintColrLayers.
  // PaintColrLayers lives at paint0Off (COLR-absolute) → bglRel offset.
  b.u32(paint0Off - baseGlyphListOff);
  // LayerList: count + Offset32[2]
  b.u32(2); // numLayers
  b.u32(paint1Off - layerListOff); // layer 0 → PaintSolid red
  b.u32(paint2Off - layerListOff); // layer 1 → PaintSolid green-half
  // PaintColrLayers: u8 format=1, u8 numLayers=2, u32 firstLayerIndex=0
  b.u8(1);
  b.u8(2);
  b.u32(0);
  // PaintSolid layer 0: u8 format=2, u16 paletteIndex=0, F2DOT14 alpha=1.0
  b.u8(2);
  b.u16(0);
  b.s16(16384);
  // PaintSolid layer 1: u8 format=2, u16 paletteIndex=1, F2DOT14 alpha=0.5
  b.u8(2);
  b.u16(1);
  b.s16(8192);
  return b.toUint8();
}

// CPAL v0: palette 0 = [red, green], 2 entries -- or [red, green, blue] with `blue`.
function buildCpal(blue = false) {
  const n = blue ? 3 : 2;
  const b = new Be();
  b.u16(0); // version
  b.u16(n); // numPaletteEntries
  b.u16(1); // numPalettes
  b.u16(n); // numColorRecords
  b.u32(12 + 2); // colorRecordsArrayOffset (header + idx[1])
  b.u16(0); // colorRecordIndices: palette 0 starts at 0
  // BGRA storage:
  b.u8(0x00);
  b.u8(0x00);
  b.u8(0xff);
  b.u8(0xff); // BGRA → RGBA red
  b.u8(0x00);
  b.u8(0xff);
  b.u8(0x00);
  b.u8(0xff); // BGRA → RGBA green
  if (blue) {
    b.u8(0xff);
    b.u8(0x00);
    b.u8(0x00);
    b.u8(0xff);
  } // BGRA → RGBA blue
  return b.toUint8();
}

// COLR v1 whose base glyph (gid 1) is ONE gradient clipped by the square gid 2 (50..350 on both axes,
// font units, y up) -- a glyph whose colors have known POSITIONS. The gradient runs red
// (palette 0) to blue (palette 2) exactly across the square:
//   'h'     PaintLinearGradient  p0 (50, 200) -> p1 (350, 200): red at the left edge, blue at the right
//   'v'     PaintLinearGradient  p0 (200, 50) -> p1 (200, 350): red at the BOTTOM, blue at the top (y up)
//   'sweep' PaintSweepGradient   center (200, 200), 0 -> 360 degrees counter-clockwise from +x
//
//   PaintGlyph     : 6  (1 + Offset24 + u16 glyphId)
//   PaintLinear    : 16 (1 + Offset24 + 6 x FWORD)
//   PaintSweep     : 12 (1 + Offset24 + 2 x FWORD + 2 x F2DOT14)
//   ColorLine      : 3 + 2 x 6
export function buildColrV1GlyphGrad(kind, fgStop = false) {
  const headerLen = 34;
  const bgl = headerLen,
    bglLen = 4 + 6;
  const pGlyph = bgl + bglLen;
  const pGrad = pGlyph + 6;
  const gradLen = kind === 'sweep' ? 12 : 16;
  const pLine = pGrad + gradLen;
  const off24 = (b, d) => {
    b.u8((d >> 16) & 0xff);
    b.u8((d >> 8) & 0xff);
    b.u8(d & 0xff);
  };
  const b = new Be();
  b.u16(1);
  b.u16(0);
  b.u32(0);
  b.u32(0);
  b.u16(0);
  b.u32(bgl);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  b.u32(1);
  b.u16(1);
  b.u32(pGlyph - bgl); // BaseGlyphList: gid 1 -> PaintGlyph
  b.u8(10);
  off24(b, pGrad - pGlyph);
  b.u16(2); // PaintGlyph(gid 2)
  if (kind === 'sweep') {
    // Angles are F2DOT14 biased by 1.0: angle = (raw / 16384 + 1) * 180, so 0 -> -16384 and 360 -> 16384.
    b.u8(8);
    off24(b, pLine - pGrad);
    b.s16(200);
    b.s16(200);
    b.s16(-16384);
    b.s16(16384);
  } else {
    const [p0, p1, p2] =
      kind === 'v'
        ? [
            [200, 50],
            [200, 350],
            [500, 50],
          ]
        : [
            [50, 200],
            [350, 200],
            [50, 500],
          ];
    b.u8(4);
    off24(b, pLine - pGrad);
    for (const [x, y] of [p0, p1, p2]) {
      b.s16(x);
      b.s16(y);
    }
  }
  b.u8(0);
  b.u16(2); // ColorLine: PAD, 2 stops
  b.s16(0);
  b.u16(0);
  b.s16(16384); // 0.0: red
  if (fgStop) {
    b.s16(16384);
    b.u16(0xffff);
    b.s16(8192);
  } // 1.0: the text's own color at alpha 0.5
  else {
    b.s16(16384);
    b.u16(2);
    b.s16(16384);
  } // 1.0: blue
  return b.toUint8();
}

// Assemble the sfnt: table directory + tables. CheckSums are zero
// (parser doesn't validate; matches what fonttools' subsetter does
// when it strips them).
function tableDir(records) {
  // OpenType table directory:
  //   u32 sfntVersion = 0x00010000 (TTF)
  //   u16 numTables
  //   u16 searchRange  (2^floor(log2(n)) * 16)
  //   u16 entrySelector (floor(log2(n)))
  //   u16 rangeShift   (n*16 - searchRange)
  const n = records.length;
  // Need to place tables AFTER the directory. Directory size = 12 + 16*n.
  const dirSize = 12 + 16 * n;
  // Pad each table to 4 bytes.
  let cursor = dirSize;
  const offsets = [];
  for (const r of records) {
    offsets.push(cursor);
    cursor += r.bytes.length;
    while (cursor & 3) cursor++;
  }
  const total = cursor;

  // Sort table records by tag (OT spec requires alphabetical).
  const sorted = records.slice().sort((a, b) => a.tag - b.tag);
  // ... but offsets array maps to the ORIGINAL order — re-sort it.
  const tagToOffset = new Map();
  for (let i = 0; i < records.length; i++) tagToOffset.set(records[i].tag, offsets[i]);

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000, false); // sfntVersion
  dv.setUint16(4, n, false);
  // Compute searchRange etc.
  let pow = 1,
    log = 0;
  while (pow << 1 <= n) {
    pow <<= 1;
    log++;
  }
  const searchRange = pow * 16;
  const entrySelector = log;
  const rangeShift = n * 16 - searchRange;
  dv.setUint16(6, searchRange, false);
  dv.setUint16(8, entrySelector, false);
  dv.setUint16(10, rangeShift, false);

  // Write directory entries in sorted-tag order.
  let dirCursor = 12;
  for (const r of sorted) {
    dv.setUint32(dirCursor + 0, r.tag, false);
    dv.setUint32(dirCursor + 4, 0, false); // checkSum — leave zero
    dv.setUint32(dirCursor + 8, tagToOffset.get(r.tag), false);
    dv.setUint32(dirCursor + 12, r.bytes.length, false);
    dirCursor += 16;
  }
  // Write table bodies in ORIGINAL order so we can use `offsets`.
  for (let i = 0; i < records.length; i++) {
    out.set(records[i].bytes, offsets[i]);
  }
  return out;
}

// Build a richer COLR v1 table exercising additional Paint formats:
//   Base glyph 1 → PaintGlyph (gid 2 as clip)
//                    └ PaintTransform (scale 0.5x, translate +100/+50)
//                         └ PaintColrLayers (2)
//                              ├ PaintSolid (paletteIndex=0 red α=1)
//                              └ PaintSolid (paletteIndex=1 green α=0.5)
//   Base glyph 2 → PaintColrGlyph(1) — reference to glyph 1's tree
//   Base glyph 3 → PaintComposite (mode=7 hard-light)
//                    ├ src: PaintRotate(45°)
//                    │        └ PaintSolid (paletteIndex=0 red)
//                    └ dst: PaintSolid (paletteIndex=1 green)
//
// All offsets are laid out explicitly so the binary layout is easy
// to trace. Field sizes (in bytes):
//   PaintColrLayers : 6   (1+1+4)
//   PaintSolid      : 5   (1+2+2)
//   PaintGlyph      : 6   (1+3+2)
//   PaintColrGlyph  : 3   (1+2)
//   PaintTransform  : 7   (1+3+3: Offset24 paint, Offset24 to the Affine2x3)
//   Affine2x3       : 24  (Fixed[6], placed after the paints; reached through PaintTransform's second offset)
//   PaintRotate     : 6   (1+3+2)
//   PaintComposite  : 8   (1+3+1+3)
function buildColrV1Rich() {
  const headerLen = 34;
  const baseGlyphListOff = headerLen;
  const baseGlyphListLen = 4 + 3 * 6;
  const layerListOff = baseGlyphListOff + baseGlyphListLen;
  const layerListLen = 4 + 2 * 4;
  // Lay paints out in declaration order using a tiny cursor helper.
  let cursor = layerListOff + layerListLen;
  function paint(size) {
    const off = cursor;
    cursor += size;
    return off;
  }
  const pGlyph1 = paint(6); // PaintGlyph
  const pXform1 = paint(7); // PaintTransform
  const pLayers1 = paint(6); // PaintColrLayers
  const pLayerSolid0 = paint(5); // LL[0] PaintSolid red
  const pLayerSolid1 = paint(5); // LL[1] PaintSolid green
  const pColrRef2 = paint(3); // PaintColrGlyph(1)
  const pComposite3 = paint(8); // PaintComposite
  const pRot3 = paint(6); // PaintRotate
  const pSolid3Src = paint(5); // PaintSolid red (rotate child)
  const pSolid3Dst = paint(5); // PaintSolid green (composite dst)
  const pAffine1 = paint(24); // Affine2x3 of pXform1 (OpenType layout: behind an Offset24, never inline)

  function off24(b, delta) {
    b.u8((delta >> 16) & 0xff);
    b.u8((delta >> 8) & 0xff);
    b.u8(delta & 0xff);
  }

  const b = new Be();
  // Header
  b.u16(1);
  b.u16(0);
  b.u32(0);
  b.u32(0);
  b.u16(0);
  b.u32(baseGlyphListOff);
  b.u32(layerListOff);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  // BaseGlyphList: 3 records (gid 1, 2, 3 — must be sorted ascending)
  b.u32(3);
  b.u16(1);
  b.u32(pGlyph1 - baseGlyphListOff);
  b.u16(2);
  b.u32(pColrRef2 - baseGlyphListOff);
  b.u16(3);
  b.u32(pComposite3 - baseGlyphListOff);
  // LayerList: 2 Offset32 entries → PaintSolid red / green
  b.u32(2);
  b.u32(pLayerSolid0 - layerListOff);
  b.u32(pLayerSolid1 - layerListOff);
  // PaintGlyph: format=10, Offset24 → PaintTransform, u16 glyphId=2
  b.u8(10);
  off24(b, pXform1 - pGlyph1);
  b.u16(2);
  // PaintTransform: format=12, Offset24 paintOffset, Offset24 transformOffset (both from the paint's start).
  b.u8(12);
  off24(b, pLayers1 - pXform1);
  off24(b, pAffine1 - pXform1);
  // PaintColrLayers: format=1, numLayers=2, firstLayerIndex=0
  b.u8(1);
  b.u8(2);
  b.u32(0);
  // LayerList[0] / [1]: PaintSolid red α=1.0, PaintSolid green α=0.5
  b.u8(2);
  b.u16(0);
  b.s16(16384);
  b.u8(2);
  b.u16(1);
  b.s16(8192);
  // PaintColrGlyph: format=11, glyphId=1
  b.u8(11);
  b.u16(1);
  // PaintComposite: format=32, Offset24 src, u8 mode=7, Offset24 dst
  b.u8(32);
  off24(b, pRot3 - pComposite3);
  b.u8(7);
  off24(b, pSolid3Dst - pComposite3);
  // PaintRotate: format=24, Offset24, F2DOT14 angle (45° → 45/180=0.25
  // → 0.25 * 16384 = 4096)
  b.u8(24);
  off24(b, pSolid3Src - pRot3);
  b.s16(4096);
  // Composite's src branch terminator (red) and dst (green)
  b.u8(2);
  b.u16(0);
  b.s16(16384);
  b.u8(2);
  b.u16(1);
  b.s16(16384);
  // Affine2x3 of the PaintTransform: Fixed[6] = xx, yx, xy, yy, dx, dy. Scale 0.5x, translate +100/+50.
  b.u32(0.5 * 65536);
  b.u32(0);
  b.u32(0);
  b.u32(0.5 * 65536);
  b.u32(100 * 65536);
  b.u32(50 * 65536);
  return b.toUint8();
}

// COLR v1 fixture exercising the three gradient paint formats with
// shared ColorLines. Each gradient reuses the same 2-stop color line
// (red at 0.0 → green at 1.0) so the gradient-parsing assertions can
// reuse one verification path.
//
//   gid 1 → PaintLinearGradient  p0=(0,0), p1=(100,0), p2=(0,100), extend=PAD
//   gid 2 → PaintRadialGradient  c0=(50,50), r0=0, c1=(50,50), r1=50, extend=REPEAT
//   gid 3 → PaintSweepGradient   center=(50,50), startAngle=0, endAngle=180, extend=REFLECT
//
// Field sizes:
//   PaintLinearGradient : 16 bytes (1 + 3 + 6*sint16)
//   PaintRadialGradient : 16 bytes (1 + 3 + sint16*4 + uint16*2)
//   PaintSweepGradient  : 12 bytes (1 + 3 + sint16*2 + sint16*2)
//   ColorLine header    : 3 bytes  (u8 extend + u16 numStops)
//   ColorStop           : 6 bytes  (sint16 stopOffset + u16 palIdx + sint16 alpha)
function buildColrV1Grad() {
  const headerLen = 34;
  const baseGlyphListOff = headerLen;
  const baseGlyphListLen = 4 + 3 * 6;
  // No LayerList needed (no PaintColrLayers in this fixture).
  let cursor = baseGlyphListOff + baseGlyphListLen;
  function paint(size) {
    const off = cursor;
    cursor += size;
    return off;
  }
  const pLin = paint(16);
  const pRad = paint(16);
  const pSwp = paint(12);
  // Each gradient gets its own ColorLine. They could share, but
  // keeping them separate lets the fixture stay easy to read.
  const colorLineSize = 3 + 2 * 6;
  const clLin = paint(colorLineSize);
  const clRad = paint(colorLineSize);
  const clSwp = paint(colorLineSize);

  function off24(b, delta) {
    b.u8((delta >> 16) & 0xff);
    b.u8((delta >> 8) & 0xff);
    b.u8(delta & 0xff);
  }
  function colorLine(b, extend) {
    b.u8(extend);
    b.u16(2);
    b.s16(0);
    b.u16(0);
    b.s16(16384); // stop 0: red,   α=1.0
    b.s16(16384);
    b.u16(1);
    b.s16(16384); // stop 1: green, α=1.0
  }

  const b = new Be();
  // Header
  b.u16(1);
  b.u16(0);
  b.u32(0);
  b.u32(0);
  b.u16(0);
  b.u32(baseGlyphListOff);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  // BaseGlyphList
  b.u32(3);
  b.u16(1);
  b.u32(pLin - baseGlyphListOff);
  b.u16(2);
  b.u32(pRad - baseGlyphListOff);
  b.u16(3);
  b.u32(pSwp - baseGlyphListOff);
  // PaintLinearGradient (gid 1): format=4
  b.u8(4);
  off24(b, clLin - pLin);
  b.s16(0);
  b.s16(0);
  b.s16(100);
  b.s16(0);
  b.s16(0);
  b.s16(100);
  // PaintRadialGradient (gid 2): format=6
  b.u8(6);
  off24(b, clRad - pRad);
  b.s16(50);
  b.s16(50);
  b.u16(0);
  b.s16(50);
  b.s16(50);
  b.u16(50);
  // PaintSweepGradient (gid 3): format=8
  // Sweep angles are F2DOT14 with a bias of 1.0 (angle = (raw/16384 + 1)·180°):
  // startAngle = 0° → raw −16384; endAngle = 180° → raw 0.
  b.u8(8);
  off24(b, clSwp - pSwp);
  b.s16(50);
  b.s16(50);
  b.s16(-16384);
  b.s16(0);
  // Three ColorLines: PAD, REPEAT, REFLECT
  colorLine(b, 0);
  colorLine(b, 1);
  colorLine(b, 2);
  return b.toUint8();
}

/// Returns a Uint8Array containing the synthesized COLR-bearing sfnt.
/// Options:
///   codepoint: cmap entry that maps to the COLR base glyph (default 'A').
///   unitsPerEm: head.unitsPerEm.
///   fgLayer1: when true, layer 1's paletteIndex is 0xFFFF (the
///             foreground-sentinel); render-time uses the run color
///             instead of the palette's green. (v0 fixture only.)
///   colrV1:   when true, emits a COLR v1 table with a small paint
///             tree (PaintColrLayers → 2× PaintSolid) instead of the
///             v0 layered glyph records. CPAL palette is the same.
///   colrV1Rich: when true, emits a richer COLR v1 table exercising
///             PaintGlyph, PaintTransform, PaintColrGlyph, PaintRotate,
///             PaintComposite, in addition to PaintColrLayers + PaintSolid.
///             Mutually exclusive with colrV1.
///   colrV1Grad: when true, emits a COLR v1 table with all three gradient
///             primitives (Linear / Radial / Sweep) and one ColorLine per
///             gradient (extend modes PAD / REPEAT / REFLECT respectively).
///   colrV1GlyphGrad: 'h' | 'v' | 'sweep' -- gid 1 is one gradient clipped by the square gid 2, with
///             blue added to the palette (buildColrV1GlyphGrad); `fgStop` makes its end stop the
///             text's own color (palette 0xFFFF) at alpha 0.5.
///   complete: add OS/2 and name and fill maxp, so a browser's sanitizer accepts the font.
///   family:   the name table's family name (with `complete`).
export function buildColrTestFont({
  codepoint = 0x41,
  unitsPerEm = 1000,
  fgLayer1 = false,
  colrV1 = false,
  colrV1Rich = false,
  colrV1Grad = false,
  colrV1GlyphGrad = null,
  fgStop = false,
  complete = false,
  family = 'Mantle COLR Test',
} = {}) {
  const numGlyphs = 4;
  // hmtx — 4 entries each (advance, lsb). Base glyph gets a wide
  // advance so a string "A" produces a visible run width even with
  // empty geometry; layer glyphs use their bbox width.
  const advances = [500, 800, 400, 700];
  const lsbs = [0, 0, 50, 100];

  const { glyf, loca } = buildGlyfAndLoca();

  const records = [
    { tag: TAG('head'), bytes: buildHead(unitsPerEm) },
    { tag: TAG('hhea'), bytes: buildHhea(unitsPerEm, numGlyphs) },
    { tag: TAG('hmtx'), bytes: buildHmtx(advances, lsbs) },
    { tag: TAG('maxp'), bytes: buildMaxp(numGlyphs, complete) },
    { tag: TAG('cmap'), bytes: buildCmap(codepoint) },
    { tag: TAG('loca'), bytes: loca },
    { tag: TAG('glyf'), bytes: glyf },
    { tag: TAG('post'), bytes: buildPost() },
    {
      tag: TAG('COLR'),
      bytes: colrV1GlyphGrad
        ? buildColrV1GlyphGrad(colrV1GlyphGrad, fgStop)
        : colrV1Grad
          ? buildColrV1Grad()
          : colrV1Rich
            ? buildColrV1Rich()
            : colrV1
              ? buildColrV1()
              : buildColr({ fgLayer1 }),
    },
    { tag: TAG('CPAL'), bytes: buildCpal(!!colrV1GlyphGrad) },
  ];
  if (complete) {
    records.push({ tag: TAG('OS/2'), bytes: buildOs2(unitsPerEm) });
    records.push({ tag: TAG('name'), bytes: buildName(family) });
  }
  return tableDir(records);
}

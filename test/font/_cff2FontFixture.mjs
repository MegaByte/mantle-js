// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cff2FontFixture.mjs — minimal sfnt with a CFF2 outlines table.
// Synthesized inline (no binary-font vendoring) so the CFF2 smokes
// can exercise the CFF2 reader independently.
//
// Fixture options:
//   { variable: false } — single glyph 'A' as a fixed triangle (no
//     VarStore, no blend operator). Exercises the CFF2 header /
//     direct Top DICT / FDArray / FDSelect / Type 2 interp under
//     isCff2=true.
//   { variable: true } — adds a 1-axis wght VarStore + a single
//     blend operator on the triangle's top-x coordinate. At
//     wght=normalized 0 the x is +250 (default); at normalized 1
//     it's +500. Exercises CFF2 variation end-to-end.

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
  longDateTime() {
    this.u32(0);
    this.u32(0);
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

// ----- shared TTF tables ---------------------------------------------------

function buildHead(unitsPerEm) {
  const b = new Be();
  b.fixed(1, 0);
  b.fixed(1, 0);
  b.u32(0);
  b.u32(0x5f0f3cf5);
  b.u16(0);
  b.u16(unitsPerEm);
  b.longDateTime();
  b.longDateTime();
  b.s16(0);
  b.s16(-200);
  b.s16(unitsPerEm);
  b.s16(unitsPerEm);
  b.u16(0);
  b.u16(8);
  b.s16(2);
  b.s16(0);
  b.s16(0);
  return b.toUint8();
}
function buildHhea(unitsPerEm, n) {
  const b = new Be();
  b.fixed(1, 0);
  b.s16(unitsPerEm);
  b.s16(-200);
  b.s16(0);
  b.u16(unitsPerEm);
  b.s16(0);
  b.s16(0);
  b.s16(unitsPerEm);
  b.s16(1);
  b.s16(0);
  b.s16(0);
  b.s16(0);
  b.s16(0);
  b.s16(0);
  b.s16(0);
  b.s16(0);
  b.u16(n);
  return b.toUint8();
}
function buildHmtx(adv, lsb) {
  const b = new Be();
  for (let i = 0; i < adv.length; i++) {
    b.u16(adv[i]);
    b.s16(lsb[i] || 0);
  }
  return b.toUint8();
}
function buildMaxp(n) {
  const b = new Be();
  b.fixed(0, 0x5000); // version 0.5 for CFF/OTF
  b.u16(n);
  return b.toUint8();
}
function buildCmap(codepoint) {
  const sub = new Be();
  const length = 16 + 8 * 2;
  sub.u16(4);
  sub.u16(length);
  sub.u16(0);
  sub.u16(4);
  sub.u16(4);
  sub.u16(1);
  sub.u16(0);
  sub.u16(codepoint);
  sub.u16(0xffff);
  sub.u16(0);
  sub.u16(codepoint);
  sub.u16(0xffff);
  sub.s16((1 - codepoint) & 0xffff);
  sub.s16(1);
  sub.u16(0);
  sub.u16(0);
  const b = new Be();
  b.u16(0);
  b.u16(1);
  b.u16(3);
  b.u16(1);
  b.u32(12);
  b.raw(Array.from(sub.toUint8()));
  return b.toUint8();
}
function buildPost() {
  const b = new Be();
  b.fixed(3, 0);
  b.u32(0);
  b.s16(-100);
  b.s16(50);
  b.u32(1);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  b.u32(0);
  return b.toUint8();
}

// ----- CFF helpers ---------------------------------------------------------

// Encode a non-negative integer as a CFF DICT operand. We only use
// values in the i16 range; using the 28 escape form (3-byte signed
// short) for everything to keep things simple.
function cffOperandU(b, v) {
  // 28 hi lo (signed 16)
  b.u8(28);
  b.s16(v);
}

// Build a CFF INDEX (count + offSize + offset table + data).
function buildIndex(items, useU32Count = false) {
  // For CFF2, Global Subr INDEX uses a uint32 count; CharStrings,
  // FDArray, etc. also use uint32 count per spec. (Actually CFF2
  // INDEX header is the same: count(u32) + offSize(u8) — only main
  // INDEXes change. Wait — per CFF2 spec §3.1, count IS u32.)
  // CFF1 uses uint16 count. Our useU32Count flag picks.
  const b = new Be();
  if (useU32Count) b.u32(items.length);
  else b.u16(items.length);
  if (items.length === 0) return b.toUint8();
  // Total data length.
  let total = 0;
  for (const it of items) total += it.length;
  // Pick smallest offSize.
  let offSize = 1;
  while (true) {
    const maxOff = total + 1;
    if (offSize === 1 && maxOff <= 0xff) break;
    if (offSize === 2 && maxOff <= 0xffff) break;
    if (offSize === 3 && maxOff <= 0xffffff) break;
    offSize++;
    if (offSize >= 4) break;
  }
  b.u8(offSize);
  // Offset table: offset to each item + sentinel (1-based, offset to
  // byte AFTER last item).
  let cursor = 1;
  for (let i = 0; i <= items.length; i++) {
    writeOff(b, cursor, offSize);
    if (i < items.length) cursor += items[i].length;
  }
  // Data.
  for (const it of items) b.raw(Array.from(it));
  return b.toUint8();
}
function writeOff(b, v, size) {
  if (size === 1) b.u8(v);
  else if (size === 2) b.u16(v);
  else if (size === 3) {
    b.u8((v >>> 16) & 0xff);
    b.u16(v & 0xffff);
  } else b.u32(v);
}

// ----- CFF2 fixture builder -----------------------------------------------

export function buildCff2TestFont({ codepoint = 0x41, unitsPerEm = 1000, variable = false } = {}) {
  // Triangle glyph charstring. CFF2 Type 2 — no width prefix, no
  // endchar (implicit). Coords are CFF accumulated deltas relative
  // to glyph origin.
  //
  // Default outline (no blend): triangle with vertices
  //   start (200, 0) → top (250, 700) → right (300, 0) → close
  // CFF Type 2 charstring: rmoveto 200 0 ; rlineto 50 700  ; rlineto 50 -700
  // (closing edge is implicit at end-of-charstring.)
  //
  // With blend (variable=true): the top-vertex x is blended.
  // Default 50; at region peak (wght normalized = 1) it's +250.
  // So at wght=1 the top moves from x=250 to x=500.

  const charstring = new Be();
  // rmoveto 200 0
  cffOperandU(charstring, 200);
  cffOperandU(charstring, 0);
  charstring.u8(0x15); // rmoveto
  if (variable) {
    // Need to push the rlineto pair (dx, dy) but with dx as a blended value.
    // CFF2 blend layout:
    //   v1 v2 ... vN  dv1_r1 ... dv1_rK dv2_r1 ... dv2_rK ... N blend
    // We want to blend ONE value (the dx = 50 default + delta 250 at peak).
    // So push: 50 (default dx), then 250 (delta), then 1 (N), then blend.
    cffOperandU(charstring, 50); // default dx
    cffOperandU(charstring, 250); // delta for region 0
    cffOperandU(charstring, 1); // N (number of values being blended)
    charstring.u8(0x10); // blend (opcode 16)
    // After blend, ONE value remains on stack (the blended dx).
    // Push dy = 700 to complete the rlineto pair.
    cffOperandU(charstring, 700);
    charstring.u8(0x05); // rlineto
    // Now the second edge. We need to return to the right vertex.
    // Without blend, that's rlineto 50 -700. With blend we need to
    // counter-balance: the right vertex is at (300, 0), top at
    // (250 + delta×scalar, 700). So the edge top→right has
    // dx = 50 - delta×scalar, dy = -700.
    // To keep things simple, encode 50 - blend(0, -250) = 50 - delta×scalar.
    // Equivalently: blend(50, -250) — default 50, delta -250 at region 0.
    cffOperandU(charstring, 50);
    cffOperandU(charstring, -250);
    cffOperandU(charstring, 1);
    charstring.u8(0x10); // blend
    cffOperandU(charstring, -700);
    charstring.u8(0x05); // rlineto
  } else {
    // rlineto 50 700
    cffOperandU(charstring, 50);
    cffOperandU(charstring, 700);
    charstring.u8(0x05);
    // rlineto 50 -700
    cffOperandU(charstring, 50);
    cffOperandU(charstring, -700);
    charstring.u8(0x05);
  }
  // (Implicit close at end-of-charstring; CFF2 has no endchar.)

  // gid 0 (.notdef) — empty charstring.
  const notdef = new Uint8Array(0);
  const charStrings = buildIndex([notdef, charstring.toUint8()], true);

  // Private DICT — minimal, just BlueValues empty (default subrs etc).
  // CFF2 Private DICT only needs to exist; many fields default sanely.
  // We'll emit an empty Private DICT (zero bytes is legal).
  const privateDict = new Uint8Array(0);

  // Font DICT (single FD inside FDArray). Just key 18 (Private size + offset).
  // The offset is filled later (after we know where Private DICT lives).
  // Encode operands as int16 (28 prefix) for portability.
  // Operand: privateSize. Operand: privateOffset. Operator: 18.

  // VarStore (only when variable).
  //
  // CFF2 VarStore is preceded by a uint16 length prefix (spec §3.2).
  // ItemVariationStore proper:
  //   format(u16) = 1
  //   variationRegionListOffset(u32)
  //   itemVariationDataCount(u16) = 1
  //   itemVariationDataOffsets(u32 × ivdCount)
  // VariationRegionList:
  //   axisCount(u16) = 1
  //   regionCount(u16) = 1
  //   regions[regionCount * axisCount] (6 bytes per axis): startCoord(s16), peakCoord(s16), endCoord(s16) in F2DOT14
  // ItemVariationData (we don't actually USE its delta data — blend
  // operands carry the deltas inline. But the IVS needs to declare
  // the region count so regionScalarFor() returns a meaningful value.):
  //   itemCount(u16) = 0
  //   shortDeltaCount(u16) = 0
  //   regionIndexCount(u16) = 1
  //   regionIndexes[regionIndexCount] (u16) = [0]
  //   no delta data (itemCount=0)
  let varStore = new Uint8Array(0);
  if (variable) {
    const ivs = new Be();
    // ItemVariationStore body (we'll compute offsets relative to here)
    const ivsStart = ivs.length;
    ivs.u16(1); // format
    const regionListOffPos = ivs.length;
    ivs.u32(0); // regionListOffset (patched)
    ivs.u16(1); // ivdCount
    const ivdOffPos = ivs.length;
    ivs.u32(0); // ivd[0] offset (patched)
    // Region list at end of header
    const regionListStart = ivs.length;
    ivs.u16(1); // axisCount
    ivs.u16(1); // regionCount
    // Region 0 axis 0: start=0 peak=16384 (1.0) end=16384
    ivs.s16(0);
    ivs.s16(16384);
    ivs.s16(16384);
    // ItemVariationData[0]
    const ivd0Start = ivs.length;
    ivs.u16(0); // itemCount
    ivs.u16(0); // shortDeltaCount
    ivs.u16(1); // regionIndexCount
    ivs.u16(0); // regionIndexes[0] = 0
    // No delta rows (itemCount=0).
    // Patch offsets (relative to IVS start).
    const ivsBytes = ivs.toUint8();
    const dv = new DataView(ivsBytes.buffer, ivsBytes.byteOffset, ivsBytes.byteLength);
    dv.setUint32(regionListOffPos - ivsStart, regionListStart - ivsStart, false);
    dv.setUint32(ivdOffPos - ivsStart, ivd0Start - ivsStart, false);
    // Prepend the u16 length prefix.
    const prefixed = new Be();
    prefixed.u16(ivsBytes.length);
    prefixed.raw(Array.from(ivsBytes));
    varStore = prefixed.toUint8();
  }

  // We'll lay out the CFF2 table sections in this order:
  //   header (5 bytes)
  //   Top DICT (direct; topDictSize bytes)
  //   Global Subr INDEX (count=0)
  //   VarStore (when variable)
  //   FDArray INDEX (count=1, containing the Font DICT)
  //   FDSelect (format 3 with one range covering all glyphs)
  //   CharStrings INDEX
  //   Private DICT (zero bytes)
  //
  // Offsets in the Top DICT are byte positions RELATIVE TO THE CFF2
  // TABLE START. So we compute them after laying out.

  // First, compute the Top DICT bytes. Top DICT references:
  //   CharStrings offset (key 17)
  //   FDArray offset (key 12 36)
  //   FDSelect offset (key 12 37)
  //   vstore offset (key 24, variable only)
  // We don't know these offsets yet — but the Top DICT itself is direct
  // (no INDEX wrapping), so we need a stable size. We'll write the Top
  // DICT bytes once with placeholders, then patch in the offsets.

  function emitTopDict(ops) {
    const t = new Be();
    for (const op of ops) {
      for (const v of op.operands) cffOperandU(t, v);
      if (op.op >= 256) {
        t.u8(12);
        t.u8(op.op - 12 * 256);
      } else t.u8(op.op);
    }
    return t.toUint8();
  }

  // Build placeholder Top DICT (all offsets = 0 for now). We'll
  // recompute once we know the actual offsets, then verify the
  // emitted byte length matches.
  function buildTopDict(charStringsOff, fdArrayOff, fdSelectOff, vstoreOff) {
    const ops = [
      { op: 17, operands: [charStringsOff] }, // CharStrings
      { op: 12 * 256 + 36, operands: [fdArrayOff] }, // FDArray
      { op: 12 * 256 + 37, operands: [fdSelectOff] }, // FDSelect
    ];
    if (variable) ops.push({ op: 24, operands: [vstoreOff] });
    return emitTopDict(ops);
  }

  // Pass 1: build with offsets=0 to lock in topDictSize, then compute real offsets.
  const placeholderTopDict = buildTopDict(0, 0, 0, 0);
  const topDictSize = placeholderTopDict.length;
  const hdrSize = 5;
  // Global Subr INDEX: count=0 (just a u32 zero count).
  const gsubrIndex = (() => {
    const b = new Be();
    b.u32(0);
    return b.toUint8();
  })();

  // Lay out positions.
  let cursor = hdrSize + topDictSize + gsubrIndex.length;
  const vstoreOff = variable ? cursor : 0;
  if (variable) cursor += varStore.length;

  // Build FontDict bytes (after we know where Private will live).
  // We'll compute Private's offset after FDArray + FDSelect lengths
  // are known. So first do another pass.

  // FDSelect format 3: 1 range covering all glyphs (gid 0 + 1).
  // numGlyphs = 2.
  const fdSelect = (() => {
    const b = new Be();
    b.u8(3); // format
    b.u16(1); // nRanges
    b.u16(0); // first gid
    b.u8(0); // fd index
    b.u16(2); // sentinel (numGlyphs)
    return b.toUint8();
  })();

  // Build Font DICT bytes (key 18: Private size + offset).
  // Need Private's final offset.
  // Cursor BEFORE FDArray: at `vstoreOff + varStore.length` (or
  // hdrSize+topDictSize+gsubr if no varStore).
  // We need to know FDArray length first. The Font DICT references
  // privateOff/Size; Private DICT is laid out AFTER CharStrings (we'll
  // place it last). So privateOff = cursor + fdArray.length +
  //   fdSelect.length + charStrings.length.

  function buildFontDict(privateLen, privateOff) {
    const ops = [{ op: 18, operands: [privateLen, privateOff] }];
    return emitTopDict(ops);
  }

  // Pre-compute FDArray length with placeholder Font DICT.
  const placeholderFD = buildFontDict(0, 0);
  const fdArrayPlaceholder = buildIndex([placeholderFD], true);

  // Final layout: fdArrayOff = cursor; fdSelectOff = fdArrayOff + fdArray.length
  const fdArrayOff = cursor;
  cursor += fdArrayPlaceholder.length;
  const fdSelectOff = cursor;
  cursor += fdSelect.length;
  const charStringsOff = cursor;
  cursor += charStrings.length;
  const privateOff = cursor;
  // Private DICT length is 0 (empty); cursor not updated further.

  // Now rebuild Font DICT with real Private offset, then re-emit FDArray.
  const fontDict = buildFontDict(privateDict.length, privateOff);
  const fdArray = buildIndex([fontDict], true);
  // CRITICAL: fdArray length might differ from placeholder if Font
  // DICT bytes encode differently. Our cffOperandU uses fixed 3-byte
  // i16 form, so lengths are stable. Assert just in case.
  if (fdArray.length !== fdArrayPlaceholder.length) {
    throw new Error(
      `CFF2 fixture: FDArray length mismatch (placeholder=${fdArrayPlaceholder.length}, final=${fdArray.length}); offsets would be off by ${fdArray.length - fdArrayPlaceholder.length}.`,
    );
  }

  // Build the real Top DICT with all offsets resolved.
  const realTopDict = buildTopDict(charStringsOff, fdArrayOff, fdSelectOff, vstoreOff);
  if (realTopDict.length !== topDictSize) {
    throw new Error(
      `CFF2 fixture: Top DICT length mismatch (placeholder=${topDictSize}, final=${realTopDict.length}).`,
    );
  }

  // Header.
  const header = new Be();
  header.u8(2); // major
  header.u8(0); // minor
  header.u8(hdrSize); // hdrSize
  header.u16(topDictSize); // topDictSize

  // Concatenate everything.
  const out = new Be();
  out.raw(Array.from(header.toUint8()));
  out.raw(Array.from(realTopDict));
  out.raw(Array.from(gsubrIndex));
  if (variable) out.raw(Array.from(varStore));
  out.raw(Array.from(fdArray));
  out.raw(Array.from(fdSelect));
  out.raw(Array.from(charStrings));
  out.raw(Array.from(privateDict));
  return { cffBytes: out.toUint8(), numGlyphs: 2 };
}

// ----- sfnt assembly ------------------------------------------------------

function tableDir(records, sfntVersion = 0x4f54544f /* 'OTTO' for CFF */) {
  const n = records.length;
  const dirSize = 12 + 16 * n;
  let cursor = dirSize;
  const offsets = [];
  for (const r of records) {
    offsets.push(cursor);
    cursor += r.bytes.length;
    while (cursor & 3) cursor++;
  }
  const total = cursor;
  const sorted = records.slice().sort((a, b) => a.tag - b.tag);
  const tagToOffset = new Map();
  for (let i = 0; i < records.length; i++) tagToOffset.set(records[i].tag, offsets[i]);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, sfntVersion, false);
  dv.setUint16(4, n, false);
  let pow = 1,
    log = 0;
  while (pow << 1 <= n) {
    pow <<= 1;
    log++;
  }
  dv.setUint16(6, pow * 16, false);
  dv.setUint16(8, log, false);
  dv.setUint16(10, n * 16 - pow * 16, false);
  let dirCursor = 12;
  for (const r of sorted) {
    dv.setUint32(dirCursor + 0, r.tag, false);
    dv.setUint32(dirCursor + 4, 0, false);
    dv.setUint32(dirCursor + 8, tagToOffset.get(r.tag), false);
    dv.setUint32(dirCursor + 12, r.bytes.length, false);
    dirCursor += 16;
  }
  for (let i = 0; i < records.length; i++) out.set(records[i].bytes, offsets[i]);
  return out;
}

/// Returns a Uint8Array containing the synthesized CFF2-bearing sfnt.
/// gid 1 renders a triangle (default) or a triangle whose top-vertex
/// x morphs with the (synthetic) wght axis when opts.variable=true.
export function buildCff2TestSfnt(opts = {}) {
  const { cffBytes, numGlyphs } = buildCff2TestFont(opts);
  const unitsPerEm = opts.unitsPerEm || 1000;
  const advances = [unitsPerEm, unitsPerEm];
  const lsbs = [0, 0];
  const codepoint = opts.codepoint || 0x41;
  const records = [
    { tag: TAG('head'), bytes: buildHead(unitsPerEm) },
    { tag: TAG('hhea'), bytes: buildHhea(unitsPerEm, numGlyphs) },
    { tag: TAG('hmtx'), bytes: buildHmtx(advances, lsbs) },
    { tag: TAG('maxp'), bytes: buildMaxp(numGlyphs) },
    { tag: TAG('cmap'), bytes: buildCmap(codepoint) },
    { tag: TAG('post'), bytes: buildPost() },
    { tag: opts.variable ? TAG('CFF2') : TAG('CFF2'), bytes: cffBytes },
  ];
  return tableDir(records);
}

// Independent synthetic CFF2 fonts: inherited Private1 and explicit CharString0.
export function buildPrivateVsindexFixtures() {
  return [
    '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',
  ].map((value) => new Uint8Array(Buffer.from(value, 'base64')));
}

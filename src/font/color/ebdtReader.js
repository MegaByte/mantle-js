// ebdtReader.js — monochrome / grayscale embedded-bitmap reader
// (EBLC location table + EBDT data table).
//
// EBLC/EBDT are the grayscale ancestors
// of CBLC/CBDT (which add color PNG image formats 17–19). The location
// hierarchy (BitmapSize records → IndexSubTables) is identical to
// CBLC; only the image data differs: EBDT stores 1/2/4/8-bit packed
// coverage bitmaps, not PNGs.
//
// Coverage of this reader:
//   EBLC version 2.0 (0x00020000)
//   IndexSubTable formats 1 (u32 offsets), 2 (constant metrics),
//     3 (u16 offsets), 4 (sparse u16 offsets), 5 (sparse constant)
//   EBDT image formats 1 (small metrics, byte-aligned),
//     2 (small metrics, bit-aligned), 5 (metrics from EBLC, bit-aligned),
//     6 (big metrics, byte-aligned), 7 (big metrics, bit-aligned),
//     8/9 (composite — components OR-composited from the same strike)
//   bitDepth 1 / 2 / 4 / 8 (mono → grayscale coverage)
//
// Output: a glyph carries an 8-bit `alphaBitmap` (width*height, one
// coverage byte per pixel, 0=transparent 255=opaque), suitable for
// tinting by the run's fill color. This differs from the CBDT path,
// which returns ready-to-decode PNG bytes.
//
// Refs:
//   https://learn.microsoft.com/en-us/typography/opentype/spec/eblc
//   https://learn.microsoft.com/en-us/typography/opentype/spec/ebdt

/// One decoded embedded bitmap glyph.
///   alphaBitmap: Uint8Array(width*height), 8-bit coverage
///   width/height: pixels
///   bearingX/bearingY: pixels at the strike ppem (s8); advance: pixels (u8)
export class EbdtGlyph {
  constructor(alphaBitmap, metrics, bitDepth, strikePpem) {
    this.alphaBitmap = alphaBitmap;
    this.height   = metrics.height;
    this.width    = metrics.width;
    this.bearingX = metrics.bearingX;
    this.bearingY = metrics.bearingY;
    this.advance  = metrics.advance;
    this.bitDepth = bitDepth;
    this.strikePpem = strikePpem;
  }
}

export class EbdtReader {
  constructor(tables) {
    this._view = tables.view;
    this._bytes = tables.bytes;
    this._eblcOff = -1;
    this._ebdtOff = -1;
    this._numSizes = 0;
    this._sizes = null;  // parsed lazily

    if (!tables.eblc || !tables.ebdt) return;
    this._eblcOff = tables.eblc[0];
    this._ebdtOff = tables.ebdt[0];
    const v = this._view;
    const version = v.getUint32(this._eblcOff + 0, false);
    if (version !== 0x00020000 && version !== 0x00030000) return; // EBLC 2.0 (3.0 tolerated)
    this._numSizes = v.getUint32(this._eblcOff + 4, false);
  }

  get hasBitmaps() { return this._numSizes > 0; }
  get numStrikes() { return this._numSizes; }

  /// Picks the strike whose ppem is closest to targetPpem without being
  /// smaller; falls back to the largest available (same policy as CBDT).
  pickStrikeForPpem(targetPpem) {
    this._ensureSizes();
    if (!this._sizes || this._sizes.length === 0) return -1;
    let bestUp = -1, bestUpPpem = Infinity;
    let largest = 0, largestPpem = 0;
    for (let i = 0; i < this._sizes.length; i++) {
      const p = this._sizes[i].ppemX;
      if (p >= targetPpem && p < bestUpPpem) { bestUp = i; bestUpPpem = p; }
      if (p > largestPpem) { largest = i; largestPpem = p; }
    }
    return bestUp >= 0 ? bestUp : largest;
  }

  /// EbdtGlyph or null when this gid has no bitmap in the strike (or the
  /// format isn't one we decode).
  getBitmapGlyph(gid, strikeIdx) {
    this._ensureSizes();
    if (!this._sizes || strikeIdx < 0 || strikeIdx >= this._sizes.length) return null;
    const size = this._sizes[strikeIdx];
    for (const sub of size.subTables) {
      if (gid < sub.firstGid || gid > sub.lastGid) continue;
      const loc = this._locateGlyph(sub, gid);
      if (!loc) return null;                 // empty slot / not in sparse list
      return this._decodeGlyph(sub, loc, size.ppemX, size.bitDepth, strikeIdx);
    }
    return null;
  }

  /// Resolve a gid to its [dataStart, dataLen, sharedMetrics?] within EBDT
  /// for this index subtable. Returns null for empty slots.
  _locateGlyph(sub, gid) {
    const v = this._view;
    const idx = gid - sub.firstGid;
    const dataBase = this._ebdtOff + sub.imageDataOffset;
    switch (sub.indexFormat) {
      case 1: {  // u32 offset array, [n+1] entries, relative to imageDataOffset
        const start = v.getUint32(sub.headerEnd + idx * 4, false);
        const end   = v.getUint32(sub.headerEnd + (idx + 1) * 4, false);
        if (end <= start) return null;
        return { dataStart: dataBase + start, dataLen: end - start, metrics: null };
      }
      case 3: {  // u16 offset array, [n+1] entries
        const start = v.getUint16(sub.headerEnd + idx * 2, false);
        const end   = v.getUint16(sub.headerEnd + (idx + 1) * 2, false);
        if (end <= start) return null;
        return { dataStart: dataBase + start, dataLen: end - start, metrics: null };
      }
      case 2: {  // constant-size glyphs: u32 imageSize + BigGlyphMetrics(8)
        const imageSize = v.getUint32(sub.headerEnd, false);
        const metrics = _readBigMetrics(v, sub.headerEnd + 4);
        return { dataStart: dataBase + idx * imageSize, dataLen: imageSize, metrics };
      }
      case 4: {  // sparse: u32 numGlyphs + GlyphIdOffsetPair[numGlyphs+1]
        const num = v.getUint32(sub.headerEnd, false);
        const arr = sub.headerEnd + 4;
        for (let i = 0; i < num; i++) {
          const g  = v.getUint16(arr + i * 4, false);
          if (g === gid) {
            const off  = v.getUint16(arr + i * 4 + 2, false);
            const next = v.getUint16(arr + (i + 1) * 4 + 2, false);
            if (next <= off) return null;
            return { dataStart: dataBase + off, dataLen: next - off, metrics: null };
          }
        }
        return null;
      }
      case 5: {  // sparse constant: u32 imageSize + BigGlyphMetrics + u32 numGlyphs + glyphIdArray
        const imageSize = v.getUint32(sub.headerEnd, false);
        const metrics = _readBigMetrics(v, sub.headerEnd + 4);
        const num = v.getUint32(sub.headerEnd + 12, false);
        const arr = sub.headerEnd + 16;
        for (let i = 0; i < num; i++) {
          if (v.getUint16(arr + i * 2, false) === gid)
            return { dataStart: dataBase + i * imageSize, dataLen: imageSize, metrics };
        }
        return null;
      }
      default:
        return null;
    }
  }

  _decodeGlyph(sub, loc, ppem, bitDepth, strikeIdx) {
    const v = this._view;
    let p = loc.dataStart;
    let metrics, bitAligned;
    switch (sub.imageFormat) {
      case 1: metrics = _readSmallMetrics(v, p); p += 5; bitAligned = false; break;
      case 2: metrics = _readSmallMetrics(v, p); p += 5; bitAligned = true;  break;
      case 6: metrics = _readBigMetrics(v, p);   p += 8; bitAligned = false; break;
      case 7: metrics = _readBigMetrics(v, p);   p += 8; bitAligned = true;  break;
      case 5: metrics = loc.metrics; bitAligned = true; break; // metrics from EBLC index header
      case 8:  // composite: small metrics(5) + pad(1) + components
        return this._decodeComposite(_readSmallMetrics(v, p), p + 6, ppem, bitDepth, strikeIdx);
      case 9:  // composite: big metrics(8) + components
        return this._decodeComposite(_readBigMetrics(v, p), p + 8, ppem, bitDepth, strikeIdx);
      default: return null;
    }
    if (!metrics) return null;
    const alpha = _decodeBits(v, p, metrics.width, metrics.height, bitDepth, bitAligned);
    return new EbdtGlyph(alpha, metrics, bitDepth, ppem);
  }

  /// Composite glyph (image format 8/9): OR each component glyph's strike
  /// bitmap into one buffer sized by the composite's own metrics, offset
  /// by the component's (xOffset, yOffset). Components are resolved within
  /// the SAME strike (recursively, so a component may itself be composite).
  _decodeComposite(metrics, compOff, ppem, bitDepth, strikeIdx) {
    const v = this._view;
    const numComponents = v.getUint16(compOff, false);
    const W = metrics.width, H = metrics.height;
    const out = new Uint8Array(W * H);
    let co = compOff + 2;
    for (let i = 0; i < numComponents; i++) {
      const compGid = v.getUint16(co, false);
      const dx = v.getInt8(co + 2);
      const dy = v.getInt8(co + 3);
      co += 4;
      const cg = this.getBitmapGlyph(compGid, strikeIdx);
      if (!cg || !cg.alphaBitmap) continue;
      // Blit cg at (dx, dy) from the composite's top-left. dy grows down.
      for (let y = 0; y < cg.height; y++) {
        const ty = y + dy;
        if (ty < 0 || ty >= H) continue;
        for (let x = 0; x < cg.width; x++) {
          const tx = x + dx;
          if (tx < 0 || tx >= W) continue;
          const src = cg.alphaBitmap[y * cg.width + x];
          if (src > out[ty * W + tx]) out[ty * W + tx] = src;  // max-composite (OR)
        }
      }
    }
    return new EbdtGlyph(out, metrics, bitDepth, ppem);
  }

  _ensureSizes() {
    if (this._sizes != null) return;
    if (this._numSizes === 0) { this._sizes = []; return; }
    const v = this._view;
    const out = [];
    for (let i = 0; i < this._numSizes; i++) {
      const rOff = this._eblcOff + 8 + i * 48;
      const subArrOff = v.getUint32(rOff + 0, false);
      const numSubs   = v.getUint32(rOff + 8, false);
      const startGid = v.getUint16(rOff + 40, false);
      const endGid   = v.getUint16(rOff + 42, false);
      const ppemX    = v.getUint8(rOff + 44);
      const ppemY    = v.getUint8(rOff + 45);
      const bitDepth = v.getUint8(rOff + 46);
      const subs = [];
      const subArrBase = this._eblcOff + subArrOff;
      for (let s = 0; s < numSubs; s++) {
        const eOff = subArrBase + s * 8;
        const firstGid = v.getUint16(eOff + 0, false);
        const lastGid  = v.getUint16(eOff + 2, false);
        const subOff   = v.getUint32(eOff + 4, false);  // relative to subArrBase
        const subBase = subArrBase + subOff;
        const indexFormat   = v.getUint16(subBase + 0, false);
        const imageFormat   = v.getUint16(subBase + 2, false);
        const imageDataOffset = v.getUint32(subBase + 4, false);  // relative to EBDT start
        subs.push({
          firstGid, lastGid, indexFormat, imageFormat, imageDataOffset,
          headerEnd: subBase + 8,
        });
      }
      out.push({ ppemX, ppemY, bitDepth, startGid, endGid, subTables: subs });
    }
    this._sizes = out;
  }
}

function _readSmallMetrics(v, o) {
  return {
    height:   v.getUint8(o + 0),
    width:    v.getUint8(o + 1),
    bearingX: v.getInt8(o + 2),
    bearingY: v.getInt8(o + 3),
    advance:  v.getUint8(o + 4),
  };
}

function _readBigMetrics(v, o) {
  // BigGlyphMetrics: height,width,horiBearingX,horiBearingY,horiAdvance,
  //   vertBearingX,vertBearingY,vertAdvance. We keep the horizontal set.
  return {
    height:   v.getUint8(o + 0),
    width:    v.getUint8(o + 1),
    bearingX: v.getInt8(o + 2),
    bearingY: v.getInt8(o + 3),
    advance:  v.getUint8(o + 4),
  };
}

/// Decode a packed coverage bitmap into an 8-bit alpha buffer.
/// bitDepth bits per pixel; `bitAligned` true = continuous bitstream,
/// false = each row padded to a byte boundary.
function _decodeBits(v, dataOff, width, height, bitDepth, bitAligned) {
  const out = new Uint8Array(width * height);
  if (width === 0 || height === 0) return out;
  const maxVal = (1 << bitDepth) - 1;
  const rowBits = bitAligned ? width * bitDepth : ((width * bitDepth + 7) & ~7);
  for (let y = 0; y < height; y++) {
    let bit = y * rowBits;
    for (let x = 0; x < width; x++) {
      let val = 0;
      for (let k = 0; k < bitDepth; k++) {
        const byteOff = dataOff + (bit >> 3);
        const b = (v.getUint8(byteOff) >> (7 - (bit & 7))) & 1;
        val = (val << 1) | b;
        bit++;
      }
      // Scale the bitDepth-bit value up to 0..255 coverage.
      out[y * width + x] = bitDepth === 8 ? val : Math.round((val * 255) / maxVal);
    }
  }
  return out;
}

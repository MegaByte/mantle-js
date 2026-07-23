// cbdtReader.js — Google CBDT/CBLC bitmap-glyph table reader.
//
// CBLC = location (index hierarchy). CBDT = data (PNG bytes).
// Reader scope: IndexSubTable format 1 (variable metrics, dense
// gid range) + image format 17 (small metrics + PNG), as used by
// Noto Color Emoji.
//
// Refs:
//   https://learn.microsoft.com/en-us/typography/opentype/spec/cblc
//   https://learn.microsoft.com/en-us/typography/opentype/spec/cbdt

/// One PNG-bearing bitmap glyph from CBDT.
/// metrics: SmallGlyphMetrics — height/width in pixels, bearingX/Y
/// in pixels at the strike ppem (s8), advance in pixels (u8).
export class CbdtGlyph {
  constructor(pngBytes, metrics, strikePpem) {
    this.pngBytes = pngBytes;
    this.height   = metrics.height;
    this.width    = metrics.width;
    this.bearingX = metrics.bearingX;
    this.bearingY = metrics.bearingY;
    this.advance  = metrics.advance;
    this.strikePpem = strikePpem;
  }
}

export class CbdtReader {
  constructor(tables) {
    this._view = tables.view;
    this._bytes = tables.bytes;
    this._cblcOff = -1;
    this._cbdtOff = -1;
    this._cblcVersion = -1;
    this._numSizes = 0;
    this._sizes = null;  // parsed lazily

    if (!tables.cblc || !tables.cbdt) return;
    this._cblcOff = tables.cblc[0];
    this._cbdtOff = tables.cbdt[0];
    const v = this._view;
    this._cblcVersion = v.getUint32(this._cblcOff + 0, false);
    if (this._cblcVersion !== 0x00030000) return;  // we support v3.0
    this._numSizes = v.getUint32(this._cblcOff + 4, false);
  }

  get hasBitmaps() { return this._numSizes > 0; }
  get numStrikes() { return this._numSizes; }

  /// Picks the strike whose ppem is closest to targetPpem without
  /// being smaller (same policy as sbixReader).
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

  /// Returns CbdtGlyph or null when this gid has no bitmap in this
  /// strike (or the format isn't one we support).
  getBitmapGlyph(gid, strikeIdx) {
    this._ensureSizes();
    if (!this._sizes || strikeIdx < 0 || strikeIdx >= this._sizes.length) return null;
    const size = this._sizes[strikeIdx];
    // Walk index-sub-tables; find the one whose [firstGid, lastGid]
    // range covers `gid`.
    for (const sub of size.subTables) {
      if (gid < sub.firstGid || gid > sub.lastGid) continue;
      if (sub.indexFormat !== 1) continue;            // we only do format 1
      if (sub.imageFormat !== 17) continue;           // we only do format 17 (small + PNG)
      return this._readFormat17(sub, gid, size.ppemX);
    }
    return null;
  }

  _readFormat17(sub, gid, ppem) {
    const v = this._view;
    // Format 1: u32 sbixOffsets[lastGid - firstGid + 2], relative to
    // sub.imageDataOffset (which is into CBDT).
    const idx = gid - sub.firstGid;
    const offTable = sub.headerEnd;                   // first byte after the 8-byte index subtable header
    const start = v.getUint32(offTable + idx * 4, false);
    const end   = v.getUint32(offTable + (idx + 1) * 4, false);
    if (end <= start) return null;                    // empty slot sentinel
    const dataStart = this._cbdtOff + sub.imageDataOffset + start;
    // Image format 17: SmallGlyphMetrics(5 bytes) + u32 dataLen + dataLen PNG bytes.
    const height   = v.getUint8(dataStart + 0);
    const width    = v.getUint8(dataStart + 1);
    const bearingX = v.getInt8(dataStart + 2);
    const bearingY = v.getInt8(dataStart + 3);
    const advance  = v.getUint8(dataStart + 4);
    const dataLen  = v.getUint32(dataStart + 5, false);
    const pngStart = dataStart + 9;
    const png = new Uint8Array(this._bytes.buffer, this._bytes.byteOffset + pngStart, dataLen);
    return new CbdtGlyph(png, { height, width, bearingX, bearingY, advance }, ppem);
  }

  _ensureSizes() {
    if (this._sizes != null) return;
    if (this._numSizes === 0) { this._sizes = []; return; }
    const v = this._view;
    const out = [];
    // BitmapSize records start right after the 8-byte CBLC header.
    // Each record is 48 bytes.
    for (let i = 0; i < this._numSizes; i++) {
      const rOff = this._cblcOff + 8 + i * 48;
      const subArrOff = v.getUint32(rOff + 0, false);
      // subArr size at rOff+4 (indexTablesSize), num at rOff+8.
      const numSubs   = v.getUint32(rOff + 8, false);
      // BitmapSize layout (last bytes):
      //   ...
      //   startGlyphIndex u16 (offset 40)
      //   endGlyphIndex   u16 (offset 42)
      //   ppemX           u8  (offset 44)
      //   ppemY           u8  (offset 45)
      //   bitDepth        u8  (offset 46)
      //   flags           u8  (offset 47)
      const startGid = v.getUint16(rOff + 40, false);
      const endGid   = v.getUint16(rOff + 42, false);
      const ppemX    = v.getUint8(rOff + 44);
      const ppemY    = v.getUint8(rOff + 45);
      const bitDepth = v.getUint8(rOff + 46);

      // Walk the IndexSubTableArray: 8 bytes each
      //   firstGlyphIndex u16, lastGlyphIndex u16, additionalOffsetToIndexSubTable u32
      const subs = [];
      const subArrBase = this._cblcOff + subArrOff;
      for (let s = 0; s < numSubs; s++) {
        const eOff = subArrBase + s * 8;
        const firstGid = v.getUint16(eOff + 0, false);
        const lastGid  = v.getUint16(eOff + 2, false);
        const subOff   = v.getUint32(eOff + 4, false);  // relative to subArrBase
        const subBase = subArrBase + subOff;
        const indexFormat   = v.getUint16(subBase + 0, false);
        const imageFormat   = v.getUint16(subBase + 2, false);
        const imageDataOffset = v.getUint32(subBase + 4, false);
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

// sbixReader.js — Apple bitmap-glyph table (sbix) reader.
//
// Apple Color Emoji uses sbix to ship PNG glyphs at multiple sizes
// ("strikes"). Each strike has its own ppem (pixels-per-em);
// rendering at any size picks the closest-larger strike then
// downscales. We expose the raw PNG bytes + glyph origin offset;
// callers decode the PNG.
//
// References:
//   https://learn.microsoft.com/en-us/typography/opentype/spec/sbix

const TAG_png  = 0x706E6720; // 'png '
const TAG_jpg  = 0x6A706720; // 'jpg '
const TAG_jpeg = 0x6A706567; // 'jpeg' (some vendors)
const TAG_pdf  = 0x70646620; // 'pdf '

/// One bitmap glyph as it appears in a strike.
/// pngBytes: raw image bytes (sliced view into the font buffer).
/// graphicType: u32 tag ('png ', 'jpg ', etc.). Today we only render
///              PNG; jpg/pdf glyphs are surfaced but callers should
///              skip them.
export class SbixGlyph {
  constructor(graphicType, originX, originY, pngBytes, strikePpem) {
    this.graphicType = graphicType;
    this.originX = originX;     // font units offset (s16)
    this.originY = originY;
    this.pngBytes = pngBytes;
    this.strikePpem = strikePpem;
  }
  get isPng()  { return this.graphicType === TAG_png; }
  get isJpeg() { return this.graphicType === TAG_jpg || this.graphicType === TAG_jpeg; }
}

export class SbixReader {
  /** @param {object} tables result of parseTtfTables */
  constructor(tables) {
    this._view = tables.view;
    this._bytes = tables.bytes;
    this._tableOff = -1;
    this._version = -1;
    this._numStrikes = 0;
    this._strikeOffsets = null;  // absolute offsets
    this._strikes = null;        // parsed lazily: [{ ppem, ppi, glyphOffs: u32[numGlyphs+1], base: int }]
    this._numGlyphs = tables.numGlyphs | 0;

    if (!tables.sbix) return;
    const off = tables.sbix[0];
    const v = this._view;
    this._tableOff = off;
    this._version = v.getUint16(off + 0, false);
    if (this._version !== 1) return;          // only v1 in the wild
    const flags = v.getUint16(off + 2, false);  // ignored; bit-0 = "draw outlines too" hint
    this._numStrikes = v.getUint32(off + 4, false);
    this._strikeOffsets = new Array(this._numStrikes);
    for (let i = 0; i < this._numStrikes; i++) {
      this._strikeOffsets[i] = off + v.getUint32(off + 8 + i * 4, false);
    }
  }

  get hasBitmaps()  { return this._numStrikes > 0; }
  get numStrikes()  { return this._numStrikes; }
  /// Picks the strike whose ppem is the closest to targetPpem
  /// without being SMALLER (so we downscale rather than upscale).
  /// If every strike is smaller than the target, returns the largest.
  /// Returns -1 when there are no strikes.
  pickStrikeForPpem(targetPpem) {
    if (this._numStrikes === 0) return -1;
    this._ensureAllStrikes();
    let bestUpFromTarget = -1, bestUpPpem = Infinity;
    let largest = 0, largestPpem = 0;
    for (let i = 0; i < this._strikes.length; i++) {
      const s = this._strikes[i];
      if (s.ppem >= targetPpem && s.ppem < bestUpPpem) {
        bestUpPpem = s.ppem; bestUpFromTarget = i;
      }
      if (s.ppem > largestPpem) { largestPpem = s.ppem; largest = i; }
    }
    return bestUpFromTarget >= 0 ? bestUpFromTarget : largest;
  }

  /// Returns SbixGlyph or null when this gid has no bitmap in the
  /// requested strike (sentinel: zero-length glyph slot).
  getBitmapGlyph(gid, strikeIdx) {
    if (strikeIdx < 0 || strikeIdx >= this._numStrikes) return null;
    this._ensureStrike(strikeIdx);
    const strike = this._strikes[strikeIdx];
    if (gid < 0 || gid >= strike.glyphOffs.length - 1) return null;
    const start = strike.base + strike.glyphOffs[gid];
    const end   = strike.base + strike.glyphOffs[gid + 1];
    const len = end - start;
    if (len <= 8) return null;                  // empty / header-only

    const v = this._view;
    const originX = v.getInt16(start + 0, false);
    const originY = v.getInt16(start + 2, false);
    const graphicType = v.getUint32(start + 4, false);
    // Remaining bytes are the image. Slice into a Uint8Array view.
    const imgStart = start + 8;
    const imgLen   = end - imgStart;
    const png = new Uint8Array(this._bytes.buffer, this._bytes.byteOffset + imgStart, imgLen);
    return new SbixGlyph(graphicType, originX, originY, png, strike.ppem);
  }

  _ensureAllStrikes() {
    if (this._strikes != null) return;
    this._strikes = new Array(this._numStrikes);
    for (let i = 0; i < this._numStrikes; i++) this._ensureStrike(i);
  }

  _ensureStrike(idx) {
    if (this._strikes == null) this._strikes = new Array(this._numStrikes);
    if (this._strikes[idx] != null) return;
    const base = this._strikeOffsets[idx];
    const v = this._view;
    const ppem = v.getUint16(base + 0, false);
    const ppi  = v.getUint16(base + 2, false);
    // glyphOffsets: numGlyphs+1 entries; size from font's maxp.
    const n = this._numGlyphs;
    const offs = new Uint32Array(n + 1);
    for (let g = 0; g <= n; g++) {
      offs[g] = v.getUint32(base + 4 + g * 4, false);
    }
    this._strikes[idx] = { ppem, ppi, glyphOffs: offs, base };
  }
}

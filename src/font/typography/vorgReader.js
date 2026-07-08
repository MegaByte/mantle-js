// vorgReader.js — VORG (Vertical Origin) table.
//
// Provides per-glyph Y-origin offsets for vertical writing-mode
// layout. Most fonts use the same default for every glyph; some
// (CJK, Mongolian) override per-glyph for specific characters.
//
// VORG header:
//   u16 majorVersion = 1
//   u16 minorVersion = 0
//   s16 defaultVertOriginY
//   u16 numVertOriginYMetrics
//   VertOriginYMetric[numVertOriginYMetrics]:
//     u16 glyphIndex (sorted)
//     s16 vertOriginY
//
// Reference:
//   https://learn.microsoft.com/en-us/typography/opentype/spec/vorg

export class VorgReader {
  constructor(tables) {
    this._view = tables.view;
    if (!tables.vorg) {
      this._tableOff = -1;
      this._defaultY = 0;
      this._count = 0;
      return;
    }
    const off = tables.vorg[0];
    const v = this._view;
    this._tableOff = off;
    // Skip version (4 bytes)
    this._defaultY = v.getInt16(off + 4, false);
    this._count = v.getUint16(off + 6, false);
    this._metricsBase = off + 8;
  }

  get hasTable() { return this._tableOff >= 0; }

  /// Default vertical-origin Y (font units). Returned for glyphs that
  /// don't have a per-glyph override.
  get defaultVertOriginY() { return this._defaultY; }

  /// Returns the vertical-origin Y for `gid` (font units). Falls
  /// back to defaultVertOriginY when no per-glyph entry exists.
  /// Binary searches the sorted metrics array.
  getVertOriginY(gid) {
    if (this._tableOff < 0) return 0;
    if (this._count === 0) return this._defaultY;
    const v = this._view;
    const base = this._metricsBase;
    let lo = 0, hi = this._count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const recOff = base + mid * 4;
      const recGid = v.getUint16(recOff, false);
      if (recGid < gid) lo = mid + 1;
      else if (recGid > gid) hi = mid - 1;
      else return v.getInt16(recOff + 2, false);
    }
    return this._defaultY;
  }
}

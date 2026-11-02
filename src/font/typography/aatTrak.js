// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aatTrak.js -- Apple Advanced Typography 'trak' (tracking).
//
// A font's size-dependent letter-spacing: per track (normal is track 0) a list of font-unit values at ascending point sizes,
// read between sizes by linear interpolation and clamped at the ends. Apple-only; nothing in OpenType defines it.
//
// Ref: https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6trak.html

export class AatTrak {
  constructor(tables) {
    this._view = tables.view;
    this._off = tables.trak ? tables.trak[0] : -1;
    this._cache = new Map();
  }

  get hasTrak() {
    return this._off >= 0;
  }

  /// Horizontal tracking in font units for the normal track at `ptem` points (0 when the font has none).
  getHorizontalTracking(ptem) {
    if (this._off < 0 || !(ptem > 0)) return 0;
    if (this._cache.has(ptem)) return this._cache.get(ptem);
    const v = this._view,
      base = this._off;
    let result = 0;
    const horiz = v.getUint16(base + 6, false);
    if (horiz) {
      const td = base + horiz;
      const nTracks = v.getUint16(td, false),
        nSizes = v.getUint16(td + 2, false);
      const sizeTable = base + v.getUint32(td + 4, false);
      for (let i = 0; i < nTracks && nSizes > 0; i++) {
        const rec = td + 8 + i * 8;
        if (v.getInt32(rec, false) !== 0) continue; // Fixed 0.0 is the normal track
        const values = base + v.getUint16(rec + 6, false);
        const size = (k) => v.getInt32(sizeTable + k * 4, false) / 65536;
        const val = (k) => v.getInt16(values + k * 2, false);
        let k = 0;
        while (k < nSizes && size(k) < ptem) k++;
        if (k === 0) result = val(0);
        else if (k === nSizes) result = val(nSizes - 1);
        else {
          const s0 = size(k - 1),
            s1 = size(k);
          const t = s0 === s1 ? 0 : (ptem - s0) / (s1 - s0);
          result = t * val(k) + (1 - t) * val(k - 1);
        }
        break;
      }
    }
    this._cache.set(ptem, result);
    return result;
  }
}

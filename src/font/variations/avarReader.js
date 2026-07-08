// avarReader.js — OpenType 'avar' table reader (Axis Variations).
//
// Remaps normalized axis values via piecewise-linear segments, letting
// variation behave non-linearly in axis space (e.g. perceptual weight).
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/avar

export class AvarTable {
  constructor(tables) {
    this._present = false;
    this._maps = null;
    if (!tables.avar) return;
    const v = tables.view;
    const off = tables.avar[0];
    const major = v.getUint16(off + 0, false);
    if (major !== 1) return;
    // reserved (2 bytes), then axisCount (2 bytes).
    const axisCount = v.getUint16(off + 6, false);
    this._axisCount = axisCount;
    this._maps = new Array(axisCount);
    let p = off + 8;
    for (let a = 0; a < axisCount; a++) {
      const positionMapCount = v.getUint16(p, false);
      p += 2;
      const entries = new Array(positionMapCount);
      for (let i = 0; i < positionMapCount; i++) {
        const from = v.getInt16(p, false) / 16384;
        const to   = v.getInt16(p + 2, false) / 16384;
        entries[i] = [from, to];
        p += 4;
      }
      this._maps[a] = entries;
    }
    this._present = true;
  }

  get hasAvar() { return this._present; }

  /// Remap one normalized axis coord (`c` in [-1, +1]) via piecewise-
  /// linear segments. Returns `c` unchanged when avar is absent or the
  /// map is the identity.
  remapAxis(axisIdx, c) {
    if (!this._present || axisIdx >= this._maps.length) return c;
    const seg = this._maps[axisIdx];
    if (seg.length < 2) return c;
    // Clamp to first/last from-coord.
    if (c <= seg[0][0]) return seg[0][1];
    if (c >= seg[seg.length - 1][0]) return seg[seg.length - 1][1];
    // Linear walk; maps are short (typically 3-7 entries).
    for (let i = 1; i < seg.length; i++) {
      const [aFrom, aTo] = seg[i - 1];
      const [bFrom, bTo] = seg[i];
      if (c >= aFrom && c <= bFrom) {
        if (bFrom === aFrom) return aTo;
        const t = (c - aFrom) / (bFrom - aFrom);
        return aTo + t * (bTo - aTo);
      }
    }
    return c;
  }

  /// Remap an entire normalized coord vector in place. Returns the
  /// vector for chaining (or a new array if `inOut` was null).
  remapCoords(inOut) {
    if (!this._present || inOut == null) return inOut;
    for (let a = 0; a < Math.min(inOut.length, this._maps.length); a++) {
      inOut[a] = this.remapAxis(a, inOut[a]);
    }
    return inOut;
  }
}

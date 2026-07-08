// itemVariationStore.js — OpenType ItemVariationStore reader.
//
// Shared between HVAR / MVAR / VVAR / GDEF / CFF2 — each of these
// tables embeds an IVS and uses (outerIdx, innerIdx) tuples to look
// up font-unit deltas at a given normalized variation coord vector.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/otvarcommonformats
//
// The class takes a `tables`-shaped accessor ({ bytes, view }) and an
// absolute byte offset to the ItemVariationStore subtable, so callers
// don't need to know how their parent table referenced it.

export class ItemVariationStore {
  constructor(tables, off) {
    const v = tables.view;
    // const format = v.getUint16(off + 0, false);  // must be 1
    const regionListOff = off + v.getUint32(off + 2, false);
    const ivdCount     = v.getUint16(off + 6, false);
    this._tables = tables;
    this._off = off;
    const axisCount   = v.getUint16(regionListOff + 0, false);
    const regionCount = v.getUint16(regionListOff + 2, false);
    this._axisCount = axisCount;
    this._regions = new Array(regionCount);
    for (let i = 0; i < regionCount; i++) {
      const r = regionListOff + 4 + i * axisCount * 6;
      const region = new Array(axisCount);
      for (let a = 0; a < axisCount; a++) {
        const ra = r + a * 6;
        region[a] = {
          start: v.getInt16(ra + 0, false) / 16384,
          peak:  v.getInt16(ra + 2, false) / 16384,
          end:   v.getInt16(ra + 4, false) / 16384,
        };
      }
      this._regions[i] = region;
    }
    this._ivds = new Array(ivdCount);
    for (let i = 0; i < ivdCount; i++) {
      const ivdOff = off + v.getUint32(off + 8 + i * 4, false);
      this._ivds[i] = this._parseIvd(ivdOff);
    }
  }

  get axisCount() { return this._axisCount; }
  /// Region count — number of distinct axis-space regions across all
  /// IVD subtables. CFF2 blend uses this implicitly via vsindex.
  get regionCount() { return this._regions.length; }
  /// Number of regions referenced by ItemVariationData subtable `outer`.
  /// CFF2 blend uses this to size its operand pop.
  regionIndexCount(outerIdx) {
    if (outerIdx < 0 || outerIdx >= this._ivds.length) return 0;
    return this._ivds[outerIdx].regionIndices.length;
  }

  _parseIvd(off) {
    const v = this._tables.view;
    const itemCount       = v.getUint16(off + 0, false);
    const shortDeltaCount = v.getUint16(off + 2, false);
    const regionIndexCount = v.getUint16(off + 4, false);
    const regionIndices = new Array(regionIndexCount);
    for (let r = 0; r < regionIndexCount; r++)
      regionIndices[r] = v.getUint16(off + 6 + r * 2, false);
    const rowSize = shortDeltaCount * 2 + (regionIndexCount - shortDeltaCount);
    const dataStart = off + 6 + regionIndexCount * 2;
    return { itemCount, shortDeltaCount, regionIndices, rowSize, dataStart };
  }

  /// Per-region scalar at coords (start, peak, end). Spec §
  /// otvarcommonformats: peak=0 → axis irrelevant; coord ≤ start or
  /// ≥ end → 0; tent function otherwise.
  regionScalar(region, coords) {
    let s = 1;
    for (let a = 0; a < region.length; a++) {
      const c = coords[a];
      const ra = region[a];
      if (ra.peak === 0) continue;
      if (ra.start > ra.peak || ra.peak > ra.end) continue;
      if (ra.start < 0 && ra.end > 0 && ra.peak !== 0) continue;
      if (c === ra.peak) continue;
      if (c <= ra.start || c >= ra.end) return 0;
      if (c < ra.peak) s *= (c - ra.start) / (ra.peak - ra.start);
      else             s *= (ra.end - c)   / (ra.end - ra.peak);
    }
    return s;
  }

  /// Compute the scalar weight applied to region `regionIdxInIvd`
  /// (0..regionIndexCount(outerIdx)-1) of subtable `outerIdx` at the
  /// supplied normalized coords. Used by CFF2 blend.
  regionScalarFor(outerIdx, regionIdxInIvd, coords) {
    if (outerIdx >= this._ivds.length) return 0;
    const ivd = this._ivds[outerIdx];
    if (regionIdxInIvd >= ivd.regionIndices.length) return 0;
    return this.regionScalar(this._regions[ivd.regionIndices[regionIdxInIvd]], coords);
  }

  /// HVAR / MVAR-style delta lookup. Returns 0 when outer/inner are
  /// out of range (graceful per spec).
  getDelta(outerIdx, innerIdx, coords) {
    if (outerIdx >= this._ivds.length) return 0;
    const ivd = this._ivds[outerIdx];
    if (innerIdx >= ivd.itemCount) return 0;
    const v = this._tables.view;
    const bytes = this._tables.bytes;
    const rowOff = ivd.dataStart + innerIdx * ivd.rowSize;
    let acc = 0;
    let cursor = rowOff;
    for (let r = 0; r < ivd.regionIndices.length; r++) {
      let delta;
      if (r < ivd.shortDeltaCount) {
        delta = v.getInt16(cursor, false);
        cursor += 2;
      } else {
        let b = bytes[cursor++];
        if (b >= 0x80) b -= 0x100;
        delta = b;
      }
      const region = this._regions[ivd.regionIndices[r]];
      const scalar = this.regionScalar(region, coords);
      if (scalar !== 0) acc += scalar * delta;
    }
    return acc;
  }
}

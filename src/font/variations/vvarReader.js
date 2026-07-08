// vvarReader.js — OpenType 'VVAR' (Vertical Metrics Variations).
// Structurally identical to HVAR but for vertical advance / TSB / BSB
// instead of horizontal advance / LSB / RSB.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/vvar

import { ItemVariationStore } from '../itemVariationStore.js';
import { DeltaSetIndexMap } from '../deltaSetIndexMap.js';

export class VvarTable {
  constructor(tables) {
    this._present = false;
    if (!tables.vvar) return;
    const v = tables.view;
    const off = tables.vvar[0];
    const major = v.getUint16(off + 0, false);
    if (major !== 1) return;
    // VVAR header:
    //   u16 majorVersion = 1
    //   u16 minorVersion
    //   u32 itemVariationStoreOffset
    //   u32 advanceHeightMappingOffset
    //   u32 tsbMappingOffset
    //   u32 bsbMappingOffset
    //   u32 vorgMappingOffset
    const ivsOff       = v.getUint32(off +  4, false);
    const advMapOff    = v.getUint32(off +  8, false);
    const tsbMapOff    = v.getUint32(off + 12, false);
    // bsbMapOff and vorgMapOff at off+16 and +20; unused.
    this._tables = tables;
    this._tableOff = off;
    this._ivs = new ItemVariationStore(tables, off + ivsOff);
    this._advMap = advMapOff > 0
      ? new DeltaSetIndexMap(tables, off + advMapOff)
      : null;
    this._tsbMap = tsbMapOff > 0
      ? new DeltaSetIndexMap(tables, off + tsbMapOff)
      : null;
    this._present = true;
  }

  get hasVvar() { return this._present; }

  /// Advance-height delta (font units) for `gid` at `nCoords`.
  advanceDelta(gid, nCoords) {
    if (!this._present) return 0;
    let outerIdx, innerIdx;
    if (this._advMap != null) {
      const map = this._advMap.lookup(gid);
      outerIdx = map.outer;
      innerIdx = map.inner;
    } else {
      outerIdx = 0;
      innerIdx = gid;
    }
    return this._ivs.getDelta(outerIdx, innerIdx, nCoords);
  }

  /// Top-side-bearing delta. Mostly absent in real fonts; returns 0.
  tsbDelta(gid, nCoords) {
    if (!this._present || this._tsbMap == null) return 0;
    const map = this._tsbMap.lookup(gid);
    return this._ivs.getDelta(map.outer, map.inner, nCoords);
  }
}

// DeltaSetIndexMap lives in deltaSetIndexMap.js (shared with HVAR / COLR).

// deltaSetIndexMap.js — OpenType DeltaSetIndexMap reader.
//
// Used by HVAR / VVAR / MVAR / COLR (and any other table that maps a
// linear index space into (outerIdx, innerIdx) tuples for IVS lookup).
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/otvarcommonformats#delta-set-index-mapping
//
// Format 0: u8 format=0, u8 entryFormat, u16 mapCount, ...entries
// Format 1: u8 format=1, u8 entryFormat, u32 mapCount, ...entries
// entryFormat: bits 0..3 = innerBitCount - 1
//              bits 4..5 = entrySize  - 1 (in bytes)
//              bits 6..7 = reserved

export class DeltaSetIndexMap {
  constructor(tables, off) {
    const v = tables.view;
    const bytes = tables.bytes;
    const format = bytes[off];
    const entryFormat = bytes[off + 1];
    let mapCount, dataOff;
    if (format === 0) {
      mapCount = v.getUint16(off + 2, false);
      dataOff = off + 4;
    } else {
      mapCount = v.getUint32(off + 2, false);
      dataOff = off + 6;
    }
    this._innerBits = (entryFormat & 0x0F);
    this._entrySize = ((entryFormat >> 4) & 0x03) + 1;
    this._innerMask = (1 << (this._innerBits + 1)) - 1;
    this._mapCount  = mapCount;
    this._dataOff   = dataOff;
    this._bytes     = bytes;
  }

  lookup(idx) {
    if (idx >= this._mapCount) idx = this._mapCount - 1;
    if (idx < 0) idx = 0;
    let cursor = this._dataOff + idx * this._entrySize;
    let raw = 0;
    for (let i = 0; i < this._entrySize; i++) {
      raw = (raw << 8) | this._bytes[cursor + i];
    }
    const inner = raw & this._innerMask;
    const outer = raw >> (this._innerBits + 1);
    return { outer, inner };
  }
}

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hvarReader.js — OpenType 'HVAR' table reader (Horizontal Metrics
// Variations). Returns the per-glyph advance-width delta at a given
// normalized variation coordinate vector. Without HVAR a variable
// font's heavy weights overflow their hmtx slot widths and glyphs
// overlap (gvar morphs the outline; HVAR morphs the metric).
//
// Format: a thin wrapper around an ItemVariationStore +
// optional per-attribute delta-set index maps.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/hvar
//       https://learn.microsoft.com/en-us/typography/opentype/spec/otvarcommonformats

import { ItemVariationStore } from '../itemVariationStore.js';
import { DeltaSetIndexMap } from '../deltaSetIndexMap.js';

export class HvarTable {
  constructor(tables) {
    this._present = false;
    if (!tables.hvar) return;
    const v = tables.view;
    const off = tables.hvar[0];
    const major = v.getUint16(off + 0, false);
    if (major !== 1) return;
    const ivsOff = v.getUint32(off + 4, false);
    const advMapOff = v.getUint32(off + 8, false);
    const lsbMapOff = v.getUint32(off + 12, false);
    // const rsbMapOff   = v.getUint32(off + 16, false);  // unused
    this._tables = tables;
    this._tableOff = off;
    this._ivs = new ItemVariationStore(tables, off + ivsOff);
    this._advMap = advMapOff > 0 ? new DeltaSetIndexMap(tables, off + advMapOff) : null;
    this._lsbMap = lsbMapOff > 0 ? new DeltaSetIndexMap(tables, off + lsbMapOff) : null;
    this._present = true;
  }

  get hasHvar() {
    return this._present;
  }

  /// Advance-width delta (in font units) for `gid` at normalized
  /// coords `nCoords`. Returns 0 when HVAR doesn't have data for
  /// this gid.
  advanceDelta(gid, nCoords) {
    if (!this._present) return 0;
    let outerIdx, innerIdx;
    if (this._advMap != null) {
      const map = this._advMap.lookup(gid);
      outerIdx = map.outer;
      innerIdx = map.inner;
    } else {
      // No map: outer=0, inner=gid (default per spec).
      outerIdx = 0;
      innerIdx = gid;
    }
    return this._ivs.getDelta(outerIdx, innerIdx, nCoords);
  }

  /// Left-side-bearing delta. Variable fonts often skip this and
  /// HVAR's LSB map will be absent; returns 0 in that case.
  lsbDelta(gid, nCoords) {
    if (!this._present || this._lsbMap == null) return 0;
    const map = this._lsbMap.lookup(gid);
    return this._ivs.getDelta(map.outer, map.inner, nCoords);
  }
}

// DeltaSetIndexMap lives in
// deltaSetIndexMap.js (shared with VVAR / COLR).

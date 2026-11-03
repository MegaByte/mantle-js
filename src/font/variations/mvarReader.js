// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// mvarReader.js — font-wide MVAR deltas from an ItemVariationStore.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/mvar

import { ItemVariationStore } from '../itemVariationStore.js';

export class MvarTable {
  constructor(tables) {
    this._present = false;
    this._records = null;
    if (!tables.mvar) return;
    const v = tables.view;
    const off = tables.mvar[0];
    const major = v.getUint16(off + 0, false);
    if (major !== 1) return;
    // Header: minorVersion (+2), reserved (+4), valueRecordSize (+6),
    // valueRecordCount (+8), itemVariationStoreOffset (+10).
    const recSize = v.getUint16(off + 6, false);
    const recCount = v.getUint16(off + 8, false);
    const ivsOff = v.getUint16(off + 10, false);
    if (recSize < 8) {
      // Compatible record extensions retain the leading tag and indices.
      return;
    }
    // Records start immediately after the header (12 bytes).
    const recBase = off + 12;
    const recs = new Map();
    for (let i = 0; i < recCount; i++) {
      const r = recBase + i * recSize;
      const tag = v.getUint32(r + 0, false);
      const outer = v.getUint16(r + 4, false);
      const inner = v.getUint16(r + 6, false);
      recs.set(tag, { outer, inner });
    }
    this._records = recs;
    // Lazy-build IVS — only when a caller asks for a delta.
    this._tables = tables;
    this._ivsOff = off + ivsOff;
    this._ivs = null;
    this._present = true;
  }

  get hasMvar() {
    return this._present;
  }

  /// Font-unit delta for `tag` (4-char ASCII; e.g. "hasc") at
  /// normalized coords. Returns 0 when MVAR isn't present or the
  /// tag isn't covered.
  delta(tag, nCoords) {
    if (!this._present) return 0;
    const tagInt =
      (tag.charCodeAt(0) << 24) |
      (tag.charCodeAt(1) << 16) |
      (tag.charCodeAt(2) << 8) |
      tag.charCodeAt(3);
    return this.deltaInt(tagInt, nCoords);
  }

  deltaInt(tagInt, nCoords) {
    if (!this._present) return 0;
    const rec = this._records.get(tagInt);
    if (!rec) return 0;
    if (this._ivs == null) {
      this._ivs = new ItemVariationStore(this._tables, this._ivsOff);
    }
    return this._ivs.getDelta(rec.outer, rec.inner, nCoords);
  }
}

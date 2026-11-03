// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// featReader.js — AAT 'feat' (feature-name) table reader.
//
// Enumerates the typographic features a font exposes (ligatures, swashes,
// letter case, number style, …) and their selectors, mapping each to a
// 'name'-table string id. METADATA for a feature-picker UI — it does NOT
// change default shaping (morx gates default-on subtables via the chain's
// default flags, independent of feat).
//
// Ref: https://learn.microsoft.com/en-us/typography/opentype/spec/feat

export class FeatReader {
  constructor(tables) {
    this._view = tables.view;
    this._off = -1;
    this._features = null; // lazily parsed [{feature, exclusive, settings:[{value,nameIndex}], nameIndex}]
    if (!tables.feat) return;
    const v = tables.view,
      off = tables.feat[0];
    if (v.getUint32(off, false) !== 0x00010000) return;
    this._off = off;
  }

  get hasFeat() {
    return this._off >= 0;
  }

  /// Parsed feature records: each { feature (id), exclusive (bool),
  /// nameIndex (name-table id), settings: [{ value, nameIndex }] }.
  get features() {
    this._ensure();
    return this._features;
  }

  _ensure() {
    if (this._features != null) return;
    this._features = [];
    if (this._off < 0) return;
    const v = this._view,
      off = this._off;
    const count = v.getUint16(off + 4, false);
    for (let i = 0; i < count; i++) {
      const r = off + 12 + i * 12;
      const feature = v.getUint16(r, false);
      const nSettings = v.getUint16(r + 2, false);
      const settingTableOff = off + v.getUint32(r + 4, false); // offset from feat start
      const featureFlags = v.getUint16(r + 8, false);
      const nameIndex = v.getInt16(r + 10, false);
      const exclusive = (featureFlags & 0x8000) !== 0;
      const settings = [];
      for (let s = 0; s < nSettings; s++) {
        const so = settingTableOff + s * 4;
        settings.push({ value: v.getUint16(so, false), nameIndex: v.getInt16(so + 2, false) });
      }
      this._features.push({ feature, exclusive, nameIndex, settings });
    }
  }
}

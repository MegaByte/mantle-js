// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// baseReader.js — OpenType 'BASE' (Baseline) table.
//
// Provides per-script baseline alignment data — which baseline a
// script uses by default (alphabetic / ideographic-center /
// ideographic-low / hanging / mathematical / etc.) and offset
// adjustments per baseline tag. Used when mixing scripts on the
// same line (Latin baseline-alphabetic vs CJK baseline-ideographic-
// low needs alignment).
//
// Most fonts ship only the Horizontal axis; vertical is needed for
// vertical writing-mode.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/base

/** Common baseline tags (4-char ASCII). */
export const BaselineTag = Object.freeze({
  Romn: 0x726f6d6e, // alphabetic (Latin)
  Ideo: 0x6964656f, // ideographic-low
  Idce: 0x69646365, // ideographic-center
  Idtp: 0x69647470, // ideographic-top
  Hang: 0x68616e67, // hanging
  Math: 0x6d617468, // mathematical
});

export class BaseReader {
  constructor(tables) {
    this._view = tables.view;
    this._tableOff = -1;
    this._horizAxisOff = -1;
    this._vertAxisOff = -1;
    if (!tables.base) return;
    const off = tables.base[0];
    const v = this._view;
    this._tableOff = off;
    // u16 majorVersion, u16 minorVersion, u16 horizAxisOff, u16 vertAxisOff
    const horizRel = v.getUint16(off + 4, false);
    const vertRel = v.getUint16(off + 6, false);
    this._horizAxisOff = horizRel ? off + horizRel : -1;
    this._vertAxisOff = vertRel ? off + vertRel : -1;
  }

  get hasTable() {
    return this._tableOff >= 0;
  }
  get hasHorizontalAxis() {
    return this._horizAxisOff >= 0;
  }
  get hasVerticalAxis() {
    return this._vertAxisOff >= 0;
  }

  /// Returns the list of baseline tags (4-char ASCII numbers) the
  /// horizontal axis supports, in declaration order. Index N is the
  /// baseline that BaseScriptRecord's defaultBaselineIndex refers to.
  getHorizontalBaselineTags() {
    if (this._horizAxisOff < 0) return [];
    return this._readBaseTagList(this._horizAxisOff);
  }

  getVerticalBaselineTags() {
    if (this._vertAxisOff < 0) return [];
    return this._readBaseTagList(this._vertAxisOff);
  }

  _readBaseTagList(axisOff) {
    const v = this._view;
    // Axis: u16 baseTagListOff, u16 baseScriptListOff
    const tagListRel = v.getUint16(axisOff, false);
    if (tagListRel === 0) return [];
    const tagListOff = axisOff + tagListRel;
    const count = v.getUint16(tagListOff, false);
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
      out[i] = v.getUint32(tagListOff + 2 + i * 4, false);
    }
    return out;
  }

  /// Look up the default baseline tag for a script in the horizontal
  /// axis. Returns the baseline tag (32-bit ASCII) or 0 when not
  /// present. `scriptTag` is the 32-bit script tag (e.g. 0x6c61746e
  /// 'latn' for Latin, 0x6b616e61 'kana' for Japanese kana, etc).
  getDefaultHorizontalBaseline(scriptTag) {
    return this._lookupDefaultBaseline(this._horizAxisOff, scriptTag);
  }

  getDefaultVerticalBaseline(scriptTag) {
    return this._lookupDefaultBaseline(this._vertAxisOff, scriptTag);
  }

  _lookupDefaultBaseline(axisOff, scriptTag) {
    if (axisOff < 0) return 0;
    const v = this._view;
    const tags = this._readBaseTagList(axisOff);
    if (tags.length === 0) return 0;
    const scriptListRel = v.getUint16(axisOff + 2, false);
    if (scriptListRel === 0) return 0;
    const scriptListOff = axisOff + scriptListRel;
    const scriptCount = v.getUint16(scriptListOff, false);
    // BaseScriptRecord: uint32 baseScriptTag, u16 baseScriptOffset
    const recBase = scriptListOff + 2;
    for (let i = 0; i < scriptCount; i++) {
      const tag = v.getUint32(recBase + i * 6, false);
      if (tag !== scriptTag) continue;
      const scriptOffRel = v.getUint16(recBase + i * 6 + 4, false);
      if (scriptOffRel === 0) return 0;
      const scriptOff = scriptListOff + scriptOffRel;
      // BaseScript: u16 baseValuesOff, u16 defaultMinMaxOff, u16 baseLangSysCount, ...
      const baseValuesRel = v.getUint16(scriptOff, false);
      if (baseValuesRel === 0) return 0;
      const baseValuesOff = scriptOff + baseValuesRel;
      // BaseValues: u16 defaultBaselineIndex, u16 baseCoordCount, ...
      const defaultIdx = v.getUint16(baseValuesOff, false);
      if (defaultIdx >= tags.length) return 0;
      return tags[defaultIdx];
    }
    return 0;
  }
}

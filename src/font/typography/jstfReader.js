// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// jstfReader.js — OpenType 'JSTF' (Justification) table reader.
//
// Tells a justification engine how to lengthen or shorten a line to a target width, per script and language system:
//
//   * the ExtenderGlyph list: the "kashida" / tatweel connectors a justifier inserts at cursive joins;
//   * the JstfLangSys priorities, in the order a client tries them. Each priority stands alone and carries, for shrinkage and
//     for extension, GSUB and GPOS lookups to enable and to disable (JstfModList: LookupList indices) and a JstfMax: GPOS-type
//     lookups that live inside the JSTF table and give the most a glyph may move, from zero up to that value.
//
// The reader hands the lists out; the layout applies them (see textLayout.js, justification) by re-shaping the line with the
// GSUB and GPOS readers' setJustification().
//
// Ref: https://learn.microsoft.com/en-us/typography/opentype/spec/jstf

/// The priorities a line tries, and the lookup-list entries one language system may list across them.
export const MAX_JSTF_PRIORITIES = 64;
const MAX_JSTF_LIST_ENTRIES = 1 << 16;

export class JstfReader {
  constructor(tables) {
    this._view = tables.view;
    this._off = -1;
    this._len = 0;
    this._scripts = null; // Map<tag, {extenderGlyphs, defLangSys, langSys: Map<tag, offset>, scriptOff}>
    this._priorityCache = new Map();

    if (!tables.jstf) return;
    const off = tables.jstf[0];
    const v = tables.view;
    const version = v.getUint32(off, false);
    if (version !== 0x00010000) return; // only JSTF 1.0 exists
    this._off = off;
    this._len = tables.jstf[1];
  }

  get hasJstf() {
    return this._scripts !== null ? this._scripts.size > 0 : this._off >= 0;
  }

  /// The byte range [lo, hi) of the table: a lookup inside it is a JstfMax lookup, not a GPOS one.
  get range() {
    return [this._off, this._off + this._len];
  }

  /// Extender (kashida) glyph ids for `scriptTag` (e.g. 'arab'), widest-
  /// last as stored. null when the font has no JSTF, no entry for the
  /// script, or the script lists no extenders. The justifier inserts
  /// these at cursive joins to fill slack.
  getExtenderGlyphs(scriptTag) {
    this._ensure();
    if (!this._scripts) return null;
    const s = this._scripts.get(scriptTag);
    return s && s.extenderGlyphs.length > 0 ? s.extenderGlyphs : null;
  }

  /// True when `scriptTag` declares numbered justification priorities in its default language system or any other.
  hasPriorities(scriptTag) {
    this._ensure();
    const s = this._scripts && this._scripts.get(scriptTag);
    return !!(s && (s.defLangSys || s.langSys.size > 0));
  }

  /// True when any script declares a priority list; the layout only keeps source offsets for justification when this holds.
  get hasAnyPriorities() {
    this._ensure();
    if (!this._scripts) return false;
    for (const s of this._scripts.values()) if (s.defLangSys || s.langSys.size > 0) return true;
    return false;
  }

  /// The priority list of `scriptTag` for the OpenType language system `langTag` (a four-character string such as 'TRK ', or
  /// '' for none): that language system's own list when the script has one, else the script's default. Returns an array, in
  /// priority order, of
  ///   { shrink, extend }, each { gsubEnable, gsubDisable, gposEnable, gposDisable, max }
  /// where the first four are arrays of LookupList indices and `max` is an array of absolute offsets of the JstfMax lookups
  /// (GPOS lookup tables inside this table). null when the script has none.
  getPriorities(scriptTag, langTag = '') {
    this._ensure();
    const s = this._scripts && this._scripts.get(scriptTag);
    if (!s) return null;
    const key = scriptTag + '|' + langTag;
    if (this._priorityCache.has(key)) return this._priorityCache.get(key);
    const langOff = (langTag && s.langSys.get(langTag)) || s.defLangSys;
    const result = langOff ? this._readLangSys(langOff) : null;
    this._priorityCache.set(key, result);
    return result;
  }

  _readLangSys(off) {
    const v = this._view;
    // Each priority is trial layouts of a line, and priorities may share their lookup lists, so the count bounds both the work per
    // justified line and what is read here. Real fonts list a handful.
    const count = Math.min(v.getUint16(off, false), MAX_JSTF_PRIORITIES);
    const out = [];
    this._listBudget = MAX_JSTF_LIST_ENTRIES;
    for (let i = 0; i < count; i++) {
      const po = off + v.getUint16(off + 2 + i * 2, false);
      const part = (base) => ({
        gsubEnable: this._modList(po, v.getUint16(po + base, false)),
        gsubDisable: this._modList(po, v.getUint16(po + base + 2, false)),
        gposEnable: this._modList(po, v.getUint16(po + base + 4, false)),
        gposDisable: this._modList(po, v.getUint16(po + base + 6, false)),
        max: this._jstfMax(po, v.getUint16(po + base + 8, false)),
      });
      // JstfPriority: shrinkage (5 offsets) then extension (5 offsets).
      out.push({ shrink: part(0), extend: part(10) });
    }
    return out;
  }

  _spendList(n) {
    this._listBudget -= n;
    if (this._listBudget < 0)
      throw new RangeError('JSTF priorities list more lookups than a font can use');
    return n;
  }

  _modList(base, rel) {
    if (!rel) return [];
    const v = this._view,
      o = base + rel,
      n = this._spendList(v.getUint16(o, false)),
      list = [];
    for (let i = 0; i < n; i++) list.push(v.getUint16(o + 2 + i * 2, false));
    return list;
  }

  _jstfMax(base, rel) {
    if (!rel) return [];
    const v = this._view,
      o = base + rel,
      n = this._spendList(v.getUint16(o, false)),
      list = [];
    for (let i = 0; i < n; i++) list.push(o + v.getUint16(o + 2 + i * 2, false));
    return list;
  }

  _ensure() {
    if (this._scripts != null) return;
    this._scripts = new Map();
    if (this._off < 0) return;
    const v = this._view,
      off = this._off;
    const count = v.getUint16(off + 4, false);
    for (let i = 0; i < count; i++) {
      const r = off + 6 + i * 6;
      const tag = _tag(v, r);
      const scriptOff = off + v.getUint16(r + 4, false);
      // JstfScript: extenderGlyphOffset(u16), defJstfLangSysOffset(u16),
      //   jstfLangSysCount(u16), records…  (offsets from JstfScript start)
      const extOff = v.getUint16(scriptOff + 0, false);
      const defLangOff = v.getUint16(scriptOff + 2, false);
      const langCount = v.getUint16(scriptOff + 4, false);
      const extenderGlyphs = [];
      if (extOff) {
        const eo = scriptOff + extOff;
        const gc = v.getUint16(eo, false);
        for (let k = 0; k < gc; k++) extenderGlyphs.push(v.getUint16(eo + 2 + k * 2, false));
      }
      const langSys = new Map();
      for (let k = 0; k < langCount; k++) {
        const lr = scriptOff + 6 + k * 6;
        langSys.set(_tag(v, lr), scriptOff + v.getUint16(lr + 4, false));
      }
      this._scripts.set(tag, {
        extenderGlyphs,
        defLangSys: defLangOff ? scriptOff + defLangOff : 0,
        langSys,
      });
    }
  }
}

function _tag(v, o) {
  return String.fromCharCode(
    v.getUint8(o),
    v.getUint8(o + 1),
    v.getUint8(o + 2),
    v.getUint8(o + 3),
  );
}

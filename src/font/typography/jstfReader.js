// jstfReader.js — OpenType 'JSTF' (Justification) table reader.
//
// Tells a justification engine how to lengthen/shorten a line to a target
// width per script. The widely shipped content is the per-script
// ExtenderGlyphList: the "kashida" / tatweel connector glyphs an Arabic
// justifier inserts at cursive joins to elongate a line.
//
// Scope: the script list + per-script ExtenderGlyphList (consumed by the
// kashida justification path). The optional JstfLangSys → JstfPriority
// chain (enabling/disabling specific GSUB/GPOS lookups at numbered
// shrink/extend priority levels) is parsed only far enough to report
// whether priorities exist; the per-priority modifier lists are not
// decoded.
//
// Ref: https://learn.microsoft.com/en-us/typography/opentype/spec/jstf

export class JstfReader {
  constructor(tables) {
    this._view = tables.view;
    this._off = -1;
    this._scripts = null;   // Map<tag, {extenderGlyphs:number[], priorityCount:number}>

    if (!tables.jstf) return;
    const off = tables.jstf[0];
    const v = tables.view;
    const version = v.getUint32(off, false);
    if (version !== 0x00010000) return;   // only JSTF 1.0 exists
    this._off = off;
  }

  get hasJstf() { return this._scripts !== null ? this._scripts.size > 0 : this._off >= 0; }

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

  /// True when `scriptTag` declares numbered justification priorities
  /// (shrink/extend lookup steps). Reported for completeness; the steps
  /// themselves are not applied (see file header).
  hasPriorities(scriptTag) {
    this._ensure();
    const s = this._scripts && this._scripts.get(scriptTag);
    return !!(s && s.priorityCount > 0);
  }

  _ensure() {
    if (this._scripts != null) return;
    this._scripts = new Map();
    if (this._off < 0) return;
    const v = this._view, off = this._off;
    const count = v.getUint16(off + 4, false);
    for (let i = 0; i < count; i++) {
      const r = off + 6 + i * 6;
      const tag = _tag(v, r);
      const scriptOff = off + v.getUint16(r + 4, false);
      // JstfScript: extenderGlyphOffset(u16), defJstfLangSysOffset(u16),
      //   jstfLangSysCount(u16), records…  (offsets from JstfScript start)
      const extOff = v.getUint16(scriptOff + 0, false);
      const defLangOff = v.getUint16(scriptOff + 2, false);
      const extenderGlyphs = [];
      if (extOff) {
        const eo = scriptOff + extOff;
        const gc = v.getUint16(eo, false);
        for (let k = 0; k < gc; k++) extenderGlyphs.push(v.getUint16(eo + 2 + k * 2, false));
      }
      let priorityCount = 0;
      if (defLangOff) priorityCount = v.getUint16(scriptOff + defLangOff, false);
      this._scripts.set(tag, { extenderGlyphs, priorityCount });
    }
  }
}

function _tag(v, o) {
  return String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
}

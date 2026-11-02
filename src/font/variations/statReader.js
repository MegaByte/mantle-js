// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// statReader.js — OpenType 'STAT' (Style Attributes) table.
//
// Exposes per-axis design ranges + named value records used for
// font-variation-settings CSS pass-through, OS picker names, and
// style-attribute matching in font fallback chains.
//
// STAT header (v1.2 most common):
//   u16 majorVersion = 1
//   u16 minorVersion (0/1/2)
//   u16 designAxisSize (always 8)
//   u16 designAxisCount
//   u32 designAxesOffset → AxisRecord[]
//   u16 axisValueCount
//   u32 offsetToAxisValueOffsets → u16[axisValueCount] (offsets relative to STAT origin)
//   v1.1+: u16 elidedFallbackNameID
//
// AxisRecord (8 bytes):
//   uint32 axisTag (e.g. 'wght', 'wdth', 'ital', 'opsz', 'slnt')
//   u16 axisNameID (into 'name' table)
//   u16 axisOrdering
//
// AxisValue formats 1/2/3/4 — all four are parsed (axisValues): format 1 a single
// value, 2 a nominal value with a range, 3 a value linked to another, 4 a
// combination across axes. selectAxisValues() picks the tables that describe a
// location and styleName() composes the automatic instance name from them, per
// the specification's rules for format 4 dominance, ELIDABLE_AXIS_VALUE_NAME and
// elidedFallbackNameID (the oracle is fontTools.varLib.instancer.names).
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/stat

export const ELIDABLE_AXIS_VALUE_NAME = 0x0002;
export const OLDER_SIBLING_FONT_ATTRIBUTE = 0x0001;

const tagString = (t) =>
  String.fromCharCode((t >>> 24) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255);
const fixed = (v, o) => v.getInt32(o, false) / 65536;

export class StatReader {
  constructor(tables) {
    this._tables = tables;
    this._axisValues = null;
    this._len = 0;
    this._view = tables.view;
    this._tableOff = -1;
    this._axes = [];
    this._elidedFallbackNameID = 0xffff;
    if (!tables.stat) return;
    const off = tables.stat[0];
    const v = this._view;
    this._tableOff = off;
    this._len = tables.stat[1];
    const major = v.getUint16(off + 0, false);
    const minor = v.getUint16(off + 2, false);
    if (major !== 1) return;
    const designAxisSize = v.getUint16(off + 4, false);
    const designAxisCount = v.getUint16(off + 6, false);
    const designAxesOff = off + v.getUint32(off + 8, false);
    for (let i = 0; i < designAxisCount; i++) {
      const recOff = designAxesOff + i * designAxisSize;
      const tag = v.getUint32(recOff, false);
      const nameID = v.getUint16(recOff + 4, false);
      const ordering = v.getUint16(recOff + 6, false);
      this._axes.push({ tag, nameID, ordering });
    }
    if (minor >= 1) {
      // STAT header: version(4) designAxisSize(2) designAxisCount(2)
      // designAxesOffset(4) axisValueCount(2) offsetToAxisValueOffsets(4)
      // = 18 bytes; elidedFallbackNameID follows at +18.
      this._elidedFallbackNameID = v.getUint16(off + 18, false);
    }
  }

  get hasTable() {
    return this._tableOff >= 0;
  }

  /// Axis records: [{ tag, nameID, ordering }, ...]
  /// tag is a 32-bit ASCII tag (e.g. 0x77676874 'wght'); nameID is
  /// the 'name' table index for the human-readable axis name.
  get axes() {
    return this._axes;
  }

  /// Returns axisTag→AxisRecord lookup map.
  axisByTag(tag) {
    for (const a of this._axes) if (a.tag === tag) return a;
    return null;
  }

  /// nameID into the 'name' table for the fallback style name
  /// (e.g. "Regular") used when no axis-value record matches.
  get elidedFallbackNameID() {
    return this._elidedFallbackNameID;
  }

  /// Parsed AxisValue tables in serialized order:
  /// { format, axisIndex, axisTag, flags, elidable, olderSibling, valueNameID, value, nominalValue, rangeMin,
  ///   rangeMax, linkedValue, records: [{ axisIndex, axisTag, value }] } (fields that a format lacks are null).
  /// A table that runs past STAT's end is skipped, never thrown on.
  get axisValues() {
    if (this._axisValues) return this._axisValues;
    const out = [];
    this._axisValues = out;
    if (this._tableOff < 0 || this._axes.length === 0) return out;
    const v = this._view,
      off = this._tableOff,
      end = off + this._len;
    if (off + 18 > end || v.getUint16(off, false) !== 1) return out;
    const count = v.getUint16(off + 12, false);
    const arr = off + v.getUint32(off + 14, false);
    if (arr + count * 2 > end) return out;
    const tag = (i) => (i < this._axes.length ? tagString(this._axes[i].tag) : '');
    for (let i = 0; i < count; i++) {
      const o = arr + v.getUint16(arr + i * 2, false);
      if (o + 6 > end) continue;
      const format = v.getUint16(o, false);
      const e = {
        format,
        axisIndex: -1,
        axisTag: '',
        flags: 0,
        elidable: false,
        olderSibling: false,
        valueNameID: 0,
        value: null,
        nominalValue: null,
        rangeMin: null,
        rangeMax: null,
        linkedValue: null,
        records: [],
      };
      if (format >= 1 && format <= 3) {
        const need = format === 1 ? 12 : format === 2 ? 20 : 16;
        if (o + need > end) continue;
        e.axisIndex = v.getUint16(o + 2, false);
        e.axisTag = tag(e.axisIndex);
        e.flags = v.getUint16(o + 4, false);
        e.valueNameID = v.getUint16(o + 6, false);
        if (format === 2) {
          e.nominalValue = fixed(v, o + 8);
          e.rangeMin = fixed(v, o + 12);
          e.rangeMax = fixed(v, o + 16);
          e.value = e.nominalValue;
        } else {
          e.value = fixed(v, o + 8);
          if (format === 3) e.linkedValue = fixed(v, o + 12);
        }
      } else if (format === 4) {
        const n = v.getUint16(o + 2, false);
        if (o + 8 + n * 6 > end) continue;
        e.flags = v.getUint16(o + 4, false);
        e.valueNameID = v.getUint16(o + 6, false);
        for (let k = 0; k < n; k++) {
          const ai = v.getUint16(o + 8 + k * 6, false);
          e.records.push({ axisIndex: ai, axisTag: tag(ai), value: fixed(v, o + 8 + k * 6 + 2) });
        }
      } else continue; // unknown format: ignored
      e.elidable = (e.flags & ELIDABLE_AXIS_VALUE_NAME) !== 0;
      e.olderSibling = (e.flags & OLDER_SIBLING_FONT_ATTRIBUTE) !== 0;
      out.push(e);
    }
    return out;
  }

  /// Does AxisValue `av` describe `location` ({ tag: userValue }, every design axis present)?
  /// Formats 1 and 3 match an exact value, format 2 its inclusive range, format 4 all of its records.
  static matches(av, location) {
    if (av.format === 4) {
      if (av.records.length === 0) return false;
      for (const r of av.records) if (location[r.axisTag] !== r.value) return false;
      return true;
    }
    const x = location[av.axisTag];
    if (typeof x !== 'number') return false;
    return av.format === 2 ? x >= av.rangeMin && x <= av.rangeMax : x === av.value;
  }

  /// The AxisValue tables that name `location`, in name order: for each design axis the best matching
  /// table (an exact nominal match beats a wider range, a narrower range beats a wider one, then serialized order),
  /// with format 4 tables dominant (most records first, taken only while none of their axes is already named),
  /// ordered by the axis's axisOrdering (design-axis index breaks ties). `naming` 'fonttools' orders by design-axis index
  /// instead, as fontTools' instancer does (a format 4 table sorts by its lowest axis index); the default is 'spec'.
  selectAxisValues(location, naming = 'spec') {
    const all = this.axisValues.filter((av) => StatReader.matches(av, location));
    const ord =
      naming === 'fonttools'
        ? (i) => i
        : (i) => (i >= 0 && i < this._axes.length ? this._axes[i].ordering : 0xffff);
    const taken = new Set();
    const picked = [];
    const f4 = all
      .filter((a) => a.format === 4)
      .map((a, i) => ({ a, i }))
      .sort((x, y) => y.a.records.length - x.a.records.length || x.i - y.i)
      .map((x) => x.a);
    for (const av of f4) {
      const idx = av.records.map((r) => r.axisIndex);
      if (idx.some((i) => taken.has(i))) continue;
      idx.forEach((i) => taken.add(i));
      picked.push({ av, key: Math.min(...idx.map(ord)), tie: Math.min(...idx) });
    }
    const specificity = (a, x) =>
      a.format === 2 ? (a.nominalValue === x ? 0 : 1 + (a.rangeMax - a.rangeMin)) : 0;
    const byAxis = new Map();
    for (const av of all) {
      if (av.format === 4 || taken.has(av.axisIndex)) continue;
      const cur = byAxis.get(av.axisIndex);
      if (!cur || specificity(av, location[av.axisTag]) < specificity(cur, location[cur.axisTag]))
        byAxis.set(av.axisIndex, av);
    }
    for (const [i, av] of byAxis) picked.push({ av, key: ord(i), tie: i });
    picked.sort((x, y) => x.key - y.key || x.tie - y.tie);
    return picked.map((p) => p.av);
  }

  /// The automatic style name for `location`: the non-elidable selected values' names joined by a space, or the
  /// elidedFallbackNameID name when every selected value is elidable (or none matched). `nameOf(id)` resolves a
  /// name-table ID. Null when no name resolves. `naming` is 'spec' (axisOrdering order, the default) or 'fonttools'.
  styleName(location, nameOf, naming = 'spec') {
    const parts = [];
    for (const av of this.selectAxisValues(location, naming)) {
      if (av.elidable) continue;
      const n = nameOf(av.valueNameID);
      if (n) parts.push(n);
    }
    if (parts.length) return parts.join(' ');
    return this._elidedFallbackNameID !== 0xffff
      ? nameOf(this._elidedFallbackNameID) || null
      : null;
  }
}

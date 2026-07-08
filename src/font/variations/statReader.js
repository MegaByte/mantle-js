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
// AxisValue formats 1/2/3/4 — record per (axis, value) name mapping
// for picker UIs. Surfaces the axis tag list + per-axis value records;
// format 4 (axis-value-table for combinations) is not surfaced.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/stat

export class StatReader {
  constructor(tables) {
    this._view = tables.view;
    this._tableOff = -1;
    this._axes = [];
    this._elidedFallbackNameID = 0xFFFF;
    if (!tables.stat) return;
    const off = tables.stat[0];
    const v = this._view;
    this._tableOff = off;
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
      this._elidedFallbackNameID = v.getUint16(off + 20, false);
    }
  }

  get hasTable() { return this._tableOff >= 0; }

  /// Axis records: [{ tag, nameID, ordering }, ...]
  /// tag is a 32-bit ASCII tag (e.g. 0x77676874 'wght'); nameID is
  /// the 'name' table index for the human-readable axis name.
  get axes() { return this._axes; }

  /// Returns axisTag→AxisRecord lookup map.
  axisByTag(tag) {
    for (const a of this._axes) if (a.tag === tag) return a;
    return null;
  }

  /// nameID into the 'name' table for the fallback style name
  /// (e.g. "Regular") used when no axis-value record matches.
  get elidedFallbackNameID() { return this._elidedFallbackNameID; }
}

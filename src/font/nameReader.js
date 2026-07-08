// nameReader.js — OpenType 'name' table reader.
//
// Returns a NameTable instance that exposes get(nameId, langPref?) →
// string. Encodings: platform 3 (Windows UCS-2 BE), platform 0
// (Unicode), platform 1 (Mac Roman) handled; rest decode as latin-1
// fallback.
//
// Useful nameIDs:
//   1 = Family (legacy)
//   2 = Subfamily / style ("Regular", "Bold Italic")
//   4 = Full name
//   6 = PostScript name
//  16 = Typographic family (preferred for naming when present)
//  17 = Typographic subfamily (preferred)
//  25 = Variations PostScript name prefix (Variable Fonts)
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/name

export class NameTable {
  /** @param {object} tables  result of parseTtfTables */
  constructor(tables) {
    this._records = null;
    this._strings = null;
    this._view = tables.view;
    this._bytes = tables.bytes;
    if (!tables.name) return;
    const v = this._view;
    const off = tables.name[0];
    const format    = v.getUint16(off + 0, false);
    const count     = v.getUint16(off + 2, false);
    const strOffRel = v.getUint16(off + 4, false);
    const strBase   = off + strOffRel;
    const recs = new Array(count);
    for (let i = 0; i < count; i++) {
      const r = off + 6 + i * 12;
      recs[i] = {
        platformID: v.getUint16(r + 0, false),
        encodingID: v.getUint16(r + 2, false),
        languageID: v.getUint16(r + 4, false),
        nameID:     v.getUint16(r + 6, false),
        length:     v.getUint16(r + 8, false),
        strOffRel:  v.getUint16(r + 10, false),
      };
    }
    this._records = recs;
    this._strBase = strBase;
  }

  get hasNames() { return this._records != null && this._records.length > 0; }

  /// Get the string for `nameId`, preferring (platform=3, encoding=1,
  /// language=0x0409 = en-US) → (platform=0, *) → (platform=1, *).
  /// Returns null when no matching record.
  get(nameId) {
    if (!this._records) return null;
    let best = null;
    let bestRank = 999;
    for (const r of this._records) {
      if (r.nameID !== nameId) continue;
      // Rank: lower is better.
      let rank;
      if (r.platformID === 3 && r.encodingID === 1 && r.languageID === 0x0409) rank = 0;
      else if (r.platformID === 3 && r.encodingID === 1)                       rank = 1;
      else if (r.platformID === 3 && r.encodingID === 10)                      rank = 2; // UCS-4
      else if (r.platformID === 0)                                              rank = 3;
      else if (r.platformID === 1 && r.languageID === 0)                       rank = 4;
      else if (r.platformID === 1)                                              rank = 5;
      else rank = 6;
      if (rank < bestRank) { bestRank = rank; best = r; }
    }
    if (!best) return null;
    return decodeRecord(this._bytes, this._strBase + best.strOffRel, best.length,
                        best.platformID, best.encodingID);
  }

  /// Resolve a (family, subfamily) pair using the preferred typographic
  /// names (16/17) when available, falling back to legacy (1/2).
  resolveFamily() {
    const fam = this.get(16) || this.get(1) || '';
    const sub = this.get(17) || this.get(2) || '';
    return { family: fam, subfamily: sub };
  }

  /// PostScript name (id 6) used by font matchers + variation prefix
  /// (id 25). Returns null when missing.
  get postScriptName()         { return this.get(6); }
  get variationsPSNamePrefix() { return this.get(25); }
}

function decodeRecord(bytes, off, len, platformID, encodingID) {
  // Slice the raw bytes (view, no copy).
  const slice = new Uint8Array(bytes.buffer, bytes.byteOffset + off, len);
  // platform 3 (Windows) + encoding 0/1 = UTF-16 BE.
  // platform 0 (Unicode) = always UTF-16 BE.
  if (platformID === 3 || platformID === 0) {
    return decodeUtf16BE(slice);
  }
  // platform 1 (Mac) — Mac Roman approximation: ASCII range is fine,
  // upper half stays as latin-1 (good enough; full Mac Roman table
  // unused in practice for modern fonts).
  let out = '';
  for (let i = 0; i < slice.length; i++) out += String.fromCharCode(slice[i]);
  return out;
}

function decodeUtf16BE(bytes) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const hi = bytes[i], lo = bytes[i + 1];
    out += String.fromCharCode((hi << 8) | lo);
  }
  return out;
}

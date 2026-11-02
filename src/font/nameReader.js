// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nameReader.js — OpenType 'name' table reader.
//
// Returns a NameTable instance that exposes get(nameId, langPref?) →
// string. Encodings: platform 3 (Windows UTF-16BE, including encoding 10
// for the full Unicode repertoire), platform 0
// (Unicode), platform 1 (Macintosh: the single-byte scripts by table, Japanese /
// Chinese / Korean through the platform TextDecoder, see nameCodecs.js); a record
// with no codec (Mac Arabic, Hebrew, ...) decodes as latin-1.
//
// Spec behavior is the default. `compat: "harfbuzz"` (MantleFontAsset option) reads
// the table the way hb_ot_name_get_utf8 does, measured against uharfbuzz 0.55: only
// Windows 3/0, 3/1 and 3/10 and Mac Roman (1/0) records are visible, and a Mac Roman
// byte above 0x7F decodes to U+FFFD.
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

import { MAC_SINGLE, MAC_MULTI, WIN_MULTI, macCodecKey } from './nameCodecs.js';

/// decodedRecords stops decoding here. Records may share their strings, so a table's size does not bound what it decodes to: a count
/// of 52980 records at 64 KB each exhausted the heap. Real name tables decode to well under a megabyte.
const MAX_DECODED_NAME_UNITS = 1 << 24;

export class NameTable {
  /** @param {object} tables  result of parseTtfTables (tables.nameCompat: 'harfbuzz' | undefined) */
  constructor(tables) {
    this._compat = tables.nameCompat === 'harfbuzz' ? 'harfbuzz' : 'spec';
    this._records = null;
    this._strings = null;
    this._view = tables.view;
    this._bytes = tables.bytes;
    if (!tables.name) return;
    const v = this._view;
    const off = tables.name[0];
    const format = v.getUint16(off + 0, false);
    const end = Math.min(off + tables.name[1], v.byteLength);
    // The records have to fit in the table, as HarfBuzz's sanitizer has it.
    const count = Math.min(
      v.getUint16(off + 2, false),
      Math.max(0, Math.floor((end - off - 6) / 12)),
    );
    const strOffRel = v.getUint16(off + 4, false);
    const strBase = off + strOffRel;
    const recs = new Array(count);
    for (let i = 0; i < count; i++) {
      const r = off + 6 + i * 12;
      recs[i] = {
        platformID: v.getUint16(r + 0, false),
        encodingID: v.getUint16(r + 2, false),
        languageID: v.getUint16(r + 4, false),
        nameID: v.getUint16(r + 6, false),
        length: v.getUint16(r + 8, false),
        strOffRel: v.getUint16(r + 10, false),
      };
    }
    this._records = recs;
    this._strBase = strBase;
  }

  get hasNames() {
    return this._records != null && this._records.length > 0;
  }

  /// Get the string for `nameId`, preferring (platform=3, encoding=1,
  /// language=0x0409 = en-US) → (platform=0, *) → (platform=1, *).
  /// Returns null when no matching record.
  get(nameId) {
    if (!this._records) return null;
    let best = null;
    let bestRank = 999;
    for (const r of this._records) {
      if (r.nameID !== nameId) continue;
      if (this._compat === 'harfbuzz' && !hbVisible(r)) continue;
      // Rank: lower is better.
      let rank;
      if (r.platformID === 3 && r.encodingID === 1 && r.languageID === 0x0409) rank = 0;
      else if (r.platformID === 3 && r.encodingID === 1) rank = 1;
      else if (r.platformID === 3 && r.encodingID === 10)
        rank = 2; // UCS-4
      else if (r.platformID === 0) rank = 3;
      else if (r.platformID === 1 && r.languageID === 0) rank = 4;
      else if (r.platformID === 1) rank = 5;
      else rank = 6;
      if (rank < bestRank) {
        bestRank = rank;
        best = r;
      }
    }
    if (!best) return null;
    return this._decode(best);
  }

  _decode(r) {
    return decodeRecord(
      this._bytes,
      this._strBase + r.strOffRel,
      r.length,
      r.platformID,
      r.encodingID,
      r.languageID,
      this._compat,
    );
  }

  /// Every record decoded with its own platform/encoding, in serialized order (diagnostics and parity tests).
  decodedRecords() {
    if (!this._records) return [];
    let budget = MAX_DECODED_NAME_UNITS;
    return this._records.map((r) => {
      budget -= r.length;
      return {
        platformID: r.platformID,
        encodingID: r.encodingID,
        languageID: r.languageID,
        nameID: r.nameID,
        text: budget >= 0 ? this._decode(r) : '',
      };
    });
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
  get postScriptName() {
    return this.get(6);
  }
  get variationsPSNamePrefix() {
    return this.get(25);
  }
}

// HarfBuzz lists Windows 3/0, 3/1, 3/10 and Mac Roman (1/0) records only.
function hbVisible(r) {
  if (r.platformID === 3) return r.encodingID === 0 || r.encodingID === 1 || r.encodingID === 10;
  return r.platformID === 1 && r.encodingID === 0;
}

const _decoders = new Map();
function platformDecoder(label) {
  let d = _decoders.get(label);
  if (d === undefined) {
    try {
      d = typeof TextDecoder === 'function' ? new TextDecoder(label, { fatal: true }) : null;
    } catch (e) {
      d = null;
    }
    _decoders.set(label, d);
  }
  return d;
}

function decodeRecord(bytes, off, len, platformID, encodingID, languageID, compat) {
  // A record past the end of the font is a bad name, not a bad font.
  if (off + len > bytes.length) return '';
  // Slice the raw bytes (view, no copy).
  const slice = new Uint8Array(bytes.buffer, bytes.byteOffset + off, len);
  // Windows 2..5: ShiftJIS, PRC, Big5, Wansung. (Encoding 10 is UTF-16 BE too: the name table stores UTF-16 for every
  // Unicode encoding ID; the "UCS-4" label names the repertoire, as fontTools and HarfBuzz read it.)
  if (platformID === 3 && WIN_MULTI[encodingID] !== undefined) {
    const out = decodeMultiByte(slice, MAC_MULTI[WIN_MULTI[encodingID]], false);
    if (out !== null) return out;
  }
  // platform 3 (Windows) + encoding 0/1 = UTF-16 BE; platform 0 (Unicode) = always UTF-16 BE.
  if (platformID === 3 || platformID === 0) return decodeUtf16BE(slice);
  if (platformID === 1) {
    if (compat === 'harfbuzz') {
      let out = '';
      for (let i = 0; i < slice.length; i++)
        out += slice[i] < 0x80 ? String.fromCharCode(slice[i]) : '\uFFFD';
      return out;
    }
    const key = macCodecKey(encodingID, languageID);
    if (key !== null && MAC_SINGLE[key] !== undefined) {
      const table = MAC_SINGLE[key];
      let out = '';
      for (let i = 0; i < slice.length; i++)
        out += slice[i] < 0x80 ? String.fromCharCode(slice[i]) : table[slice[i] - 0x80];
      return out;
    }
    if (key !== null && MAC_MULTI[key] !== undefined) {
      const out = decodeMultiByte(slice, MAC_MULTI[key], true);
      if (out !== null) return out;
    }
  }
  // No codec (or no platform decoder for it): latin-1 reading.
  let out = '';
  for (let i = 0; i < slice.length; i++) out += String.fromCharCode(slice[i]);
  return out;
}

// Double-byte script: a lead+trail pair inside the encoding's ranges goes to the platform decoder; otherwise (Mac only)
// a byte in Apple's single-byte exception set takes its mapping, then the decoder's single-byte form (half-width
// kana), else U+FFFD. Null when the host has no decoder for the label.
const inRanges = (v, ranges) => {
  for (const r of ranges) if (v >= r[0] && v <= r[1]) return true;
  return false;
};
function decodeMultiByte(slice, codec, mac) {
  const dec = platformDecoder(codec.label);
  if (dec === null) return null;
  const one = (a) => {
    try {
      return dec.decode(a);
    } catch (e) {
      return null;
    }
  };
  let out = '';
  for (let i = 0; i < slice.length;) {
    const b = slice[i];
    if (i + 1 < slice.length && inRanges(b, codec.leads) && inRanges(slice[i + 1], codec.trails)) {
      const pair = one(slice.subarray(i, i + 2));
      if (pair !== null) {
        out += pair;
        i += 2;
        continue;
      }
    }
    if (mac && codec.over[b] !== undefined) {
      out += codec.over[b];
      i++;
      continue;
    }
    const single = b < 0x80 ? String.fromCharCode(b) : one(slice.subarray(i, i + 1));
    out += single === null ? '\uFFFD' : single;
    i++;
  }
  return out;
}

function decodeUtf16BE(bytes) {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const hi = bytes[i],
      lo = bytes[i + 1];
    out += String.fromCharCode((hi << 8) | lo);
  }
  return out;
}

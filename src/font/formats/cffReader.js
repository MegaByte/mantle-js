// cffReader.js — Type 2 CharString-based outlines. Handles both CFF
// 1.0 (legacy OTF) and CFF 2.0 (variable OTF).
//
// Layout deltas CFF1 → CFF2 (encoded by `this._version`):
//   1. CFF2 header is 5 bytes (major minor hdrSize topDictSize:u16) —
//      CFF1's offSize byte is replaced by a u16 size.
//   2. CFF2 Top DICT lives DIRECTLY after the header (topDictSize
//      bytes), not inside an INDEX. CFF1 has Name INDEX → Top DICT
//      INDEX → String INDEX → Global Subr INDEX. CFF2 skips Name +
//      String INDEXes entirely (no PostScript names baked in).
//   3. CFF2 always uses FDArray + FDSelect (CFF1 only when CIDKeyed).
//      Each Font DICT has its own Private DICT.
//   4. CFF2 Top DICT adds vstore key (24) pointing to an
//      ItemVariationStore; consumed by the blend operator in the
//      Type 2 interpreter.
//   5. CFF2 Type 2 charstrings drop hint operators + the width
//      prefix; add blend (23) and vsindex (15). Encoded by the
//      interpreter's _isCff2 flag.

import { CharStringInterp } from './charStringInterp.js';
import { ItemVariationStore } from '../itemVariationStore.js';
import { mkLine, mkQuad, mkCubic, SEG_QUAD, SEG_CUBIC } from '../../primitives/seg.js';

export class CffReader {
  /**
   * @param {Uint8Array} bytes
   * @param {number} baseOff offset of the CFF table in the parent buffer
   * @param {number} len
   * @param {number} version 1 or 2; auto-detected from the header byte
   *   when omitted.
   * @param {number} fontIndex which font to read from a CFF1 FontSet
   *   (a CFF holding more than one font). Defaults to 0; ignored for CFF2.
   */
  constructor(bytes, baseOff, len, version = 0, fontIndex = 0) {
    this._b = bytes;
    this._base = baseOff;
    if (len < 4) throw new Error('CFF too small');
    const major = bytes[baseOff];
    if (version === 0) version = major;
    if (major !== version)
      throw new Error(`CFF version mismatch (header says ${major}, caller asked for ${version})`);
    if (version !== 1 && version !== 2)
      throw new Error(`CFF version ${version} not supported (1 or 2 only)`);
    this._version = version;
    const hdrSize = bytes[baseOff + 2];
    let cursor = baseOff + hdrSize;

    if (version === 1) {
      // Name INDEX
      cursor = this._skipIndex(cursor);
      // Top DICT INDEX. A CFF1 FontSet may hold more than one font; each
      // Top DICT entry is a separate font (own CharStrings/Private/charset).
      // Select `fontIndex` (default 0); the Name INDEX above carries the
      // per-font PostScript names.
      const topDictBase = cursor;
      const topDictCount = readU16(bytes, topDictBase);
      if (topDictCount < 1) throw new Error('CFF Top DICT INDEX is empty');
      this._fontCount = topDictCount;
      const fi = fontIndex >= 0 && fontIndex < topDictCount ? fontIndex : 0;
      const topRec = this._readIndexEntry(topDictBase, fi);
      this._topDictOff = topRec.off;
      this._topDictLen = topRec.len;
      cursor = this._skipIndex(cursor);
      // String INDEX
      this._stringIndexOff = cursor;
      cursor = this._skipIndex(cursor);
    } else {
      // CFF2: header includes topDictSize as u16. Top DICT is direct.
      this._topDictLen = (bytes[baseOff + 3] << 8) | bytes[baseOff + 4];
      this._topDictOff = baseOff + hdrSize;
      cursor = this._topDictOff + this._topDictLen;
    }
    // Global Subrs INDEX (both versions; CFF2 uses u32 count).
    this._gsubrIndexOff = cursor;
    this._nGlobalSubrs = this._readCount(cursor);
    cursor = this._skipIndex(cursor);

    this._charStringsOff = 0;
    this._privateOff = 0;
    this._privateLen = 0;
    this._lsubrIndexOff = -1;
    this._nLocalSubrs = 0;
    // CFF2 variation tables (filled by _parseTopDict).
    this._vstoreOff = 0;
    this._fdArrayOff = 0;
    this._fdSelectOff = 0;
    // FDArray entries (each: { privateOff, privateLen, lsubrIndexOff,
    // nLocalSubrs }). Populated by _parseFdArray for CFF2.
    this._fds = null;
    // gid → fontDictIdx (Uint8Array). Populated by _parseFdSelect.
    this._gidToFdIdx = null;
    // CFF1 charset (offset from Top DICT op 15). 0/1/2 = predefined.
    // Lazily parsed into _gidToSid / _sidToGid for legacy seac composition.
    this._charsetOff = 0;
    this._sidToGid = null;
    this._charsetReady = false;

    this._parseTopDict();
    this._nGlyphs = this._readCount(this._charStringsOff);

    if (version === 2) {
      // CFF2: parse FDArray (universal) + FDSelect (when present;
      // missing FDSelect for single-FD CFF2 means every gid uses
      // FD 0). Then parse each Font DICT's Private DICT.
      this._parseFdArray();
      if (this._fdSelectOff > 0) this._parseFdSelect();
    } else {
      // CFF1: single Private DICT per font.
      this._parsePrivateDict(this._privateOff, this._privateLen);
      if (this._lsubrIndexOff >= 0)
        this._nLocalSubrs = this._readCount(this._lsubrIndexOff);
    }
  }

  get numGlyphs() { return this._nGlyphs; }
  get version()   { return this._version; }
  /// Lazily-constructed ItemVariationStore for CFF2 blend. Returns
  /// null for CFF1 or CFF2 fonts with no vstore.
  get itemVariationStore() {
    if (this._version !== 2 || this._vstoreOff === 0) return null;
    if (!this._ivs) {
      // CFF2 spec §3: VarStore is at vstoreOff; the first 2 bytes
      // are an INDEX-style length prefix (uint16). The actual IVS
      // starts 2 bytes in.
      const view = new DataView(this._b.buffer, this._b.byteOffset, this._b.byteLength);
      this._ivs = new ItemVariationStore({ bytes: this._b, view },
                                          this._vstoreOff + 2);
    }
    return this._ivs;
  }

  /**
   * @param {number} gid
   * @param {number[]} [varCoords] normalized variation coords; CFF2 only.
   * @returns {Array|null} segs (in OpenType +Y-up coords) or null when empty
   */
  readGlyph(gid, varCoords = null) {
    const res = this._runGlyph(gid, varCoords);
    if (!res) return null;
    // Legacy Type 2 endchar-seac: compose base + accent (StandardEncoding
    // codes) here at the reader level, where the charset + CharStrings INDEX
    // are available (the interpreter only sees one glyph's bytes).
    if (res.seac) return this._composeSeac(res.seac, varCoords);
    return res.segs;
  }

  /// Run one glyph's charstring. Returns { segs, seac } — `seac` non-null
  /// only for the legacy endchar-seac form. Does NOT compose seac (so it is
  /// safe to call for the base/accent sub-glyphs without recursion).
  _runGlyph(gid, varCoords = null) {
    if (gid < 0 || gid >= this._nGlyphs) return null;
    const r = this._readIndexEntry(this._charStringsOff, gid);
    if (r.len === 0) return null;
    let lsubrIndexOff, nLocalSubrs;
    if (this._version === 2 && this._fds) {
      // Per-glyph FD picks the Private DICT (and its local Subrs).
      const fdIdx = this._gidToFdIdx ? this._gidToFdIdx[gid] : 0;
      const fd = this._fds[fdIdx] || this._fds[0];
      lsubrIndexOff = fd.lsubrIndexOff;
      nLocalSubrs   = fd.nLocalSubrs;
    } else {
      lsubrIndexOff = this._lsubrIndexOff;
      nLocalSubrs   = this._nLocalSubrs;
    }
    const interp = new CharStringInterp(this._b, this._gsubrIndexOff,
      lsubrIndexOff, this._nGlobalSubrs, nLocalSubrs,
      this._version === 2, this.itemVariationStore, varCoords);
    const segs = interp.run(r.off, r.len);
    return { segs, seac: interp._seac };
  }

  /// Compose a legacy seac (base + accent). bchar/achar are Adobe
  /// StandardEncoding codes; resolve each to a SID, then to a GID via the
  /// charset, run both, and translate the accent by (adx, ady). Type 2
  /// charstrings have no sidebearing (origin at 0), so the offset is direct.
  _composeSeac(seac, varCoords) {
    this._ensureCharset();
    if (!this._sidToGid) return null;
    const bSid = stdEncToSid(seac.bchar), aSid = stdEncToSid(seac.achar);
    const bGid = this._sidToGid.get(bSid), aGid = this._sidToGid.get(aSid);
    if (bGid == null || aGid == null) return null;
    const base = this._runGlyph(bGid, varCoords);
    const acc  = this._runGlyph(aGid, varCoords);
    const out = base && base.segs ? base.segs.slice() : [];
    if (acc && acc.segs)
      for (const s of acc.segs) out.push(translateSeg(s, seac.adx, seac.ady));
    return out.length ? out : null;
  }

  /// Build gid→SID (then SID→gid) from the CFF1 charset. Predefined
  /// charsets 0/1/2 (ISOAdobe/Expert/ExpertSubset): only ISOAdobe (0) maps
  /// gid→SID = gid, which is the only one seac realistically needs.
  _ensureCharset() {
    if (this._charsetReady) return;
    this._charsetReady = true;
    if (this._version === 2) return;            // CFF2 has no charset
    const n = this._nGlyphs;
    const gidToSid = new Int32Array(n);          // gid 0 = .notdef = SID 0
    const off = this._charsetOff;
    if (off === 0) {                             // predefined ISOAdobe
      for (let g = 0; g < n; g++) gidToSid[g] = g;
    } else if (off === 1 || off === 2) {
      // Expert / ExpertSubset predefined charsets are not built (seac fonts
      // use a custom or ISOAdobe charset); leave gid→SID identity-less.
      return;
    } else {
      let o = this._base + off;
      const fmt = this._b[o++];
      let gid = 1;                               // gid 0 is implicit .notdef
      if (fmt === 0) {
        for (; gid < n; gid++) { gidToSid[gid] = readU16(this._b, o); o += 2; }
      } else if (fmt === 1 || fmt === 2) {
        while (gid < n) {
          const first = readU16(this._b, o); o += 2;
          let nLeft;
          if (fmt === 1) { nLeft = this._b[o]; o += 1; }
          else           { nLeft = readU16(this._b, o); o += 2; }
          for (let i = 0; i <= nLeft && gid < n; i++) gidToSid[gid++] = first + i;
        }
      } else {
        return;                                  // unknown charset format
      }
    }
    const sidToGid = new Map();
    for (let g = 0; g < n; g++) {
      const sid = gidToSid[g];
      if (!sidToGid.has(sid)) sidToGid.set(sid, g);
    }
    this._sidToGid = sidToGid;
  }

  /// CFF1 INDEX: uint16 count + uint8 offSize + offset table + data.
  /// CFF2 INDEX: uint32 count + uint8 offSize + offset table + data.
  /// Differs by 2 bytes in the count field (and trivially empty
  /// INDEX = just the count, no offSize/table).
  get _countSize() { return this._version === 2 ? 4 : 2; }
  _readCount(indexOff) {
    return this._version === 2 ? readU32(this._b, indexOff)
                                : readU16(this._b, indexOff);
  }

  _readIndexEntry(indexOff, idx) {
    const count = this._readCount(indexOff);
    if (count === 0) return { off: 0, len: 0 };
    const cs = this._countSize;
    const offSize = this._b[indexOff + cs];
    const offTableOff = indexOff + cs + 1;
    const dataOff = offTableOff + (count + 1) * offSize;
    const a = readOffN(this._b, offTableOff + idx * offSize, offSize);
    const b = readOffN(this._b, offTableOff + (idx + 1) * offSize, offSize);
    return { off: dataOff + a - 1, len: b - a };
  }

  _skipIndex(indexOff) {
    const count = this._readCount(indexOff);
    const cs = this._countSize;
    if (count === 0) return indexOff + cs;
    const offSize = this._b[indexOff + cs];
    const offTableOff = indexOff + cs + 1;
    const dataOff = offTableOff + (count + 1) * offSize;
    const lastOff = readOffN(this._b, offTableOff + count * offSize, offSize);
    return dataOff + lastOff - 1;
  }

  _parseTopDict() {
    let o = this._topDictOff;
    const end = this._topDictOff + this._topDictLen;
    const operands = [];
    while (o < end) {
      const b0 = this._b[o++];
      if (b0 >= 32) {
        operands.push(this._readDictOperand(b0, () => {}, o, true));
        o = this._dictOpCursor;
      } else if (b0 === 28) {
        operands.push(signed16((this._b[o] << 8) | this._b[o + 1])); o += 2;
      } else if (b0 === 29) {
        operands.push(signed32((this._b[o] << 24) | (this._b[o + 1] << 16) | (this._b[o + 2] << 8) | this._b[o + 3]));
        o += 4;
      } else if (b0 === 30) {
        // BCD real: skip until end marker.
        while (o < end) {
          const v = this._b[o++];
          if ((v & 0x0F) === 0x0F || (v & 0xF0) === 0xF0) break;
        }
        operands.push(0);
      } else {
        const op = (b0 === 12) ? (12 * 256 + this._b[o++]) : b0;
        this._handleTopDictOperator(op, operands);
        operands.length = 0;
      }
    }
  }

  _handleTopDictOperator(op, operands) {
    switch (op) {
      case 15: // charset offset (CFF1; 0/1/2 = predefined ISOAdobe/Expert/ExpertSubset)
        if (operands.length > 0) this._charsetOff = operands[operands.length - 1];
        break;
      case 17: // CharStrings offset
        if (operands.length > 0) this._charStringsOff = this._base + operands[operands.length - 1];
        break;
      case 18: // Private DICT size + offset (CFF1; CFF2 has it under FDArray)
        if (operands.length >= 2) {
          this._privateLen = operands[operands.length - 2];
          this._privateOff = this._base + operands[operands.length - 1];
        }
        break;
      case 24: // vstore (CFF2 only) — offset to ItemVariationStore
        if (operands.length > 0) this._vstoreOff = this._base + operands[operands.length - 1];
        break;
      case (12 * 256 + 36): // FDArray (CFF2 universal; CFF1 CIDKeyed)
        if (operands.length > 0) this._fdArrayOff = this._base + operands[operands.length - 1];
        break;
      case (12 * 256 + 37): // FDSelect (same)
        if (operands.length > 0) this._fdSelectOff = this._base + operands[operands.length - 1];
        break;
    }
  }

  /// Parse the FDArray INDEX. Each entry is a Font DICT (same DICT
  /// format as Top DICT); we only care about its Private DICT key
  /// (18). Used by CFF2 (always) and CIDKeyed CFF1.
  _parseFdArray() {
    if (this._fdArrayOff === 0) {
      // Shouldn't happen for spec-compliant CFF2, but be defensive:
      // synthesize a single FD pointing at the Top-DICT-supplied
      // Private DICT.
      this._fds = [{ privateOff: this._privateOff, privateLen: this._privateLen,
                     lsubrIndexOff: -1, nLocalSubrs: 0 }];
      this._parsePrivateDict(this._privateOff, this._privateLen, this._fds[0]);
      return;
    }
    const count = this._readCount(this._fdArrayOff);
    this._fds = new Array(count);
    for (let i = 0; i < count; i++) {
      const fdRec = this._readIndexEntry(this._fdArrayOff, i);
      const fd = { privateOff: 0, privateLen: 0, lsubrIndexOff: -1, nLocalSubrs: 0 };
      this._parseFontDict(fdRec.off, fdRec.len, fd);
      if (fd.privateLen > 0) this._parsePrivateDict(fd.privateOff, fd.privateLen, fd);
      if (fd.lsubrIndexOff >= 0)
        fd.nLocalSubrs = this._readCount(fd.lsubrIndexOff);
      this._fds[i] = fd;
    }
  }

  /// Walk a Font DICT (same byte format as Top DICT). Captures key
  /// 18 (Private DICT size+offset) into the supplied FD record.
  _parseFontDict(off, len, fd) {
    let o = off;
    const end = off + len;
    const operands = [];
    while (o < end) {
      const b0 = this._b[o++];
      if (b0 >= 32) {
        operands.push(this._readDictOperand(b0, () => {}, o, true));
        o = this._dictOpCursor;
      } else if (b0 === 28) {
        operands.push(signed16((this._b[o] << 8) | this._b[o + 1])); o += 2;
      } else if (b0 === 29) {
        operands.push(signed32((this._b[o] << 24) | (this._b[o + 1] << 16) | (this._b[o + 2] << 8) | this._b[o + 3]));
        o += 4;
      } else if (b0 === 30) {
        while (o < end) {
          const v = this._b[o++];
          if ((v & 0x0F) === 0x0F || (v & 0xF0) === 0xF0) break;
        }
        operands.push(0);
      } else {
        const op = (b0 === 12) ? (12 * 256 + this._b[o++]) : b0;
        if (op === 18 && operands.length >= 2) {
          fd.privateLen = operands[operands.length - 2];
          fd.privateOff = this._base + operands[operands.length - 1];
        }
        operands.length = 0;
      }
    }
  }

  /// Parse FDSelect (gid → fontDictIdx). Formats 0, 3, 4 per spec.
  _parseFdSelect() {
    const o = this._fdSelectOff;
    const format = this._b[o];
    const map = new Uint16Array(this._nGlyphs);
    if (format === 0) {
      for (let i = 0; i < this._nGlyphs; i++) map[i] = this._b[o + 1 + i];
    } else if (format === 3) {
      const nRanges = readU16(this._b, o + 1);
      let cursor = o + 3;
      const ranges = [];
      for (let i = 0; i < nRanges; i++) {
        ranges.push({
          first: readU16(this._b, cursor),
          fd:    this._b[cursor + 2],
        });
        cursor += 3;
      }
      const sentinel = readU16(this._b, cursor);
      for (let i = 0; i < nRanges; i++) {
        const start = ranges[i].first;
        const stop  = (i + 1 < nRanges) ? ranges[i + 1].first : sentinel;
        for (let g = start; g < stop && g < this._nGlyphs; g++) map[g] = ranges[i].fd;
      }
    } else if (format === 4) {
      // Format 4 uses uint32 first, uint16 fd. Used for very large fonts.
      const nRanges = (this._b[o + 1] << 24) | (this._b[o + 2] << 16)
                   | (this._b[o + 3] <<  8) |  this._b[o + 4];
      let cursor = o + 5;
      const ranges = [];
      for (let i = 0; i < nRanges; i++) {
        const first = (this._b[cursor] << 24) | (this._b[cursor + 1] << 16)
                    | (this._b[cursor + 2] << 8) | this._b[cursor + 3];
        const fd    = readU16(this._b, cursor + 4);
        ranges.push({ first, fd });
        cursor += 6;
      }
      const sentinel = (this._b[cursor] << 24) | (this._b[cursor + 1] << 16)
                    | (this._b[cursor + 2] << 8) | this._b[cursor + 3];
      for (let i = 0; i < nRanges; i++) {
        const start = ranges[i].first;
        const stop  = (i + 1 < nRanges) ? ranges[i + 1].first : sentinel;
        for (let g = start; g < stop && g < this._nGlyphs; g++) map[g] = ranges[i].fd;
      }
    } else {
      throw new Error(`Unknown FDSelect format ${format}`);
    }
    this._gidToFdIdx = map;
  }

  _parsePrivateDict(privOff, privLen, fdOut) {
    if (privLen === 0) return;
    let o = privOff;
    const end = privOff + privLen;
    const operands = [];
    while (o < end) {
      const b0 = this._b[o++];
      if (b0 >= 32) {
        operands.push(this._readDictOperand(b0, () => {}, o, true));
        o = this._dictOpCursor;
      } else if (b0 === 28) {
        operands.push(signed16((this._b[o] << 8) | this._b[o + 1])); o += 2;
      } else if (b0 === 29) {
        operands.push(signed32((this._b[o] << 24) | (this._b[o + 1] << 16) | (this._b[o + 2] << 8) | this._b[o + 3]));
        o += 4;
      } else if (b0 === 30) {
        while (o < end) {
          const v = this._b[o++];
          if ((v & 0x0F) === 0x0F || (v & 0xF0) === 0xF0) break;
        }
        operands.push(0);
      } else {
        const op = (b0 === 12) ? (12 * 256 + this._b[o++]) : b0;
        // Key 19 = Subrs offset (relative to Private DICT start).
        if (op === 19 && operands.length > 0) {
          const lsubrOff = privOff + operands[operands.length - 1];
          if (fdOut) fdOut.lsubrIndexOff = lsubrOff;
          else       this._lsubrIndexOff = lsubrOff;
        }
        operands.length = 0;
      }
    }
  }

  _readDictOperand(b0, _unused, o, advance) {
    if (b0 >= 32 && b0 <= 246) { this._dictOpCursor = o; return b0 - 139; }
    if (b0 >= 247 && b0 <= 250) { const v = (b0 - 247) * 256 + this._b[o++] + 108; this._dictOpCursor = o; return v; }
    if (b0 >= 251 && b0 <= 254) { const v = -((b0 - 251) * 256) - this._b[o++] - 108; this._dictOpCursor = o; return v; }
    throw new Error('unexpected DICT byte ' + b0);
  }
}

function readU16(b, o) { return (b[o] << 8) | b[o + 1]; }
function readU32(b, o) { return ((b[o] << 24) >>> 0) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }
function readOffN(b, o, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 8) | b[o + i];
  return v;
}
function signed16(v) { return v >= 0x8000 ? v - 0x10000 : v; }
function signed32(v) { return v | 0; }

// Translate every control point of a segment by (dx, dy). Used by seac to
// place the accent relative to the base glyph. Preserves seg type/flags.
function translateSeg(s, dx, dy) {
  const t = (p) => [p[0] + dx, p[1] + dy];
  if (s.type === SEG_CUBIC) return mkCubic(t(s.p1), t(s.p2), t(s.p3), t(s.p4));
  if (s.type === SEG_QUAD)  return mkQuad(t(s.p1), t(s.p2), t(s.p3));
  return mkLine(t(s.p1), t(s.p2), s.is_fill_only);
}

// Adobe StandardEncoding code → CFF standard-string SID, for legacy seac
// (bchar/achar are StandardEncoding codes). The standard strings were laid
// out so codes 32..126 map linearly to SIDs 1..95; the upper range (accents
// + Latin-1 symbols) is sparse.
const _STD_ENC_UPPER = {
  161:96,162:97,163:98,164:99,165:100,166:101,167:102,168:103,169:104,170:105,
  171:106,172:107,173:108,174:109,175:110,177:111,178:112,179:113,180:114,
  182:115,183:116,184:117,185:118,186:119,187:120,188:121,189:122,191:123,
  193:124,194:125,195:126,196:127,197:128,198:129,199:130,200:131,202:132,
  203:133,205:134,206:135,207:136,208:137,225:138,227:139,232:140,233:141,
  234:142,235:143,241:144,245:145,248:146,249:147,250:148,251:149,
};
function stdEncToSid(code) {
  code &= 0xff;
  if (code >= 32 && code <= 126) return code - 31;   // space..asciitilde → SID 1..95
  return _STD_ENC_UPPER[code] || 0;
}

// Used by CharStringInterp for callsubr/callgsubr indexing.
export function readCffIndexEntry(b, indexOff, idx) {
  const count = readU16(b, indexOff);
  if (count === 0) return { off: 0, len: 0 };
  const offSize = b[indexOff + 2];
  const offTableOff = indexOff + 3;
  const dataOff = offTableOff + (count + 1) * offSize;
  const a = readOffN(b, offTableOff + idx * offSize, offSize);
  const bo = readOffN(b, offTableOff + (idx + 1) * offSize, offSize);
  return { off: dataOff + a - 1, len: bo - a };
}

// aatMort.js — Apple Advanced Typography legacy 'mort' shaping.
//
// 'mort' is the pre-2002 predecessor of
// 'morx': same five subtable TYPES (rearrangement / contextual / ligature
// / noncontextual / insertion), but a CLASSIC (non-extended) binary
// encoding — 8-bit state-array entries, a narrow ClassTable instead of an
// AAT Lookup, byte-offset `newState` fields, and u16 (not u32) chain /
// subtable headers. Deprecated by Apple, but HarfBuzz (hence
// Chrome/Firefox/Android) still shapes mort-only fonts.
//
// morx is preferred when both are present (matching CoreText / HarfBuzz).
//
// The classic encoding differs from morx mainly in addressing: classic
// resolves action/component/ligature and contextual-substitution
// addresses as byte/word OFFSETS from the subtable body (HarfBuzz
// ObsoleteTypes offsetToIndex / wordOffsetToIndex), where morx uses
// direct indices.
//
// Refs:
//   https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6mort.html
//   HarfBuzz hb-aat-layout-common.hh / hb-aat-layout-morx-table.hh

import { aatLookup } from './aatLookup.js';

const CLASS_END_OF_TEXT = 0;
const CLASS_OUT_OF_BOUNDS = 1;
const CLASS_DELETED_GLYPH = 2;
const DELETED_GLYPH = 0xFFFF;

export class AatMort {
  constructor(tables) {
    this._view = tables.view;
    this._numGlyphs = tables.numGlyphs;
    this._off = -1;
    if (!tables.mort) return;
    const v = tables.view, off = tables.mort[0];
    if (v.getUint16(off, false) !== 1) return;   // version 1.0 (Fixed hi word)
    this._off = off;
  }

  get hasMort() { return this._off >= 0; }

  /// Apply default-on mort chains. Returns { gids, src } like AatMorx.apply.
  apply(gids) {
    if (this._off < 0 || gids.length === 0) return { gids: gids.slice(), src: gids.map((_, i) => i) };
    const v = this._view;
    const glyphs = gids.slice();
    const src = gids.map((_, i) => i);
    const nChains = v.getUint32(this._off + 4, false);
    let p = this._off + 8;
    for (let c = 0; c < nChains; c++) {
      const defaultFlags = v.getUint32(p, false);
      const chainLength  = v.getUint32(p + 4, false);
      const nFeatures    = v.getUint16(p + 8, false);
      const nSubtables   = v.getUint16(p + 10, false);
      let q = p + 12 + nFeatures * 12;          // skip feature array (12 bytes each)
      for (let s = 0; s < nSubtables; s++) {
        const length = v.getUint16(q, false);
        const coverage = v.getUint16(q + 2, false);
        const subFeatureFlags = v.getUint32(q + 4, false);
        const type = coverage & 0x0007;
        if ((subFeatureFlags & defaultFlags) !== 0) {
          const vertical = (coverage & 0x8000) !== 0;
          if (!vertical) this._applySubtable(type, q + 8, glyphs, src);
        }
        q += length;
      }
      p += chainLength;
    }
    const outGids = [], outSrc = [];
    for (let i = 0; i < glyphs.length; i++) {
      if (glyphs[i] === DELETED_GLYPH) continue;
      outGids.push(glyphs[i]); outSrc.push(src[i]);
    }
    return { gids: outGids, src: outSrc };
  }

  _applySubtable(type, off, glyphs, src) {
    switch (type) {
      case 0: this._stateMachine(off, glyphs, src, 0); break;   // rearrangement
      case 1: this._stateMachine(off, glyphs, src, 1); break;   // contextual
      case 2: this._stateMachine(off, glyphs, src, 2); break;   // ligature
      case 4: this._noncontextual(off, glyphs); break;          // noncontextual
      case 5: this._stateMachine(off, glyphs, src, 5); break;   // insertion
    }
  }

  // type 4: classic noncontextual uses the same AAT lookup as morx.
  _noncontextual(off, glyphs) {
    for (let i = 0; i < glyphs.length; i++) {
      if (glyphs[i] === DELETED_GLYPH) continue;
      const sub = aatLookup(this._view, off, glyphs[i], this._numGlyphs);
      if (sub >= 0) glyphs[i] = sub;
    }
  }

  /// Classic state machine. The StateHeader is 4 × u16:
  ///   nClasses, classTableOffset, stateArrayOffset, entryTableOffset
  /// (offsets from `off`, the subtable body). State-array entries are
  /// BYTES; an entry's `newState` is a byte offset into the state array,
  /// so the next state index = (newState - stateArrayOffset) / nClasses.
  _stateMachine(off, glyphs, src, type) {
    const v = this._view;
    const nClasses    = v.getUint16(off, false);
    const classOff    = off + v.getUint16(off + 2, false);
    const stateArrOff = off + v.getUint16(off + 4, false);
    const stateArrRel = v.getUint16(off + 4, false);
    const entryOff    = off + v.getUint16(off + 6, false);

    // Classic ligature addressing is entirely offset-based relative to
    // the subtable body `off` (HarfBuzz ObsoleteTypes: offsetToIndex /
    // wordOffsetToIndex reduce every address to off + raw_offset). The
    // three ligature header offsets cancel out, so we don't need them.
    // Insertion (type 5) keeps a real header offset to the insertion
    // glyph table (insertionAction), indexed by currentInsertIndex.
    const insertActionOff = type === 5 ? off + v.getUint16(off + 8, false) : 0;
    const entrySize = type === 1 || type === 5 ? 8 : 4;

    const stack = [];           // ligature component positions
    let markIdx = -1;           // contextual mark
    let rearrFirst = -1, rearrLast = -1;

    let state = 0;
    let i = 0;
    let guard = 0, guardMax = glyphs.length * 4 + 16;
    while (guard++ < guardMax) {
      const atEnd = i >= glyphs.length;
      let cls;
      if (atEnd) cls = CLASS_END_OF_TEXT;
      else {
        const g = glyphs[i];
        cls = g === DELETED_GLYPH ? CLASS_DELETED_GLYPH : _classOf(v, classOff, g);
      }
      // classic: byte entry index from the state array row.
      const entryIdx = v.getUint8(stateArrOff + state * nClasses + cls);
      const eOff = entryOff + entryIdx * entrySize;
      const newState = v.getUint16(eOff, false);
      const flags = v.getUint16(eOff + 2, false);
      // byte offset → state index.
      const nextState = ((newState - stateArrRel) / nClasses) | 0;
      let advance = true;

      switch (type) {
        case 2: { // ligature
          if ((flags & 0x8000) && !atEnd) stack.push(i);
          const actionByteOff = flags & 0x3FFF;   // byte offset from `off` to action list
          if (actionByteOff !== 0)
            _performLigAction(v, glyphs, stack, off, actionByteOff);
          advance = (flags & 0x4000) === 0;
          break;
        }
        case 1: { // contextual
          const markOffset = v.getUint16(eOff + 4, false);    // word offset
          const currentOffset = v.getUint16(eOff + 6, false);
          if (currentOffset !== 0 && !atEnd) {
            const g = _wordSubst(v, off, currentOffset, glyphs[i]);
            if (g >= 0) glyphs[i] = g;
          }
          if (markOffset !== 0 && markIdx >= 0) {
            const g = _wordSubst(v, off, markOffset, glyphs[markIdx]);
            if (g >= 0) glyphs[markIdx] = g;
          }
          if ((flags & 0x8000) && !atEnd) markIdx = i;
          advance = (flags & 0x4000) === 0;
          break;
        }
        case 5: { // insertion
          // Insertion glyphs come from insertionAction[index .. +count].
          // currentInsertIndex/markedInsertIndex are indices (u16 glyphs);
          // counts live in distinct flag fields (current 0x3E0>>5, marked
          // 0x001F); the before/after bit differs per kind.
          const currentInsertIndex = v.getUint16(eOff + 4, false);
          const markedInsertIndex  = v.getUint16(eOff + 6, false);
          const readInserts = (idx, n) => {
            const a = [];
            for (let k = 0; k < n; k++) a.push(v.getUint16(insertActionOff + (idx + k) * 2, false));
            return a;
          };
          // Marked insertion first (at the marked glyph position).
          if (markedInsertIndex !== 0xFFFF && markIdx >= 0) {
            const n = flags & 0x001F;
            if (n > 0) {
              const ins = readInserts(markedInsertIndex, n);
              const pos = (flags & 0x0400) ? markIdx : markIdx + 1;
              glyphs.splice(pos, 0, ...ins);
              src.splice(pos, 0, ...ins.map(() => src[markIdx]));
              if (pos <= i) i += ins.length;
            }
          }
          // Current insertion (at the current glyph position).
          if (currentInsertIndex !== 0xFFFF && !atEnd) {
            const n = (flags & 0x3E0) >> 5;
            if (n > 0) {
              const ins = readInserts(currentInsertIndex, n);
              const before = (flags & 0x0800) !== 0;
              const pos = before ? i : i + 1;
              glyphs.splice(pos, 0, ...ins);
              src.splice(pos, 0, ...ins.map(() => src[i]));
              if (before) i += ins.length;   // skip past glyphs inserted before current
            }
          }
          advance = (flags & 0x4000) === 0;
          break;
        }
        case 0: { // rearrangement
          if ((flags & 0x8000) && !atEnd) rearrFirst = i;
          if ((flags & 0x2000) && !atEnd) rearrLast = i;
          const verb = flags & 0x000F;
          if (verb !== 0 && rearrFirst >= 0 && rearrLast >= rearrFirst)
            _rearrange(glyphs, src, rearrFirst, rearrLast, verb);
          advance = (flags & 0x4000) === 0;
          break;
        }
      }

      state = nextState;
      if (atEnd) break;
      if (advance) i += 1;
    }
  }
}

// Narrow ClassTable: firstGlyph u16, nGlyphs u16, classArray u8[nGlyphs].
function _classOf(v, classOff, gid) {
  const first = v.getUint16(classOff, false);
  const n = v.getUint16(classOff + 2, false);
  if (gid < first || gid >= first + n) return CLASS_OUT_OF_BOUNDS;
  return v.getUint8(classOff + 4 + (gid - first));
}

// Classic contextual substitution table: `wordOffset` is in 16-bit words
// from the subtable body; the table is a glyph-indexed u16 array. 0 = keep.
function _wordSubst(v, bodyOff, wordOffset, gid) {
  const sub = v.getUint16(bodyOff + wordOffset * 2 + gid * 2, false);
  return sub === 0 ? -1 : sub;
}

// Classic ligature action (mort). Unlike morx (index-based), every
// address is a byte/word OFFSET from the subtable body `bodyOff`:
//   action list   at bodyOff + actionByteOff   (u32 actions)
//   component val  at bodyOff + 2*(glyph+offset)
//   ligature glyph at bodyOff + accumulatedIndex
// (HarfBuzz ObsoleteTypes offsetToIndex/wordOffsetToIndex collapse to
// these.) The u32 action format (last/store/sign-extended offset) is the
// same as morx.
function _performLigAction(v, glyphs, stack, bodyOff, actionByteOff) {
  let aOff = bodyOff + actionByteOff;
  let ligIndexAccum = 0;
  const consumed = [];
  let sp = stack.length;
  while (true) {
    const action = v.getUint32(aOff, false); aOff += 4;
    const last = (action & 0x80000000) !== 0;
    const store = (action & 0x40000000) !== 0;
    let offset = action & 0x3FFFFFFF;
    if (offset & 0x20000000) offset -= 0x40000000;
    if (sp <= 0) break;
    const compPos = stack[--sp];
    consumed.push(compPos);
    ligIndexAccum += v.getUint16(bodyOff + 2 * (glyphs[compPos] + offset), false);
    if (last || store) {
      const ligGlyph = v.getUint16(bodyOff + ligIndexAccum, false);
      let minPos = consumed[0];
      for (const pp of consumed) if (pp < minPos) minPos = pp;
      for (const pp of consumed) glyphs[pp] = DELETED_GLYPH;
      glyphs[minPos] = ligGlyph;
      stack.length = sp; stack.push(minPos);
      ligIndexAccum = 0; consumed.length = 0;
    }
    if (last) break;
  }
}

// AAT rearrangement verbs (same table as morx).
function _rearrange(glyphs, src, first, last, verb) {
  const order = _rearrangeOrder(last - first + 1, verb);
  if (!order) return;
  const g = order.map((k) => glyphs[first + k]);
  const s = order.map((k) => src[first + k]);
  for (let k = 0; k < g.length; k++) { glyphs[first + k] = g[k]; src[first + k] = s[k]; }
}
function _rearrangeOrder(len, verb) {
  if (verb === 0 || len < 1) return null;
  const id = Array.from({ length: len }, (_, k) => k);
  const A = 0, B = 1, C = len - 2, D = len - 1;
  const M = (a, b) => id.slice(a, b);
  switch (verb) {
    case 1:  return [...M(1, len), A];
    case 2:  return [D, ...M(0, len - 1)];
    case 3:  return len >= 2 ? [D, ...M(1, len - 1), A] : null;
    case 4:  return len >= 2 ? [...M(2, len), A, B] : null;
    case 5:  return len >= 2 ? [...M(2, len), B, A] : null;
    case 6:  return len >= 2 ? [C, D, ...M(0, len - 2)] : null;
    case 7:  return len >= 2 ? [D, C, ...M(0, len - 2)] : null;
    case 8:  return len >= 3 ? [C, D, ...M(1, len - 2), A] : null;
    case 9:  return len >= 3 ? [D, C, ...M(1, len - 2), A] : null;
    case 10: return len >= 3 ? [D, ...M(2, len - 1), A, B] : null;
    case 11: return len >= 3 ? [D, ...M(2, len - 1), B, A] : null;
    case 12: return len >= 4 ? [C, D, ...M(2, len - 2), A, B] : null;
    case 13: return len >= 4 ? [C, D, ...M(2, len - 2), B, A] : null;
    case 14: return len >= 4 ? [D, C, ...M(2, len - 2), A, B] : null;
    case 15: return len >= 4 ? [D, C, ...M(2, len - 2), B, A] : null;
    default: return null;
  }
}

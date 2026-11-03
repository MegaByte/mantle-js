// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { runAatInsertion } from './aatInsertion.js';
// aatMorx.js — Apple Advanced Typography 'morx' shaping.
//
// Implements the extended glyph metamorphosis table used by AAT-only fonts
// (Zapfino, Hoefler Text, American Typewriter, Helvetica.ttc, Apple Chancery,
// …) that carry NO GSUB and rely on morx for ligatures + contextual shaping.
// Policy: prefer OpenType GSUB when present; fall back to morx only when the
// font has no GSUB.
//
// Subtable coverage:
//   type 0 rearrangement   — state machine, glyph reordering (Indic)
//   type 1 contextual      — state machine, per-entry glyph swap
//   type 2 ligature        — state machine, ligature formation (most common)
//   type 4 noncontextual   — flat AAT-lookup glyph→glyph swap
//   type 5 insertion       — state machine, glyph insertion
// All five are implemented. Subtables are gated by the chain's default
// feature flags (subFeatureFlags & defaultFlags) so only default-on
// features (required ligatures, default contextual forms) apply.
//
// The shared building blocks are the AAT Lookup table (glyph→value, all
// formats) and the Extended State Table driver (16-bit classes/states).
//
// Refs:
//   https://learn.microsoft.com/en-us/typography/opentype/spec/morx
//   https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6morx.html

import { aatLookup } from './aatLookup.js';

// Reserved AAT state-machine class codes.
const CLASS_END_OF_TEXT = 0;
const CLASS_OUT_OF_BOUNDS = 1;
const CLASS_DELETED_GLYPH = 2;
// Reserved state indices.
const STATE_START_OF_TEXT = 0;

const DELETED_GLYPH = 0xffff; // marker for glyphs removed by ligature/contextual passes

export class AatMorx {
  constructor(tables) {
    this._view = tables.view;
    this._off = -1;
    this._numGlyphs = tables.numGlyphs;
    if (!tables.morx) return;
    const v = tables.view,
      off = tables.morx[0];
    const version = v.getUint16(off, false);
    if (version !== 2 && version !== 3) return; // 2 = morx; (1 = legacy 'mort', different)
    this._off = off;
  }

  get hasMorx() {
    return this._off >= 0;
  }

  /// Apply the default-on morx chains to a glyph-id array IN LOGICAL
  /// ORDER. Returns { gids, src } where `gids` is the shaped glyph array
  /// (length may shrink via ligatures / grow via insertion) and `src[i]`
  /// is the index INTO THE INPUT `gids` that output glyph i derives from
  /// (a ligature inherits its first component's source index; an inserted
  /// glyph inherits its neighbor's). Lets the caller rebuild parallel
  /// per-glyph data (codepoint, font, cluster) after shaping. The input
  /// array is not mutated.
  apply(gids, rtl = false) {
    if (this._off < 0 || gids.length === 0)
      return { gids: gids.slice(), src: gids.map((_, i) => i) };
    const v = this._view;
    let glyphs = gids.slice();
    let src = gids.map((_, i) => i);
    const nChains = v.getUint32(this._off + 4, false);
    let p = this._off + 8;
    for (let c = 0; c < nChains; c++) {
      const defaultFlags = v.getUint32(p, false);
      const chainLength = v.getUint32(p + 4, false);
      if (chainLength < 16) break; // malformed: the walk would not advance, up to 2^32 times
      const nFeatures = v.getUint32(p + 8, false);
      const nSubtables = v.getUint32(p + 12, false);
      let q = p + 16 + nFeatures * 12; // skip the feature array
      for (let s = 0; s < nSubtables; s++) {
        const length = v.getUint32(q, false);
        if (length < 12) break; // malformed: see above
        const coverage = v.getUint32(q + 4, false);
        const subFeatureFlags = v.getUint32(q + 8, false);
        const type = coverage & 0xff;
        // Only apply subtables enabled by the chain's default flags.
        if ((subFeatureFlags & defaultFlags) !== 0) {
          // bit 31 = vertical-only (skip in horizontal text). bit 30 =
          // descending order. bit 28 = the subtable expects LOGICAL order;
          // without it the stream is in visual order, which for right-to-left
          // text is the logical stream reversed (Apple's morx specification;
          // HarfBuzz and CoreText agree). The state machine always walks
          // forward over a stream reversed up front when it must be.
          const vertical = (coverage & 0x80000000) !== 0;
          const descending = (coverage & 0x40000000) !== 0;
          const logical = (coverage & 0x10000000) !== 0;
          const reverse = logical ? descending : descending !== rtl;
          if (!vertical) {
            if (reverse) {
              glyphs.reverse();
              src.reverse();
            }
            this._applySubtable(type, q + 12, glyphs, src, false);
            if (reverse) {
              glyphs.reverse();
              src.reverse();
            }
          }
        }
        q += length;
      }
      p += chainLength;
    }
    // Strip any deleted-glyph markers ligature/contextual passes left.
    const outGids = [],
      outSrc = [];
    for (let i = 0; i < glyphs.length; i++) {
      if (glyphs[i] === DELETED_GLYPH) continue;
      outGids.push(glyphs[i]);
      outSrc.push(src[i]);
    }
    return { gids: outGids, src: outSrc };
  }

  _applySubtable(type, off, glyphs, src, reverse) {
    switch (type) {
      case 0:
        _rearrangeHandler.src = src;
        return this._stateMachine(off, glyphs, reverse, _rearrangeHandler);
      case 1:
        return this._stateMachine(off, glyphs, reverse, _contextualHandler(this, off));
      case 2:
        return this._stateMachine(off, glyphs, reverse, _ligatureHandler(this, off));
      case 4:
        return this._noncontextual(off, glyphs);
      case 5: {
        const v = this._view,
          nClasses = v.getUint32(off, false);
        const classOff = off + v.getUint32(off + 4, false);
        runAatInsertion(
          v,
          {
            nClasses,
            stateOff: off + v.getUint32(off + 8, false),
            entryOff: off + v.getUint32(off + 12, false),
            actionOff: off + v.getUint32(off + 16, false),
            classOf: (gid) => _classOf(v, classOff, gid, this._numGlyphs, nClasses),
          },
          glyphs,
          src,
          reverse,
        );
        return glyphs;
      }
      default:
        return glyphs;
    }
  }

  // ---- type 4: noncontextual (flat lookup glyph → glyph) ----
  _noncontextual(off, glyphs) {
    for (let i = 0; i < glyphs.length; i++) {
      if (glyphs[i] === DELETED_GLYPH) continue;
      const sub = aatLookup(this._view, off, glyphs[i], this._numGlyphs);
      if (sub >= 0) glyphs[i] = sub;
    }
    return glyphs;
  }

  // ---- shared extended state-machine driver ----
  //
  // The STX header is { nClasses u32, classTableOffset u32,
  // stateArrayOffset u32, entryTableOffset u32 } (offsets from the
  // subtable start = `off`). `handler` is called per (entry, index) and
  // returns the next array index to advance to (or drives mutations via
  // closures). Returns the (possibly mutated) glyph array.
  _stateMachine(off, glyphs, reverse, handler) {
    const v = this._view;
    const nClasses = v.getUint32(off, false);
    const classOff = off + v.getUint32(off + 4, false);
    const stateOff = off + v.getUint32(off + 8, false);
    const entryOff = off + v.getUint32(off + 12, false);
    handler.init && handler.init(nClasses, classOff, stateOff, entryOff);

    let state = STATE_START_OF_TEXT;
    const n = glyphs.length;
    let i = reverse ? n - 1 : 0;
    const step = reverse ? -1 : 1;
    // The driver visits each glyph once, plus a final end-of-text tick.
    let guard = 0;
    const guardMax = n * 4 + 256; // generous bound against malformed loops
    while (guard++ < guardMax) {
      // Live length: insertion entries grow the array mid-walk.
      const atEnd = reverse ? i < 0 : i >= glyphs.length;
      let cls;
      if (atEnd) cls = CLASS_END_OF_TEXT;
      else {
        const g = glyphs[i];
        cls =
          g === DELETED_GLYPH
            ? CLASS_DELETED_GLYPH
            : _classOf(v, classOff, g, this._numGlyphs, nClasses);
      }
      // state row: nClasses entries (u16 entry index) per state.
      const entryIdx = v.getUint16(stateOff + (state * nClasses + cls) * 2, false);
      const eOff = entryOff + entryIdx * _entrySize(handler.kind);
      const newState = v.getUint16(eOff, false);
      const flags = v.getUint16(eOff + 2, false);
      const advance = handler.entry(glyphs, i, eOff, flags, atEnd);
      state = newState;
      // An entry that inserted glyphs at-or-before the cursor reports the
      // shift here so the same logical glyph stays current (inserted
      // glyphs are never reprocessed).
      if (handler.pendingShift) {
        i += handler.pendingShift;
        handler.pendingShift = 0;
      }
      if (atEnd) break;
      // `advance` true = consume current glyph (move to next); false =
      // don't advance (the entry reprocesses with the new state).
      if (advance) i += step;
      // Safety: if a non-advancing entry also didn't change state, bail.
    }
    return handler.finish ? handler.finish(glyphs) : glyphs;
  }
}

// Entry record size per machine kind (newState u16 + flags u16 + extra).
function _entrySize(kind) {
  switch (kind) {
    case 'ligature':
      return 6; // + ligActionIndex u16
    case 'contextual':
      return 8; // + markIndex u16 + currentIndex u16
    case 'insertion':
      return 8; // + currentInsertIndex u16 + markedInsertIndex u16
    default:
      return 4; // rearrangement: newState + flags only
  }
}

// ── type 2: ligature ──────────────────────────────────────────────────
// Ligature entry flags (extended morx): bit15 push the current glyph on
// the component stack, bit14 leave the glyph pointer in place, bit13 run
// the ligature action at this entry's ligActionIndex.
const LIG_SET_COMPONENT = 0x8000;
const LIG_DONT_ADVANCE = 0x4000;
const LIG_PERFORM_ACTION = 0x2000;
function _ligatureHandler(self, subOff) {
  const v = self._view;
  let ligActionOff = 0,
    componentOff = 0,
    ligatureOff = 0;
  const stack = []; // indices into `glyphs` of pushed components
  return {
    kind: 'ligature',
    init(nClasses, classOff, stateOff, entryOff) {
      // After the 4-word STX header, ligature subtables add three more
      // offsets: ligActionOffset, componentOffset, ligatureOffset.
      ligActionOff = subOff + v.getUint32(subOff + 16, false);
      componentOff = subOff + v.getUint32(subOff + 20, false);
      ligatureOff = subOff + v.getUint32(subOff + 24, false);
    },
    entry(glyphs, i, eOff, flags, atEnd) {
      if (flags & LIG_SET_COMPONENT && !atEnd) stack.push(i);
      if (flags & LIG_PERFORM_ACTION) {
        const actionIndex = v.getUint16(eOff + 4, false);
        _performLigAction(
          v,
          glyphs,
          stack,
          actionIndex,
          ligActionOff,
          componentOff,
          ligatureOff,
          self._numGlyphs,
        );
      }
      return (flags & LIG_DONT_ADVANCE) === 0;
    },
    finish(glyphs) {
      return glyphs;
    },
  };
}

function _performLigAction(
  v,
  glyphs,
  stack,
  actionIndex,
  ligActionOff,
  componentOff,
  ligatureOff,
  numGlyphs,
) {
  let aOff = ligActionOff + actionIndex * 4;
  let ligIndexAccum = 0;
  const consumed = []; // stack positions consumed by this ligature
  let sp = stack.length;
  while (true) {
    const action = v.getUint32(aOff, false);
    aOff += 4;
    const last = (action & 0x80000000) !== 0;
    const store = (action & 0x40000000) !== 0;
    // Sign-extend the low 30 bits.
    let offset = action & 0x3fffffff;
    if (offset & 0x20000000) offset -= 0x40000000;
    if (sp <= 0) break;
    const compGlyphPos = stack[--sp];
    consumed.push(compGlyphPos);
    const compGid = glyphs[compGlyphPos];
    // component table is a u16 array indexed by (compGid + offset).
    const compIndex = (compGid + offset) & 0xffff;
    const ligComponentVal = v.getUint16(componentOff + compIndex * 2, false);
    ligIndexAccum += ligComponentVal;
    if (last || store) {
      const ligGlyph = v.getUint16(ligatureOff + ligIndexAccum * 2, false);
      // Emit ligature at the LAST (lowest-position) consumed slot;
      // delete the others. consumed is in pop order (most-recent first);
      // the earliest logical component is the smallest position.
      let minPos = consumed[0];
      for (const p of consumed) if (p < minPos) minPos = p;
      for (const p of consumed) glyphs[p] = DELETED_GLYPH;
      glyphs[minPos] = ligGlyph;
      // The ligature itself becomes a component for further chaining:
      // push its slot back so subsequent actions can extend it.
      stack.length = sp;
      stack.push(minPos);
      ligIndexAccum = 0;
      consumed.length = 0;
    }
    if (last) break;
  }
}

// ── type 1: contextual (per-entry substitution) ───────────────────────
const CTX_SET_MARK = 0x8000;
const CTX_DONT_ADVANCE = 0x4000;
function _contextualHandler(self, subOff) {
  const v = self._view;
  let substTableOff = 0;
  let markIdx = -1;
  return {
    kind: 'contextual',
    init() {
      // Extended contextual adds substitutionTableOffset after the
      // 4-word STX header.
      substTableOff = subOff + v.getUint32(subOff + 16, false);
    },
    entry(glyphs, i, eOff, flags, atEnd) {
      const markIndex = v.getUint16(eOff + 4, false);
      const currentIndex = v.getUint16(eOff + 6, false);
      if (currentIndex !== 0xffff && !atEnd) {
        const g = _ctxSubst(v, substTableOff, currentIndex, glyphs[i], self._numGlyphs);
        if (g >= 0) glyphs[i] = g;
      }
      if (markIndex !== 0xffff && markIdx >= 0) {
        const g = _ctxSubst(v, substTableOff, markIndex, glyphs[markIdx], self._numGlyphs);
        if (g >= 0) glyphs[markIdx] = g;
      }
      if (flags & CTX_SET_MARK && !atEnd) markIdx = i;
      return (flags & CTX_DONT_ADVANCE) === 0;
    },
    finish(glyphs) {
      return glyphs;
    },
  };
}

// Contextual substitution tables are an array of per-"index" AAT lookup
// tables. substTableOff points at u32 offsets[]; offsets[tableIndex]
// locates a lookup that maps the input glyph → output glyph.
function _ctxSubst(v, substTableOff, tableIndex, gid, numGlyphs) {
  const lookupOff = substTableOff + v.getUint32(substTableOff + tableIndex * 4, false);
  return aatLookup(v, lookupOff, gid, numGlyphs);
}

// ── type 0: rearrangement ─────────────────────────────────────────────
const REARR_MARK_FIRST = 0x8000;
const REARR_DONT_ADVANCE = 0x4000;
const REARR_MARK_LAST = 0x2000;
const _rearrangeState = { first: -1, last: -1 };
const _rearrangeHandler = {
  kind: 'rearrangement',
  init() {
    _rearrangeState.first = -1;
    _rearrangeState.last = -1;
  },
  entry(glyphs, i, eOff, flags, atEnd) {
    if (flags & REARR_MARK_FIRST && !atEnd) _rearrangeState.first = i;
    if (flags & REARR_MARK_LAST && !atEnd) _rearrangeState.last = i;
    const verb = flags & 0x000f;
    if (verb !== 0 && _rearrangeState.first >= 0 && _rearrangeState.last >= _rearrangeState.first) {
      _rearrange(glyphs, _rearrangeHandler.src, _rearrangeState.first, _rearrangeState.last, verb);
    }
    return (flags & REARR_DONT_ADVANCE) === 0;
  },
  finish(glyphs) {
    return glyphs;
  },
};

// Apply one of the AAT rearrangement verbs to glyphs[first..last],
// keeping the parallel src array in the same order.
function _rearrange(glyphs, src, first, last, verb) {
  const order = _rearrangeOrder(last - first + 1, verb);
  if (!order) return;
  const gSeg = order.map((k) => glyphs[first + k]);
  const sSeg = src ? order.map((k) => src[first + k]) : null;
  for (let k = 0; k < gSeg.length; k++) {
    glyphs[first + k] = gSeg[k];
    if (sSeg) src[first + k] = sSeg[k];
  }
}

// AAT glyph-rearrangement verb table (Apple "Glyph Metamorphosis").
// The marked range is conceptually AB x CD — A,B the first two glyphs,
// C,D the last two, x the middle. Returns the output permutation of
// [0..len) for the verb, or null (identity / range too short).
function _rearrangeOrder(len, verb) {
  if (verb === 0 || len < 1) return null;
  const id = Array.from({ length: len }, (_, k) => k);
  const A = 0,
    B = 1,
    C = len - 2,
    D = len - 1;
  const M = (a, b) => id.slice(a, b); // middle slice helper
  switch (verb) {
    case 1:
      return [...M(1, len), A]; // Ax → xA
    case 2:
      return [D, ...M(0, len - 1)]; // xD → Dx
    case 3:
      return len >= 2 ? [D, ...M(1, len - 1), A] : null; // AxD → DxA
    case 4:
      return len >= 2 ? [...M(2, len), A, B] : null; // ABx → xAB
    case 5:
      return len >= 2 ? [...M(2, len), B, A] : null; // ABx → xBA
    case 6:
      return len >= 2 ? [C, D, ...M(0, len - 2)] : null; // xCD → CDx
    case 7:
      return len >= 2 ? [D, C, ...M(0, len - 2)] : null; // xCD → DCx
    case 8:
      return len >= 3 ? [C, D, ...M(1, len - 2), A] : null; // AxCD → CDxA
    case 9:
      return len >= 3 ? [D, C, ...M(1, len - 2), A] : null; // AxCD → DCxA
    case 10:
      return len >= 3 ? [D, ...M(2, len - 1), A, B] : null; // ABxD → DxAB
    case 11:
      return len >= 3 ? [D, ...M(2, len - 1), B, A] : null; // ABxD → DxBA
    case 12:
      return len >= 4 ? [C, D, ...M(2, len - 2), A, B] : null; // ABxCD → CDxAB
    case 13:
      return len >= 4 ? [C, D, ...M(2, len - 2), B, A] : null; // ABxCD → CDxBA
    case 14:
      return len >= 4 ? [D, C, ...M(2, len - 2), A, B] : null; // ABxCD → DCxAB
    case 15:
      return len >= 4 ? [D, C, ...M(2, len - 2), B, A] : null; // ABxCD → DCxBA
    default:
      return null;
  }
}

// ── glyph → class via the state table's class lookup ──────────────────
function _classOf(v, classOff, gid, numGlyphs, nClasses) {
  const cls = aatLookup(v, classOff, gid, numGlyphs);
  if (cls < 0) return CLASS_OUT_OF_BOUNDS;
  return cls;
}

// The AAT Lookup table (glyph → value) lives in ./aatLookup.js,
// imported above and shared with mort + kerx.

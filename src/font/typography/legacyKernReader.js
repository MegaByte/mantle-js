// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// legacyKernReader.js — fallback for fonts (Arial, TNR, Verdana) whose
// kerning lives in the pre-OpenType 'kern' table rather than GPOS.

export class LegacyKernReader {
  constructor(tables) {
    this._view = tables.view;
    this._pairs = []; // array of { baseOff, count } for format-0 subtables
    this._states = []; // Apple format-1 state-table subtables: { off, crossStream }
    if (!tables.kern) return;
    const o = tables.kern[0];
    const v = tables.view;
    const firstU16 = v.getUint16(o, false);
    let subtableBase, numSubtables, appleHeader;
    if (firstU16 === 0) {
      appleHeader = false;
      numSubtables = v.getUint16(o + 2, false);
      subtableBase = o + 4;
    } else {
      appleHeader = true;
      numSubtables = v.getUint32(o + 4, false);
      subtableBase = o + 8;
    }
    let cursor = subtableBase;
    for (let i = 0; i < numSubtables; i++) {
      if (appleHeader) {
        // Apple 'kern' coverage layout is INVERTED vs the Windows one:
        // format lives in the LOW byte, and bit 15 = kernVertical
        // (horizontal when CLEAR — a typical horizontal fmt-0 subtable
        // has coverage 0x0000).
        const len = v.getUint32(cursor, false);
        if (len < 8) break; // malformed: the walk would parse one subtable numSubtables times
        const coverage = v.getUint16(cursor + 4, false);
        const format = coverage & 0xff;
        const horizontal = (coverage & 0x8000) === 0;
        if (format === 0 && horizontal) this._parseFmt0(cursor + 8);
        else if (format === 1 && horizontal)
          this._states.push({ off: cursor + 8, crossStream: (coverage & 0x4000) !== 0 });
        cursor += len;
      } else {
        const len = v.getUint16(cursor + 2, false);
        if (len < 6) break; // malformed: see above
        const coverage = v.getUint16(cursor + 4, false);
        const format = coverage >> 8;
        const horizontal = (coverage & 0x01) !== 0;
        const minimum = (coverage & 0x02) !== 0;
        if (format === 0 && horizontal && !minimum) this._parseFmt0(cursor + 6);
        cursor += len;
      }
    }
  }

  get hasKerning() {
    return this._pairs.length > 0;
  }

  /// True when the table has Apple format-1 (state machine) subtables: contextual kerning that needs a run-based pass.
  get hasStateKerning() {
    return this._states.length > 0;
  }

  /// Run the format-1 state machines over a glyph run in VISUAL order (the order these tables are written for; right-to-left
  /// text arrives reversed). Returns per-glyph font-unit { xAdvance, xOffset, yOffset } deltas: an ordinary subtable moves
  /// the glyph's advance and offset, a cross-stream one only its vertical offset (0x8000 resets it).
  /// Header from the subtable body: stateSize (classes), classTable, stateArray, entryTable, valueTable, all u16 offsets from
  /// the body. Entries are { newState: byte offset of a state row, flags: 0x8000 push, 0x4000 don't advance, 0x3FFF value
  /// offset }. Values are s16, the low bit marks the last one of a list.
  applyStateKerning(gids) {
    const n = gids.length,
      v = this._view;
    const xAdvance = new Array(n).fill(0),
      xOffset = new Array(n).fill(0),
      yOffset = new Array(n).fill(0);
    for (const st of this._states) {
      const o = st.off;
      const nClasses = v.getUint16(o, false),
        classOff = o + v.getUint16(o + 2, false);
      const stateRel = v.getUint16(o + 4, false),
        entryOff = o + v.getUint16(o + 6, false);
      const valueRel = v.getUint16(o + 8, false);
      const firstGlyph = v.getUint16(classOff, false),
        nGlyphs = v.getUint16(classOff + 2, false);
      let state = 0,
        i = 0,
        guard = 0;
      const stack = [];
      const guardMax = n * 4 + 16;
      while (guard++ < guardMax) {
        const atEnd = i >= n;
        let cls = 0; // end of text
        if (!atEnd) {
          const g = gids[i];
          cls =
            g >= firstGlyph && g - firstGlyph < nGlyphs
              ? v.getUint8(classOff + 4 + g - firstGlyph)
              : 1;
        }
        const entryIdx = v.getUint8(o + stateRel + state * nClasses + cls);
        const e = entryOff + entryIdx * 4;
        const newState = (v.getUint16(e, false) - stateRel) / nClasses;
        const flags = v.getUint16(e + 2, false);
        if (flags & 0x8000 && !atEnd) {
          if (stack.length < 8) stack.push(i);
        }
        const valueOffset = flags & 0x3fff;
        if (valueOffset) {
          let at = o + valueOffset;
          for (let k = stack.length; k > 0; k--) {
            const raw = v.getInt16(at, false);
            at += 2;
            const last = (raw & 1) !== 0,
              val = raw & ~1;
            const idx = stack.pop();
            if (st.crossStream) {
              if (val === -0x8000) yOffset[idx] = 0;
              else yOffset[idx] += val;
            } else {
              xAdvance[idx] += val;
              xOffset[idx] += val;
            }
            if (last) break;
          }
          stack.length = 0;
        }
        state = newState;
        if (atEnd) break;
        if ((flags & 0x4000) === 0) i++;
      }
    }
    return { xAdvance, xOffset, yOffset };
  }

  _parseFmt0(bodyOff) {
    const n = this._view.getUint16(bodyOff, false);
    this._pairs.push({ baseOff: bodyOff + 8, count: n });
  }

  getPairKerning(a, b) {
    let total = 0;
    const key = (a >>> 0) * 0x10000 + b;
    for (const { baseOff, count } of this._pairs) {
      let lo = 0,
        hi = count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = baseOff + mid * 6;
        const left = this._view.getUint16(r, false);
        const right = this._view.getUint16(r + 2, false);
        const mk = left * 0x10000 + right;
        if (mk < key) lo = mid + 1;
        else if (mk > key) hi = mid - 1;
        else {
          total += this._view.getInt16(r + 4, false);
          break;
        }
      }
    }
    return total;
  }
}

// legacyKernReader.js — fallback for fonts (Arial, TNR, Verdana) whose
// kerning lives in the pre-OpenType 'kern' table rather than GPOS.

export class LegacyKernReader {
  constructor(tables) {
    this._view = tables.view;
    this._pairs = [];   // array of { baseOff, count } for format-0 subtables
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
        const coverage = v.getUint16(cursor + 4, false);
        const format = coverage & 0xff;
        const horizontal = (coverage & 0x8000) === 0;
        if (format === 0 && horizontal) this._parseFmt0(cursor + 8);
        cursor += len;
      } else {
        const len = v.getUint16(cursor + 2, false);
        const coverage = v.getUint16(cursor + 4, false);
        const format = coverage >> 8;
        const horizontal = (coverage & 0x01) !== 0;
        const minimum   = (coverage & 0x02) !== 0;
        if (format === 0 && horizontal && !minimum) this._parseFmt0(cursor + 6);
        cursor += len;
      }
    }
  }

  get hasKerning() { return this._pairs.length > 0; }

  _parseFmt0(bodyOff) {
    const n = this._view.getUint16(bodyOff, false);
    this._pairs.push({ baseOff: bodyOff + 8, count: n });
  }

  getPairKerning(a, b) {
    let total = 0;
    const key = ((a >>> 0) * 0x10000) + b;
    for (const { baseOff, count } of this._pairs) {
      let lo = 0, hi = count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = baseOff + mid * 6;
        const left  = this._view.getUint16(r, false);
        const right = this._view.getUint16(r + 2, false);
        const mk = (left * 0x10000) + right;
        if (mk < key) lo = mid + 1;
        else if (mk > key) hi = mid - 1;
        else { total += this._view.getInt16(r + 4, false); break; }
      }
    }
    return total;
  }
}

// charStringInterp.js — Type 2 CharString interpreter.
// Emits segs in OpenType +Y-up coordinates (same as the TT-glyf path).

import { mkLine, mkCubic } from '../../primitives/seg.js';
import { readCffIndexEntry } from './cffReader.js';

function subrBias(n) {
  if (n < 1240) return 107;
  if (n < 33900) return 1131;
  return 32768;
}

export class CharStringInterp {
  /**
   * @param {Uint8Array} bytes
   * @param {number} gsubrIndexOff offset of the Global Subrs INDEX
   * @param {number} lsubrIndexOff offset of the Local Subrs INDEX
   * @param {number} nGlobalSubrs
   * @param {number} nLocalSubrs
   * @param {boolean} [isCff2=false] CFF2 dispatch: no width prefix, no
   *   hint ops, blend/vsindex supported.
   * @param {object} [ivs=null] ItemVariationStore (only consulted when
   *   isCff2 + the charstring uses `blend`).
   * @param {number[]} [varCoords=null] Normalized variation coords for
   *   blend's region scalar.
   */
  constructor(bytes, gsubrIndexOff, lsubrIndexOff, nGlobalSubrs, nLocalSubrs,
              isCff2 = false, ivs = null, varCoords = null) {
    this._b = bytes;
    this._gsubrIndexOff = gsubrIndexOff;
    this._lsubrIndexOff = lsubrIndexOff;
    this._gsubrBias = subrBias(nGlobalSubrs);
    this._lsubrBias = subrBias(nLocalSubrs);
    this._isCff2  = isCff2;
    this._ivs     = ivs;
    this._varCoords = varCoords;
    this._vsindex = 0;
  }

  run(csOff, csLen) {
    this._stack = [];
    this._segs = [];
    this._x = 0; this._y = 0;
    this._moveX = 0; this._moveY = 0;
    this._haveContour = false;
    this._hintCount = 0;
    this._hasHintMaskBeenSeen = false;
    // CFF2 has no width prefix; treat as "already consumed".
    this._gotWidth = this._isCff2;
    this._vsindex = 0;
    this._depth = 0;
    this._ended = false;
    // Set by an endchar seac form (legacy Type 2 accent composition);
    // null otherwise. See the endchar handler for the access limitation.
    this._seac = null;

    this._exec(csOff, csLen);
    // CFF2 has no endchar operator — charstrings terminate when
    // their bytes run out. Emit the implicit closing edge for the
    // final contour ourselves; CFF1's endchar handler does this on
    // its own path.
    if (this._isCff2) this._closePrevious();
    // CFF/PostScript convention is clockwise for outer contours,
    // counter-clockwise for inner (counter) contours. TrueType uses
    // the opposite. The Mantle renderer follows TT convention so
    // we reverse every CFF contour to match.
    this._reverseAllContours();
    return this._segs.length === 0 ? null : this._segs;
  }

  _reverseAllContours() {
    if (this._segs.length < 2) return;
    let contourStart = 0;
    for (let i = 1; i <= this._segs.length; i++) {
      let boundary = i === this._segs.length;
      if (!boundary) {
        const prev = this._segs[i - 1];
        const cur = this._segs[i];
        const prevEnd = endPointOf(prev);
        const curStart = cur.p1;
        boundary = !(Math.abs(prevEnd[0] - curStart[0]) < 1e-9
                  && Math.abs(prevEnd[1] - curStart[1]) < 1e-9);
      }
      if (boundary) {
        this._reverseContour(contourStart, i - 1);
        contourStart = i;
      }
    }
  }

  _reverseContour(firstIdx, lastIdx) {
    const n = lastIdx - firstIdx + 1;
    if (n <= 0) return;
    const rev = new Array(n);
    for (let k = 0; k < n; k++) {
      rev[k] = reverseSeg(this._segs[firstIdx + (n - 1 - k)]);
    }
    for (let k = 0; k < n; k++) this._segs[firstIdx + k] = rev[k];
  }

  _exec(off, len) {
    if (++this._depth > 10) throw new Error('CharString recursion too deep');
    const end = off + len;
    let o = off;
    while (o < end && !this._ended) {
      const b0 = this._b[o++];
      if (b0 >= 32) {
        if (b0 <= 246)         this._stack.push(b0 - 139);
        else if (b0 <= 250)    this._stack.push((b0 - 247) * 256 + this._b[o++] + 108);
        else if (b0 <= 254)    this._stack.push(-((b0 - 251) * 256) - this._b[o++] - 108);
        else /* 255 */         { const hi = signed16((this._b[o] << 8) | this._b[o + 1]); o += 4; this._stack.push(hi); }
      } else if (b0 === 28) {
        this._stack.push(signed16((this._b[o] << 8) | this._b[o + 1])); o += 2;
      } else {
        let op = b0;
        if (b0 === 12) op = 12 * 256 + this._b[o++];
        const st = this._stack;
        switch (op) {
          case 0x17:  // CFF1: vstem3; CFF2: blend (opcode 23)
            if (this._isCff2) { this._doBlend(); break; }
            this._consumeMaybeWidthHint();
            this._hintCount += (st.length >> 1);
            st.length = 0;
            break;
          case 0x01: case 0x03: case 0x12:
            if (this._isCff2)
              throw new Error('CFF2 charstring uses hint operator 0x' + op.toString(16) + ' — malformed');
            this._consumeMaybeWidthHint();
            this._hintCount += (st.length >> 1);
            st.length = 0;
            break;
          case 0x13: case 0x14: {
            if (this._isCff2)
              throw new Error('CFF2 charstring uses hintmask/cntrmask — malformed');
            this._consumeMaybeWidthHint();
            this._hintCount += (st.length >> 1);
            st.length = 0;
            const maskBytes = (this._hintCount + 7) >> 3;
            o += maskBytes;
            this._hasHintMaskBeenSeen = true;
            break;
          }
          case 0x0F:  // vsindex (CFF2 only)
            if (!this._isCff2) { st.length = 0; break; }
            if (st.length > 0) this._vsindex = st[st.length - 1] | 0;
            st.length = 0;
            break;
          case 0x15: // rmoveto
            this._consumeMaybeWidth(2);
            this._closePrevious();
            this._x += st[0]; this._y += st[1];
            this._emitMove();
            st.length = 0;
            break;
          case 0x04: // vmoveto
            this._consumeMaybeWidth(1);
            this._closePrevious();
            this._y += st[0]; this._emitMove();
            st.length = 0;
            break;
          case 0x16: // hmoveto
            this._consumeMaybeWidth(1);
            this._closePrevious();
            this._x += st[0]; this._emitMove();
            st.length = 0;
            break;
          case 0x05: { // rlineto
            for (let i = 0; i + 1 < st.length; i += 2) {
              this._emitLine(this._x + st[i], this._y + st[i + 1]);
            }
            st.length = 0;
            break;
          }
          case 0x06: this._hOrVLineto(true); break;
          case 0x07: this._hOrVLineto(false); break;
          case 0x08: { // rrcurveto
            for (let i = 0; i + 5 < st.length; i += 6) {
              this._emitCurve(st[i], st[i + 1], st[i + 2], st[i + 3], st[i + 4], st[i + 5]);
            }
            st.length = 0;
            break;
          }
          case 0x18: { // rcurveline
            let i = 0;
            while (i + 7 < st.length) {
              this._emitCurve(st[i], st[i + 1], st[i + 2], st[i + 3], st[i + 4], st[i + 5]);
              i += 6;
            }
            this._emitLine(this._x + st[i], this._y + st[i + 1]);
            st.length = 0;
            break;
          }
          case 0x19: { // rlinecurve
            let i = 0;
            while (i + 7 < st.length) {
              this._emitLine(this._x + st[i], this._y + st[i + 1]);
              i += 2;
            }
            this._emitCurve(st[i], st[i + 1], st[i + 2], st[i + 3], st[i + 4], st[i + 5]);
            st.length = 0;
            break;
          }
          case 0x1A: this._vvCurveTo(); break;
          case 0x1B: this._hhCurveTo(); break;
          case 0x1E: this._alternatingCurve(true); break;
          case 0x1F: this._alternatingCurve(false); break;
          // ---- Two-byte (0x0C-prefixed) flex operators ----
          // Each emits exactly two cubic curves; the two curves are
          // accumulated relative to the pen the same way _emitCurve does,
          // so the output is byte-identical to the equivalent rrcurveto.
          // (op = 12*256 + low byte; flex's `fd` flex-depth operand is
          //  cosmetic and ignored, matching common interpreters.)
          case 0x0C22: this._hflex();  break; // 12 34: hflex
          case 0x0C23: this._flex();   break; // 12 35: flex
          case 0x0C24: this._hflex1(); break; // 12 36: hflex1
          case 0x0C25: this._flex1();  break; // 12 37: flex1
          case 0x0A: { // callsubr
            const idx = st[st.length - 1] + this._lsubrBias;
            st.pop();
            if (this._lsubrIndexOff < 0) throw new Error('callsubr without local subrs');
            const r = readCffIndexEntry(this._b, this._lsubrIndexOff, idx);
            this._exec(r.off, r.len);
            break;
          }
          case 0x1D: { // callgsubr
            const idx = st[st.length - 1] + this._gsubrBias;
            st.pop();
            const r = readCffIndexEntry(this._b, this._gsubrIndexOff, idx);
            this._exec(r.off, r.len);
            break;
          }
          case 0x0B: this._depth--; return;          // return
          case 0x0E:
            // CFF1: endchar. CFF2: reserved — we treat it leniently
            // as an implicit end (some authoring tools emit it).
            //
            // Legacy Type 2 `seac` form: `adx ady bchar achar endchar`
            // (optionally width-prefixed → 4 or 5 operands). It composes
            // a base glyph (bchar) and an accent (achar), addressed by
            // StandardEncoding code, offset by (adx,ady). We record the
            // parameters on `this._seac`; the actual base+accent composition
            // happens in CffReader.readGlyph (via _composeSeac), where the
            // charset + CharStrings INDEX needed to resolve the codes to GIDs
            // and re-run their charstrings are available. The interpreter only
            // sees one glyph's bytes, so it cannot compose here.
            if (!this._gotWidth && (this._stack.length === 4 || this._stack.length === 5)) {
              // 5 operands ⇒ leading width override; drop it.
              if (this._stack.length === 5) this._stack.shift();
            }
            if (this._stack.length === 4) {
              this._seac = {
                adx: st[0], ady: st[1], bchar: st[2] | 0, achar: st[3] | 0,
              };
            }
            this._closePrevious(); this._ended = true; this._depth--; return;
          default:
            st.length = 0;
            break;
        }
      }
    }
    this._depth--;
  }

  _consumeMaybeWidth(nominalArgs) {
    if (this._gotWidth) return;
    this._gotWidth = true;
    if (this._stack.length > nominalArgs) this._stack.shift();
  }
  _consumeMaybeWidthHint() {
    if (this._gotWidth) return;
    this._gotWidth = true;
    if (this._stack.length & 1) this._stack.shift();
  }

  /// CFF2 blend operator (opcode 23, 0x17). Spec § Type 2 §3.1:
  ///   ... v1 v2 ... vN  dv1_r1 dv1_r2 ... dv1_rK
  ///                     dv2_r1 ...      dv2_rK
  ///                     ...
  ///                     dvN_r1 ...      dvN_rK
  ///                     N  blend
  /// → leaves N values on the stack: v_i + Σ_r (scalar_r × dv_i_r)
  /// where K = regionIndexCount for the current vsindex subtable.
  /// When the font has no IVS (blend with empty IVS), the operator
  /// degenerates to a pass-through of the N defaults.
  _doBlend() {
    const st = this._stack;
    if (st.length === 0) return;
    const n = st.pop() | 0;
    if (n <= 0) return;
    // Region count K. When the IVS has no subtable for this vsindex,
    // assume K = 0 (no-op blend; defaults pass through).
    const k = this._ivs ? this._ivs.regionIndexCount(this._vsindex) : 0;
    const totalDeltas = n * k;
    if (st.length < n + totalDeltas) {
      // Malformed; just discard deltas + leave whatever defaults remain.
      st.length = Math.max(0, st.length - totalDeltas);
      return;
    }
    // Deltas are stored row-major: dv1_r1..dv1_rK, dv2_r1..dv2_rK, ...
    // (i.e. all K deltas for value 1, then all K for value 2, ...).
    // Stack layout: [..., v1, v2, ..., vN, d1_1, d1_2, ..., dN_K]
    const defaultsBase = st.length - n - totalDeltas;
    const deltasBase   = st.length - totalDeltas;
    if (k === 0) {
      // No regions; defaults already on stack — nothing to blend.
      return;
    }
    // When no coords are supplied, the blend resolves to defaults
    // (all region scalars = 0). Drop the deltas without applying.
    if (this._varCoords == null) {
      st.length = defaultsBase + n;
      return;
    }
    // Precompute region scalars once per blend call.
    const scalars = new Array(k);
    for (let r = 0; r < k; r++) {
      scalars[r] = this._ivs.regionScalarFor(this._vsindex, r, this._varCoords);
    }
    for (let i = 0; i < n; i++) {
      let blended = st[defaultsBase + i];
      for (let r = 0; r < k; r++) {
        const s = scalars[r];
        if (s !== 0) blended += s * st[deltasBase + i * k + r];
      }
      st[defaultsBase + i] = blended;
    }
    // Drop the deltas.
    st.length = defaultsBase + n;
  }

  _emitMove() { this._moveX = this._x; this._moveY = this._y; this._haveContour = true; }
  _closePrevious() {
    // Type 2 implicitly closes contours at the next moveto / endchar.
    // ray-cast needs the closing edge as an explicit seg.
    // CRITICAL: do NOT reset _x/_y to _moveX/_moveY — CFF moveto
    // deltas are relative to the last DRAWN position, not the
    // contour-start anchor.
    if (!this._haveContour) return;
    if (this._x === this._moveX && this._y === this._moveY) return;
    this._segs.push(mkLine([this._x, this._y], [this._moveX, this._moveY]));
  }
  _emitLine(nx, ny) { this._segs.push(mkLine([this._x, this._y], [nx, ny])); this._x = nx; this._y = ny; }
  _emitCurve(dxa, dya, dxb, dyb, dxc, dyc) {
    const x1 = this._x + dxa, y1 = this._y + dya;
    const x2 = x1 + dxb,      y2 = y1 + dyb;
    const x3 = x2 + dxc,      y3 = y2 + dyc;
    this._segs.push(mkCubic([this._x, this._y], [x1, y1], [x2, y2], [x3, y3]));
    this._x = x3; this._y = y3;
  }

  _hOrVLineto(horizontalFirst) {
    const st = this._stack;
    for (let i = 0; i < st.length; i++) {
      const horizontal = (i % 2 === 0) ? horizontalFirst : !horizontalFirst;
      let nx = this._x, ny = this._y;
      if (horizontal) nx += st[i]; else ny += st[i];
      this._emitLine(nx, ny);
    }
    st.length = 0;
  }
  _vvCurveTo() {
    const st = this._stack;
    let i = 0, dx1 = 0;
    if (st.length & 1) { dx1 = st[i++]; }
    while (i + 3 < st.length) {
      this._emitCurve(dx1, st[i], st[i + 1], st[i + 2], 0, st[i + 3]);
      dx1 = 0; i += 4;
    }
    st.length = 0;
  }
  _hhCurveTo() {
    const st = this._stack;
    let i = 0, dy1 = 0;
    if (st.length & 1) { dy1 = st[i++]; }
    while (i + 3 < st.length) {
      this._emitCurve(st[i], dy1, st[i + 1], st[i + 2], st[i + 3], 0);
      dy1 = 0; i += 4;
    }
    st.length = 0;
  }
  _alternatingCurve(startVertical) {
    const st = this._stack;
    let i = 0;
    let vertical = startVertical;
    while (i + 3 < st.length) {
      const extra = (i + 4 === st.length - 1) ? 1 : 0;
      const dxa = vertical ? 0     : st[i];
      const dya = vertical ? st[i] : 0;
      const dxb = st[i + 1];
      const dyb = st[i + 2];
      let dxc, dyc;
      if (vertical) { dxc = st[i + 3]; dyc = extra ? st[i + 4] : 0; }
      else          { dxc = extra ? st[i + 4] : 0; dyc = st[i + 3]; }
      this._emitCurve(dxa, dya, dxb, dyb, dxc, dyc);
      i += 4 + extra;
      vertical = !vertical;
    }
    st.length = 0;
  }

  // ---- Flex operators (Type 2 spec, TN #5177 §4.3) ----------------
  // All four collapse a flex hint into two cubic Bezier curves. Control
  // points are emitted via _emitCurve so the math (and rounding, which
  // is none — we keep doubles like rrcurveto) is identical to the plain
  // rrcurveto path. The trailing flex-depth operand (`fd` in flex) is a
  // hinting hint only and does not affect the outline, so we ignore it.

  // flex: dx1 dy1 dx2 dy2 dx3 dy3 dx4 dy4 dx5 dy5 dx6 dy6 fd
  // Two curves with fully-specified deltas; fd (13th arg) ignored.
  _flex() {
    const st = this._stack;
    this._emitCurve(st[0], st[1], st[2], st[3], st[4], st[5]);
    this._emitCurve(st[6], st[7], st[8], st[9], st[10], st[11]);
    st.length = 0;
  }

  // hflex: dx1 dx2 dy2 dx3 dx4 dx5 dx6
  // Curve1 starts/ends horizontal (dy1=0, dy3=0); curve2 returns to the
  // original y (dy4=0, dy5=-dy2, dy6=0).
  _hflex() {
    const st = this._stack;
    const dx1 = st[0], dx2 = st[1], dy2 = st[2], dx3 = st[3];
    const dx4 = st[4], dx5 = st[5], dx6 = st[6];
    this._emitCurve(dx1, 0, dx2, dy2, dx3, 0);
    this._emitCurve(dx4, 0, dx5, -dy2, dx6, 0);
    st.length = 0;
  }

  // hflex1: dx1 dy1 dx2 dy2 dx3 dx4 dx5 dy5 dx6
  // Like hflex but with vertical components on the start of curve1 and
  // the middle of curve2. The final dy6 is chosen so the flex returns to
  // the starting y: dy6 = -(dy1 + dy2 + dy5).
  _hflex1() {
    const st = this._stack;
    const dx1 = st[0], dy1 = st[1], dx2 = st[2], dy2 = st[3], dx3 = st[4];
    const dx4 = st[5], dx5 = st[6], dy5 = st[7], dx6 = st[8];
    this._emitCurve(dx1, dy1, dx2, dy2, dx3, 0);
    this._emitCurve(dx4, 0, dx5, dy5, dx6, -(dy1 + dy2 + dy5));
    st.length = 0;
  }

  // flex1: dx1 dy1 dx2 dy2 dx3 dy3 dx4 dy4 dx5 dy5 d6
  // Curve1 fully specified. For curve2 the last delta uses the single d6
  // operand on the dominant axis (the axis with the larger total span);
  // the other axis is closed so the flex returns to the start coordinate.
  _flex1() {
    const st = this._stack;
    const dx1 = st[0], dy1 = st[1], dx2 = st[2], dy2 = st[3], dx3 = st[4], dy3 = st[5];
    const dx4 = st[6], dy4 = st[7], dx5 = st[8], dy5 = st[9], d6 = st[10];
    const dx = dx1 + dx2 + dx3 + dx4 + dx5;
    const dy = dy1 + dy2 + dy3 + dy4 + dy5;
    let dx6, dy6;
    if (Math.abs(dx) > Math.abs(dy)) { dx6 = d6;   dy6 = -dy; }
    else                            { dx6 = -dx;  dy6 = d6;  }
    this._emitCurve(dx1, dy1, dx2, dy2, dx3, dy3);
    this._emitCurve(dx4, dy4, dx5, dy5, dx6, dy6);
    st.length = 0;
  }
}

function signed16(v) { return v >= 0x8000 ? v - 0x10000 : v; }

function endPointOf(s) {
  if (s.type === 0) return s.p2;        // Line
  if (s.type === 1) return s.p3;        // Quad
  if (s.type === 2) return s.p4;        // Cubic
  return s.p2;
}

function reverseSeg(s) {
  if (s.type === 0) return mkLine(s.p2, s.p1);
  if (s.type === 2) return mkCubic(s.p4, s.p3, s.p2, s.p1);
  return s;  // Quad unused in CFF Type 2 output
}

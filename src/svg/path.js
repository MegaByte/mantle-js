// svg/path.js — SVG `d` attribute → Segment[] parser.
//
// Standalone (no other svg/* deps besides segment factories). Supports
// all SVG 1.1 path commands: M/m, L/l, H/h, V/v, C/c, S/s, Q/q, T/t,
// A/a, Z/z. Smooth-curve reflection for S/s/T/t is gated on the previous
// command being the same family per spec.

import { mkLine, mkQuad, mkCubic, arcToNative } from './segment.js';

/// Tokenise a `d` attribute: command letters become 1-char tokens;
/// numbers (signed, decimal, scientific) become numeric tokens.
/// Whitespace and commas are simply unmatched — `exec()` advances
/// past them automatically — so we don't need a separate
/// comma-to-space pass.
export function tokenizePath(d) {
  const out = [];
  const rx = /[MmZzLlHhVvCcSsQqTtAa]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  let m;
  while ((m = rx.exec(d)) !== null) out.push(m[0]);
  return out;
}

/// Parse an SVG path `d` attribute into a flat segment array. Handles
/// implicit command continuation (a sequence of points after `M`
/// becomes `L`-style lines; after `m`, `l`-style relative lines —
/// SVG path spec §8.3.2). Returns [] on empty input.
export function parsePathD(d) {
  const toks = tokenizePath(d);
  let pos = 0;
  const num = () => parseFloat(toks[pos++]);
  const pt  = () => [num(), num()];

  const segs = [];
  let cur = [0, 0];
  let start = [0, 0];
  let lastCtrl = null;
  let lastCmd = '';
  // Direct char-set check. Tokens are either a single command letter or
  // a number; comparing the first char against the SVG path-d command
  // set is faster than a regex state machine.
  const isCmdChar = (c) =>
    c === 'M' || c === 'm' || c === 'Z' || c === 'z' ||
    c === 'L' || c === 'l' || c === 'H' || c === 'h' ||
    c === 'V' || c === 'v' || c === 'C' || c === 'c' ||
    c === 'S' || c === 's' || c === 'Q' || c === 'q' ||
    c === 'T' || c === 't' || c === 'A' || c === 'a';

  while (pos < toks.length) {
    const tok = toks[pos];
    let cmd;
    if (tok.length === 1 && isCmdChar(tok)) { cmd = tok; pos++; }
    else {
      cmd = lastCmd;
      if (cmd === 'M') cmd = 'L';
      if (cmd === 'm') cmd = 'l';
    }

    if (cmd === 'M' || cmd === 'm') {
      let p = pt();
      if (cmd === 'm') p = [cur[0]+p[0], cur[1]+p[1]];
      cur = p.slice(); start = p.slice();
      lastCtrl = null;
    } else if (cmd === 'Z' || cmd === 'z') {
      if (cur[0] !== start[0] || cur[1] !== start[1])
        segs.push(mkLine(cur, start));
      cur = start.slice();
      lastCtrl = null;
    } else if (cmd === 'L' || cmd === 'l') {
      let p = pt();
      if (cmd === 'l') p = [cur[0]+p[0], cur[1]+p[1]];
      segs.push(mkLine(cur, p));
      cur = p; lastCtrl = null;
    } else if (cmd === 'H') {
      const x = num();
      const p = [x, cur[1]];
      segs.push(mkLine(cur, p)); cur = p; lastCtrl = null;
    } else if (cmd === 'h') {
      const x = num();
      const p = [cur[0]+x, cur[1]];
      segs.push(mkLine(cur, p)); cur = p; lastCtrl = null;
    } else if (cmd === 'V') {
      const y = num();
      const p = [cur[0], y];
      segs.push(mkLine(cur, p)); cur = p; lastCtrl = null;
    } else if (cmd === 'v') {
      const y = num();
      const p = [cur[0], cur[1]+y];
      segs.push(mkLine(cur, p)); cur = p; lastCtrl = null;
    } else if (cmd === 'C' || cmd === 'c') {
      let c1 = pt(), c2 = pt(), p = pt();
      if (cmd === 'c') {
        c1 = [cur[0]+c1[0], cur[1]+c1[1]];
        c2 = [cur[0]+c2[0], cur[1]+c2[1]];
        p  = [cur[0]+p[0],  cur[1]+p[1]];
      }
      segs.push(mkCubic(cur, c1, c2, p));
      lastCtrl = c2; cur = p;
    } else if (cmd === 'S' || cmd === 's') {
      let c2 = pt(), p = pt();
      if (cmd === 's') {
        c2 = [cur[0]+c2[0], cur[1]+c2[1]];
        p  = [cur[0]+p[0],  cur[1]+p[1]];
      }
      const c1 = (lastCmd && /[CcSs]/.test(lastCmd) && lastCtrl)
        ? [2*cur[0]-lastCtrl[0], 2*cur[1]-lastCtrl[1]]
        : cur.slice();
      segs.push(mkCubic(cur, c1, c2, p));
      lastCtrl = c2; cur = p;
    } else if (cmd === 'Q' || cmd === 'q') {
      let c = pt(), p = pt();
      if (cmd === 'q') {
        c = [cur[0]+c[0], cur[1]+c[1]];
        p = [cur[0]+p[0], cur[1]+p[1]];
      }
      segs.push(mkQuad(cur, c, p));
      lastCtrl = c; cur = p;
    } else if (cmd === 'T' || cmd === 't') {
      let p = pt();
      if (cmd === 't') p = [cur[0]+p[0], cur[1]+p[1]];
      const c = (lastCmd && /[QqTt]/.test(lastCmd) && lastCtrl)
        ? [2*cur[0]-lastCtrl[0], 2*cur[1]-lastCtrl[1]]
        : cur.slice();
      segs.push(mkQuad(cur, c, p));
      lastCtrl = c; cur = p;
    } else if (cmd === 'A' || cmd === 'a') {
      const rx = num(), ry = num(), rot = num(), lrg = num()|0, swp = num()|0;
      let p = pt();
      if (cmd === 'a') p = [cur[0]+p[0], cur[1]+p[1]];
      segs.push(arcToNative(cur, rx, ry, rot, lrg, swp, p));
      cur = p; lastCtrl = null;
    } else {
      pos++;
    }
    lastCmd = cmd;
  }
  return segs;
}

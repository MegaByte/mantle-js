// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/path.js — SVG `d` attribute → Segment[] parser.
//
// Standalone (no other svg/* deps besides segment factories). Supports
// all SVG 1.1 path commands: M/m, L/l, H/h, V/v, C/c, S/s, Q/q, T/t,
// A/a, Z/z. Smooth-curve reflection for S/s/T/t is gated on the previous
// command being the same family per spec.

import { mkLine, mkQuad, mkCubic, arcToNative, SEG_CUBIC } from './segment.js';

/// Path data into command letters and number tokens, up to the FIRST error (SVG 2 §9.3.9: a path with an error is
/// rendered up to the last good command). An error is a character that is neither whitespace, a command letter nor
/// the start of a number (an unknown command, a stray word, the `e` of a bare `1e`), or a comma anywhere but between
/// two numbers. The tokens before it are returned, so the command it cut short is incomplete and dropped by the parser.
export function tokenizePath(d) {
  const out = [];
  const text = String(d == null ? '' : d);
  const number = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let afterNumber = false,
    comma = false;
  for (let i = 0; i < text.length;) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) {
      i++;
      continue;
    }
    if (c === 0x2c) {
      // a comma separates two numbers, once
      if (!afterNumber || comma) break;
      comma = true;
      i++;
      continue;
    }
    if ('MmZzLlHhVvCcSsQqTtAa'.indexOf(text[i]) >= 0) {
      if (comma) break;
      out.push(text[i]);
      i++;
      afterNumber = false;
      continue;
    }
    number.lastIndex = i;
    const m = number.exec(text);
    if (!m) break;
    out.push(m[0]);
    i += m[0].length;
    afterNumber = true;
    comma = false;
  }
  return out;
}

/// A `points` list (<polyline>, <polygon>) as numbers, up to the FIRST error, by the SVG number grammar the path data uses: numbers
/// separated by whitespace and/or one comma, a sign or a second `.` starting the next number ("80-10" is 80 and -10, ".5.5" is .5 and .5),
/// an exponent allowed. A character that is not part of a number (a unit as in "80px", a letter), a comma that does not sit between two
/// numbers, or a number glued to a letter ends the list there; the numbers before it are returned.
export function parseNumberList(text) {
  const out = [];
  const s = String(text == null ? '' : text);
  const number = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let afterNumber = false,
    comma = false;
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) {
      i++;
      continue;
    }
    if (c === 0x2c) {
      if (!afterNumber || comma) break;
      comma = true;
      i++;
      continue;
    }
    number.lastIndex = i;
    const m = number.exec(s);
    if (!m) break;
    // a unit or a stray word glued to the number is an error at that number
    const end = i + m[0].length;
    if (end < s.length) {
      const n = s.charCodeAt(end);
      if ((n >= 0x41 && n <= 0x5a) || (n >= 0x61 && n <= 0x7a) || n === 0x25) break;
    }
    out.push(parseFloat(m[0]));
    i = end;
    afterNumber = true;
    comma = false;
  }
  return out;
}

/// Parse an SVG path `d` attribute into a flat segment array. Handles
/// implicit command continuation (a sequence of points after `M`
/// becomes `L`-style lines; after `m`, `l`-style relative lines —
/// SVG path spec §8.3.2). Returns [] on empty input.
export function parsePathD(d) {
  const toks = tokenizePath(d);
  let pos = 0;
  //
  // SVG 1.1 §8.3.9 says a path with an error renders UP TO the error, and this
  // parser already takes that line for a number after `Z` (below). Same rule
  // here: flag exhaustion, and the command that hit it is discarded whole
  // rather than emitted with holes in it.
  let truncated = false;
  const num = () => {
    const t = toks[pos++];
    const v = t === undefined ? NaN : parseFloat(t);
    if (!Number.isFinite(v)) {
      truncated = true;
      return 0;
    }
    return v;
  };
  const pt = () => [num(), num()];

  // SVG 2 §9.3.9: path data must begin with a moveto; one that does not is in error at its first command, so
  // nothing is drawn (not drawn from the origin).
  if (toks[0] !== 'M' && toks[0] !== 'm') return [];
  const segs = [];
  let cur = [0, 0];
  let start = [0, 0];
  let lastCtrl = null;
  let lastCmd = '';
  // Direct char-set check. Tokens are either a single command letter or
  // a number; comparing the first char against the SVG path-d command
  // set is faster than a regex state machine.
  const isCmdChar = (c) =>
    c === 'M' ||
    c === 'm' ||
    c === 'Z' ||
    c === 'z' ||
    c === 'L' ||
    c === 'l' ||
    c === 'H' ||
    c === 'h' ||
    c === 'V' ||
    c === 'v' ||
    c === 'C' ||
    c === 'c' ||
    c === 'S' ||
    c === 's' ||
    c === 'Q' ||
    c === 'q' ||
    c === 'T' ||
    c === 't' ||
    c === 'A' ||
    c === 'a';

  // Arc-flag reader. The SVG grammar defines large-arc/sweep as single
  // characters, so minified paths glue them to the next number
  // ("a5 5 0 0110 10" means flags 0,1 then x=10): peel one leading char
  // off a multi-char token and leave the remainder for the next read.
  // A flag that is not 0 or 1 is an error, like a missing one.
  const flag = () => {
    const t = toks[pos];
    if (t === undefined) {
      pos++;
      truncated = true;
      return 0;
    }
    if (t[0] !== '0' && t[0] !== '1') {
      pos++;
      truncated = true;
      return 0;
    }
    if (t.length === 1) {
      pos++;
      return t === '1' ? 1 : 0;
    }
    toks[pos] = t.slice(1);
    return t[0] === '1' ? 1 : 0;
  };

  let pendingSubStart = true; // the first segment opens a subpath too
  let moveOnly = false; // a moveto with nothing drawn since: a `Z` right after it closes a zero-length subpath
  const zEnds = new Set(); // index of the last segment of every subpath a Z closed

  while (pos < toks.length) {
    const tok = toks[pos];
    let cmd;
    if (tok.length === 1 && isCmdChar(tok)) {
      cmd = tok;
      pos++;
    } else {
      cmd = lastCmd;
      if (cmd === 'M') cmd = 'L';
      if (cmd === 'm') cmd = 'l';
      // A number can only continue a command that consumes numbers. After
      // Z (or before any command) it is a grammar error; stop like the
      // browsers do — render what parsed, never loop on the stuck token.
      if (cmd === 'Z' || cmd === 'z' || cmd === '') break;
    }
    const nBefore = segs.length;

    if (cmd === 'M' || cmd === 'm') {
      let p = pt();
      if (cmd === 'm') p = [cur[0] + p[0], cur[1] + p[1]];
      cur = p.slice();
      start = p.slice();
      lastCtrl = null;
      // An `M` opens a NEW subpath. Record that on whichever segment comes
      // next, because the parse is otherwise flat and the structure is
      // unrecoverable from geometry alone: two subpaths that happen to meet at
      // a point are indistinguishable from one. Downstream (bbox.js's
      // splitSubpathsWithCloseInto) has to close each subpath separately, and
      // guessing from point-coincidence silently merges the two whenever they
      // touch — which changes the SHAPE'S SEGMENT COUNT depending on its
      // geometry, and a shape whose size wobbles pose to pose can't be morphed
      // (buildMorphPlan matches on equal curve length, so it drops to a
      // crossfade). Cost of the fix: one boolean.
      pendingSubStart = true;
      moveOnly = true;
    } else if (cmd === 'Z' || cmd === 'z') {
      if (cur[0] !== start[0] || cur[1] !== start[1]) segs.push(mkLine(cur, start));
      // `M x y Z` is a zero-length CLOSED subpath (SVG 2 stroking): a round or square cap draws it (a lone `M x y` is not
      // stroked). It keeps one zero-length record, as `M x y L x y Z` does, for the stroke build to turn into a dot or box.
      else if (moveOnly) {
        const z = mkLine(cur, start);
        z.fromMoveClose = true;
        segs.push(z);
      }
      if (segs.length) zEnds.add(segs.length - 1);
      cur = start.slice();
      lastCtrl = null;
    } else if (cmd === 'L' || cmd === 'l') {
      let p = pt();
      if (cmd === 'l') p = [cur[0] + p[0], cur[1] + p[1]];
      segs.push(mkLine(cur, p));
      cur = p;
      lastCtrl = null;
    } else if (cmd === 'H') {
      const x = num();
      const p = [x, cur[1]];
      segs.push(mkLine(cur, p));
      cur = p;
      lastCtrl = null;
    } else if (cmd === 'h') {
      const x = num();
      const p = [cur[0] + x, cur[1]];
      segs.push(mkLine(cur, p));
      cur = p;
      lastCtrl = null;
    } else if (cmd === 'V') {
      const y = num();
      const p = [cur[0], y];
      segs.push(mkLine(cur, p));
      cur = p;
      lastCtrl = null;
    } else if (cmd === 'v') {
      const y = num();
      const p = [cur[0], cur[1] + y];
      segs.push(mkLine(cur, p));
      cur = p;
      lastCtrl = null;
    } else if (cmd === 'C' || cmd === 'c') {
      let c1 = pt(),
        c2 = pt(),
        p = pt();
      if (cmd === 'c') {
        c1 = [cur[0] + c1[0], cur[1] + c1[1]];
        c2 = [cur[0] + c2[0], cur[1] + c2[1]];
        p = [cur[0] + p[0], cur[1] + p[1]];
      }
      segs.push(mkCubic(cur, c1, c2, p));
      lastCtrl = c2;
      cur = p;
    } else if (cmd === 'S' || cmd === 's') {
      let c2 = pt(),
        p = pt();
      if (cmd === 's') {
        c2 = [cur[0] + c2[0], cur[1] + c2[1]];
        p = [cur[0] + p[0], cur[1] + p[1]];
      }
      const c1 =
        lastCmd && /[CcSs]/.test(lastCmd) && lastCtrl
          ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]]
          : cur.slice();
      segs.push(mkCubic(cur, c1, c2, p));
      lastCtrl = c2;
      cur = p;
    } else if (cmd === 'Q' || cmd === 'q') {
      let c = pt(),
        p = pt();
      if (cmd === 'q') {
        c = [cur[0] + c[0], cur[1] + c[1]];
        p = [cur[0] + p[0], cur[1] + p[1]];
      }
      segs.push(mkQuad(cur, c, p));
      lastCtrl = c;
      cur = p;
    } else if (cmd === 'T' || cmd === 't') {
      let p = pt();
      if (cmd === 't') p = [cur[0] + p[0], cur[1] + p[1]];
      const c =
        lastCmd && /[QqTt]/.test(lastCmd) && lastCtrl
          ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]]
          : cur.slice();
      segs.push(mkQuad(cur, c, p));
      lastCtrl = c;
      cur = p;
    } else if (cmd === 'A' || cmd === 'a') {
      const rx = num(),
        ry = num(),
        rot = num(),
        lrg = flag(),
        swp = flag();
      let p = pt();
      if (cmd === 'a') p = [cur[0] + p[0], cur[1] + p[1]];
      segs.push(arcToNative(cur, rx, ry, rot, lrg, swp, p));
      cur = p;
      lastCtrl = null;
    } else {
      pos++;
    }
    // Ran out of numbers mid-command: drop the partial command and stop, so
    // what precedes the error still renders (see `truncated` above).
    if (truncated) {
      segs.length = nBefore;
      break;
    }
    // Stamp the subpath-start marker on the first segment this command emitted
    // (an `M` emits none, so the flag rides along to whatever draws next).
    if (pendingSubStart && segs.length > nBefore) {
      segs[nBefore].subStart = true;
      pendingSubStart = false;
    }
    if (segs.length > nBefore) moveOnly = false;
    // SVG 1.1 8.3.3: a command after `Z` other than `M` starts a NEW subpath at the closed subpath's start. The parse is flat, so
    // that boundary rides the next segment's `subStart` (set here, after the `Z`'s own closing line was stamped or not).
    if (cmd === 'Z' || cmd === 'z') {
      pendingSubStart = true;
      moveOnly = false;
    }
    lastCmd = cmd;
  }
  // An OPEN subpath (no Z) keeps its two ends apart however they sit: `M a L b L a` ends in two caps, not a join at a. The geometry cannot say
  // so -- a Z-closed subpath that ends where it began has no closing segment either -- so the last segment of every subpath no Z closed carries
  // `openEnd`, which the stroke pairing reads (textures.js) and nothing else does. A later segment list built from this one without copying the
  // flag simply pairs by coincidence as before.
  for (let i = 0; i < segs.length; i++) {
    if ((i + 1 === segs.length || segs[i + 1].subStart === true) && !zEnds.has(i))
      segs[i].openEnd = true;
  }
  // parsePathD returns the AUTHORED segment structure, one segment per path command. It performs
  // NO geometry-conditional restructuring, so importing the "same" path twice with slightly
  // different geometry always yields the same segment count and types. This is what lets two morph
  // poses correspond: a shape-morph pairs segments positionally and tweens only equal-length
  // ranges, so a per-pose split (a cusp present in one pose, absent in the other) would desync the
  // counts and drop that shape to a crossfade. Cusp handling belongs to the render engines, which
  // do it where it cannot leak into correspondence: GWN splits its own tree pieces, and Loop-Blinn
  // splits cusps in its STATIC mesh builder (buildRims), gated off for morph meshes so both poses
  // keep matched topology. The split itself lives in svg/cubicCusp.js (splitCubicCusps).
  return segs;
}

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// curveToPathD.js — decode a Mantle curve-float buffer back into an SVG
// path `d` string.

// Buffer layout. The per-SHAPE range from `bundle.curveRangesByShape`
// points at the first segment's HEADER texel (the range's `begin`).
// Each segment record is:

const SEG_LINE = 0,
  SEG_QUAD = 1,
  SEG_CUBIC = 2,
  SEG_ARC = 3;
// Pen-continuity tolerance, RELATIVE to the largest coordinate the path has used so far (em): the endpoints that should
// coincide differ only by the float32 round trip (about 6e-8 of their magnitude), so 1e-6 of it is a generous margin at any
// scale. An absolute 1e-4 treated every gap of art authored under ~1e-3 units as a continuation.
const EPS_REL = 1e-6;
// A sweep at or past this is a full revolution, whose endpoints coincide. The
// slack absorbs the float32 round trip the angles have already been through;
// it only has to be smaller than the gap of any arc a caller means to leave
// open, and a 1e-6 rad gap is far below one emitted digit anyway.
const FULL_SWEEP = Math.PI * 2 - 1e-6;

// Four decimals from 1 up, seven significant digits below: the stored values are float32 (24 bits, about 7 digits) so
// the digits follow the magnitude instead of rounding to an absolute 1e-4, which collapsed art authored under ~1e-3 units
// (the same relative-precision rule as the scene serializer, scene/scene.js F()).
function f(n) {
  if (!isFinite(n)) return '0';
  const a = Math.abs(n);
  if (a >= 1) {
    const r = Math.round(n * 1e4) / 1e4;
    return Object.is(r, -0) ? '0' : String(r);
  }
  if (a < 1e-30) return '0';
  const decimals = Math.min(100, 6 - Math.floor(Math.log10(a)));
  let s = n.toFixed(decimals);
  if (s.indexOf('.') >= 0) {
    s = s.replace(/0+$/, '');
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  return s === '-0' ? '0' : s;
}

// One elliptical arc (center form, as Mantle stores it) → SVG endpoint
// form. encodeSeg dropped the large-arc/sweep flags, so recover them
// from the swept angle.
function arcEndpoint(cx, cy, rx, ry, th0, th1, phi) {
  const cp = Math.cos(phi),
    sp = Math.sin(phi);
  const ex = cx + rx * Math.cos(th1) * cp - ry * Math.sin(th1) * sp;
  const ey = cy + rx * Math.cos(th1) * sp + ry * Math.sin(th1) * cp;
  const dth = th1 - th0;
  return {
    ex,
    ey,
    rx,
    ry,
    rot: (phi * 180) / Math.PI,
    largeArc: Math.abs(dth) > Math.PI ? 1 : 0,
    sweep: dth > 0 ? 1 : 0,
  };
}

/**
 * Decode the curve buffer for ONE shape into an SVG `d` string.
 * `beginFloat` is `bundle.curveRangesByShape[i].begin` — it points at
 * the first segment's HEADER texel.
 *
 * @param {ArrayLike<number>} curveF32  whole-bundle curve floats
 * @param {number} beginFloat  range start (first header texel)
 * @param {number} endFloat    range end (exclusive)
 * @returns {string} SVG path `d`
 */
/**
 * @param {Set<number>|null} epArcs  Float offsets of ARC records stored in
 *   ENDPOINT form — (p1.xy, p4.xy), (rx, ry, phi, flags) — rather than center
 *   form. A morph interpolates arcs that way (morphCore.prepareArcMorph), and
 *   this decoder is the one consumer that should NOT be handed center form:
 *   `A rx ry phi large sweep x y` IS endpoint form, so it emits the stored
 *   numbers verbatim. Going via center form would re-derive the arc's endpoints
 *   through a trig round trip, and in float32 they land a hair off the
 *   neighboring segment's endpoint — which the pen-continuity test below then
 *   reads as a subpath break. The contour opens, and the fill loses a wedge.
 *   (The GL walker never notices: it accumulates winding and a sub-pixel gap is
 *   beneath it. Only the path decoder is exact-match sensitive.)
 */
export function curveRangeToPathD(curveF32, beginFloat, endFloat, epArcs = null) {
  let d = '';
  const end = Math.min(endFloat | 0, curveF32.length);
  // Walk header-first from the range start.
  let hdr = beginFloat | 0;
  if (hdr < 0) hdr = 0;

  let penX = NaN,
    penY = NaN; // current point; NaN ⇒ no subpath yet
  let mag = 0; // the largest coordinate magnitude seen (the continuity tolerance's scale)
  let openSubpath = false;
  // Whether the subpath being accumulated ends on a FREE endpoint — an open
  // contour (a checkmark's tick, an L bracket), which must NOT get a `Z`.
  // Closing one strokes a phantom edge back to its start and turns the tick
  // into a triangle. The header's freeEnd bit is the authored answer: a stroke
  // buffer's last segment of an open contour has it set, a closed loop pairs
  // its ends so nothing is free, and a fill-only buffer leaves every bit 0 (so
  // fills still close, as their implicit GL winding does).
  let subpathFree = false;

  while (hdr + 4 <= end) {
    const rawHdr = curveF32[hdr] | 0;
    const segType = rawHdr & 3;
    // Bit 3 = SUBPATH START, the parser's authored marker. Without it a second
    // closed subpath beginning where the first ended looks like the first
    // continuing, and the two merge into one `M ... Z`. That leaves fill alone
    // (the directed edge set is the same) but moves the stroke's caps at the
    // touch point onto a join.
    const subStart = (rawHdr & 8) !== 0;
    const freeEnd = curveF32[hdr + 2] > 0.5;
    const dataAt = hdr + 4;
    if (dataAt + 4 > end + 0) {
      // Not enough room for even a LINE's data — done.
      if (dataAt + 4 > curveF32.length) break;
    }

    let sx, sy, ex, ey, cmd;
    if (segType === SEG_LINE) {
      sx = curveF32[dataAt];
      sy = curveF32[dataAt + 1];
      ex = curveF32[dataAt + 2];
      ey = curveF32[dataAt + 3];
      cmd = `L${f(ex)} ${f(ey)}`;
      hdr = dataAt + 4 + 4; // data(1) + join(1) → next header
    } else if (segType === SEG_QUAD) {
      sx = curveF32[dataAt];
      sy = curveF32[dataAt + 1];
      const c2x = curveF32[dataAt + 2],
        c2y = curveF32[dataAt + 3];
      ex = curveF32[dataAt + 4];
      ey = curveF32[dataAt + 5];
      cmd = `Q${f(c2x)} ${f(c2y)} ${f(ex)} ${f(ey)}`;
      hdr = dataAt + 8 + 4; // data(2) + join(1)
    } else if (segType === SEG_CUBIC) {
      sx = curveF32[dataAt];
      sy = curveF32[dataAt + 1];
      const c2x = curveF32[dataAt + 2],
        c2y = curveF32[dataAt + 3];
      const c3x = curveF32[dataAt + 4],
        c3y = curveF32[dataAt + 5];
      ex = curveF32[dataAt + 6];
      ey = curveF32[dataAt + 7];
      cmd = `C${f(c2x)} ${f(c2y)} ${f(c3x)} ${f(c3y)} ${f(ex)} ${f(ey)}`;
      hdr = dataAt + 8 + 4;
    } else if (epArcs && epArcs.has(hdr)) {
      // SEG_ARC, already ENDPOINT form
      // Exactly the `A` command's own parameterization — emit it verbatim, so the
      // endpoints stay bit-identical to the neighboring segments' and the pen
      // never appears to jump.
      sx = curveF32[dataAt];
      sy = curveF32[dataAt + 1];
      ex = curveF32[dataAt + 2];
      ey = curveF32[dataAt + 3];
      const rx = Math.abs(curveF32[dataAt + 4]),
        ry = Math.abs(curveF32[dataAt + 5]);
      const rot = (curveF32[dataAt + 6] * 180) / Math.PI;
      const flags = curveF32[dataAt + 7] | 0;
      cmd = `A${f(rx)} ${f(ry)} ${f(rot)} ${flags & 1} ${(flags >> 1) & 1} ${f(ex)} ${f(ey)}`;
      hdr = dataAt + 8 + 4 + 4; // data(2) + the endpoints texel + join(1)
    } else {
      // SEG_ARC, center form
      const cx = curveF32[dataAt],
        cy = curveF32[dataAt + 1];
      const rx = curveF32[dataAt + 2],
        ry = curveF32[dataAt + 3];
      const th0 = curveF32[dataAt + 4],
        th1 = curveF32[dataAt + 5],
        phi = curveF32[dataAt + 6];
      // the ends are the record's stored vertices: the pen stays exactly where the neighbors put it
      sx = curveF32[dataAt + 8];
      sy = curveF32[dataAt + 9];
      const sEx = curveF32[dataAt + 10],
        sEy = curveF32[dataAt + 11];
      if (Math.abs(th1 - th0) >= FULL_SWEEP) {
        // A whole revolution lands the arc back on its own start, and SVG
        // §F.6.2 says an `A` whose endpoints are identical is omitted
        // ENTIRELY — not drawn as a circle. Since svg/shape.js encodes every
        // <circle> and <ellipse> as ONE arc over [-PI, PI], emitting that
        // directly makes the shape vanish in the native fallback.
        //
        // Two half sweeps say the same thing with endpoints a diameter apart,
        // which no rounding can collapse. Each spans exactly PI, so both come
        // out large-arc-flag 0.
        const thm = th0 + (th1 - th0) / 2;
        const a1 = arcEndpoint(cx, cy, rx, ry, th0, thm, phi);
        const a2 = arcEndpoint(cx, cy, rx, ry, thm, th1, phi);
        ex = sEx;
        ey = sEy;
        cmd =
          `A${f(a1.rx)} ${f(a1.ry)} ${f(a1.rot)} ${a1.largeArc} ${a1.sweep} ${f(a1.ex)} ${f(a1.ey)}` +
          `A${f(a2.rx)} ${f(a2.ry)} ${f(a2.rot)} ${a2.largeArc} ${a2.sweep} ${f(ex)} ${f(ey)}`;
      } else {
        const a = arcEndpoint(cx, cy, rx, ry, th0, th1, phi);
        ex = sEx;
        ey = sEy;
        cmd = `A${f(a.rx)} ${f(a.ry)} ${f(a.rot)} ${a.largeArc} ${a.sweep} ${f(ex)} ${f(ey)}`;
      }
      hdr = dataAt + 8 + 4 + 4; // data(2) + the endpoints texel + join(1)
    }

    // New subpath where the header says so, or where the pen isn't already at
    // this segment's start.
    mag = Math.max(mag, Math.abs(sx), Math.abs(sy), Math.abs(ex), Math.abs(ey));
    const eps = EPS_REL * mag;
    if (subStart || isNaN(penX) || Math.abs(sx - penX) > eps || Math.abs(sy - penY) > eps) {
      if (openSubpath && !subpathFree) d += 'Z';
      d += `M${f(sx)} ${f(sy)}`;
      openSubpath = true;
    }
    d += cmd;
    penX = ex;
    penY = ey;
    subpathFree = freeEnd;
  }
  if (openSubpath && !subpathFree) d += 'Z';
  return d;
}

/**
 * Decode every (or selected) shapes of a curve buffer into a
 * `{ shapeIndex: dString }` map using `curveRangesByShape`.
 *
 * @param {ArrayLike<number>} curveF32
 * @param {Array<{begin:number,end:number}>} ranges
 * @param {Iterable<number>} [onlyIdxs]
 * @returns {Map<number,string>}
 */
export function curvesToPathDMap(curveF32, ranges, onlyIdxs) {
  const out = new Map();
  const idxs = onlyIdxs != null ? onlyIdxs : ranges.map((_, i) => i);
  for (const idx of idxs) {
    const r = ranges[idx];
    if (!r) continue;
    out.set(idx, curveRangeToPathD(curveF32, r.begin, r.end));
  }
  return out;
}

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/**
 * Carry a decoded `d` through the affine `m` ([a b c d e f], the SVG matrix order). The native scene uses it
 * to bring bundle-coordinate geometry (curves are stored after every ancestor transform) into the coordinates of
 * the retained element it lands on: `inverse(CTM)` of that element.
 *
 * Only the commands this module emits are understood (M L Q C A Z, absolute). Anything else returns `d` unchanged
 * (a hand-written relative path cannot be mapped here, and a wrong map is worse than none).
 * An elliptical arc stays an arc: its ellipse maps to an ellipse (rx, ry, rotation from the eigen decomposition of
 * L*E*E^T*L^T), and the sweep flag flips when the map reverses orientation.
 *
 * @param {string} d
 * @param {ArrayLike<number>} m
 * @returns {string}
 */
export function transformPathD(d, m) {
  if (!d) return d;
  const [a, b, c, dd, e, g] = m;
  const det = a * dd - b * c;
  let out = '';
  const re = /([MLQCAZ])([^MLQCAZ]*)/g;
  let used = 0,
    hit;
  while ((hit = re.exec(d))) {
    if (hit.index !== used) return d;
    used = re.lastIndex;
    const cmd = hit[1],
      n = (hit[2].match(NUM) || []).map(Number);
    if (cmd === 'Z') {
      out += 'Z';
      continue;
    }
    out += cmd;
    if (cmd === 'A') {
      for (let i = 0; i + 7 <= n.length; i += 7) {
        const rx = n[i],
          ry = n[i + 1],
          phi = (n[i + 2] * Math.PI) / 180,
          cp = Math.cos(phi),
          sp = Math.sin(phi);
        // E = L * R(phi) * diag(rx, ry); the new axes are the eigenvectors of E E^T.
        const p = a * cp * rx + c * sp * rx,
          q = -a * sp * ry + c * cp * ry;
        const r = b * cp * rx + dd * sp * rx,
          s = -b * sp * ry + dd * cp * ry;
        const A = p * p + q * q,
          B = p * r + q * s,
          D = r * r + s * s;
        const half = Math.hypot((A - D) / 2, B),
          mid = (A + D) / 2;
        const nrx = Math.sqrt(Math.max(0, mid + half)),
          nry = Math.sqrt(Math.max(0, mid - half));
        const rot = (0.5 * Math.atan2(2 * B, A - D) * 180) / Math.PI;
        const x = n[i + 5],
          y = n[i + 6];
        out += `${f(nrx)} ${f(nry)} ${f(rot)} ${n[i + 3]} ${det < 0 ? 1 - n[i + 4] : n[i + 4]} ${f(a * x + c * y + e)} ${f(b * x + dd * y + g)}`;
        if (i + 7 < n.length) out += ' ';
      }
      continue;
    }
    for (let i = 0; i + 1 < n.length; i += 2) {
      out += `${f(a * n[i] + c * n[i + 1] + e)} ${f(b * n[i] + dd * n[i + 1] + g)}`;
      if (i + 2 < n.length) out += ' ';
    }
  }
  return used === d.length ? out : d;
}

// curveToPathD.js — decode a Mantle curve-float buffer back into an SVG
// path `d` string.
//
// This is the inverse of `encodeSeg` (src/svg/textures.js). The WebGL
// renderer packs each shape's segments into a flat Float32 "curve
// buffer" of RGBA texels and ray-casts them on the GPU; it never needs
// a path string. The no-WebGL fallback DOES: for a geometry MORPH the
// per-frame lerp of two curve buffers has no source-markup form, so we
// decode the lerped buffer to a `d` string each frame and write it onto
// the shape's <path>.
//
// BUFFER LAYOUT. The per-SHAPE range from `bundle.curveRangesByShape`
// points at the first segment's HEADER texel (the range's `begin`).
// Each segment record is:
//
//   header texel : (segType, freeStart, freeEnd, startDist)
//                  segType low 2 bits = LINE/QUAD/CUBIC/ARC; +4 bit =
//                  is_fill_only. freeStart/freeEnd mark FREE (open)
//                  endpoints, NOT subpath starts — for a closed fill
//                  they're 0 everywhere, so we detect subpath breaks by
//                  pen-position discontinuity instead.
//   LINE  : 1 data texel (p1x,p1y,p2x,p2y)
//   QUAD  : 2 data texels (p1x,p1y,p2x,p2y) (p3x,p3y, reachA, reachB)
//   CUBIC : 2 data texels (p1x,p1y,p2x,p2y) (p3x,p3y,p4x,p4y)
//   ARC   : 2 data texels (cx,cy,rx,ry) (theta0,theta1,phi, 0)
//   join texel : (inTanX,inTanY,outTanX,outTanY)  — derived, skipped
//
// so the per-segment stride is 3 texels (12 floats) for LINE and 4
// texels (16 floats) for QUAD/CUBIC/ARC. The range's `begin`
// (`curveRangesByShape[i].begin`) points at the first segment's HEADER
// texel, so we walk header-first from `begin`.

const SEG_LINE = 0, SEG_QUAD = 1, SEG_CUBIC = 2, SEG_ARC = 3;
const EPS = 1e-4;   // pen-continuity tolerance (em)

function f(n) {
  if (!isFinite(n)) return '0';
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
}

// One elliptical arc (center form, as Mantle stores it) → SVG endpoint
// form. encodeSeg dropped the large-arc/sweep flags, so recover them
// from the swept angle.
function arcEndpoint(cx, cy, rx, ry, th0, th1, phi) {
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const ex = cx + rx * Math.cos(th1) * cp - ry * Math.sin(th1) * sp;
  const ey = cy + rx * Math.cos(th1) * sp + ry * Math.sin(th1) * cp;
  const dth = th1 - th0;
  return {
    ex, ey, rx, ry,
    rot: phi * 180 / Math.PI,
    largeArc: Math.abs(dth) > Math.PI ? 1 : 0,
    sweep: dth > 0 ? 1 : 0,
  };
}
function arcStartPt(cx, cy, rx, ry, th0, phi) {
  const cp = Math.cos(phi), sp = Math.sin(phi);
  return [
    cx + rx * Math.cos(th0) * cp - ry * Math.sin(th0) * sp,
    cy + rx * Math.cos(th0) * sp + ry * Math.sin(th0) * cp,
  ];
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
 *   ENDPOINT form — (p1.xy, p4.xy), (rx, ry, phi, flags) — rather than centre
 *   form. A morph interpolates arcs that way (morphCore.prepareArcMorph), and
 *   this decoder is the one consumer that should NOT be handed centre form:
 *   `A rx ry phi large sweep x y` IS endpoint form, so it emits the stored
 *   numbers verbatim. Going via centre form would re-derive the arc's endpoints
 *   through a trig round trip, and in float32 they land a hair off the
 *   neighbouring segment's endpoint — which the pen-continuity test below then
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

  let penX = NaN, penY = NaN;       // current point; NaN ⇒ no subpath yet
  let openSubpath = false;

  // The range covers [begin, end); seg0's header is the only texel before
  // `begin` we read. Stop when the next data texel would exceed `end`.
  while (hdr + 4 <= end) {
    const segType = (curveF32[hdr] | 0) & 3;
    const dataAt = hdr + 4;
    if (dataAt + 4 > end + 0) {
      // Not enough room for even a LINE's data — done.
      if (dataAt + 4 > curveF32.length) break;
    }

    let sx, sy, ex, ey, cmd;
    if (segType === SEG_LINE) {
      sx = curveF32[dataAt];     sy = curveF32[dataAt + 1];
      ex = curveF32[dataAt + 2]; ey = curveF32[dataAt + 3];
      cmd = `L${f(ex)} ${f(ey)}`;
      hdr = dataAt + 4 + 4;                 // data(1) + join(1) → next header
    } else if (segType === SEG_QUAD) {
      sx = curveF32[dataAt];     sy = curveF32[dataAt + 1];
      const c2x = curveF32[dataAt + 2], c2y = curveF32[dataAt + 3];
      ex = curveF32[dataAt + 4]; ey = curveF32[dataAt + 5];
      cmd = `Q${f(c2x)} ${f(c2y)} ${f(ex)} ${f(ey)}`;
      hdr = dataAt + 8 + 4;                 // data(2) + join(1)
    } else if (segType === SEG_CUBIC) {
      sx = curveF32[dataAt];     sy = curveF32[dataAt + 1];
      const c2x = curveF32[dataAt + 2], c2y = curveF32[dataAt + 3];
      const c3x = curveF32[dataAt + 4], c3y = curveF32[dataAt + 5];
      ex = curveF32[dataAt + 6]; ey = curveF32[dataAt + 7];
      cmd = `C${f(c2x)} ${f(c2y)} ${f(c3x)} ${f(c3y)} ${f(ex)} ${f(ey)}`;
      hdr = dataAt + 8 + 4;
    } else if (epArcs && epArcs.has(hdr)) {   // SEG_ARC, already ENDPOINT form
      // Exactly the `A` command's own parameterization — emit it verbatim, so the
      // endpoints stay bit-identical to the neighbouring segments' and the pen
      // never appears to jump.
      sx = curveF32[dataAt];     sy = curveF32[dataAt + 1];
      ex = curveF32[dataAt + 2]; ey = curveF32[dataAt + 3];
      const rx = Math.abs(curveF32[dataAt + 4]), ry = Math.abs(curveF32[dataAt + 5]);
      const rot = curveF32[dataAt + 6] * 180 / Math.PI;
      const flags = curveF32[dataAt + 7] | 0;
      cmd = `A${f(rx)} ${f(ry)} ${f(rot)} ${flags & 1} ${(flags >> 1) & 1} ${f(ex)} ${f(ey)}`;
      hdr = dataAt + 8 + 4;
    } else { // SEG_ARC, centre form
      const cx = curveF32[dataAt],     cy = curveF32[dataAt + 1];
      const rx = curveF32[dataAt + 2], ry = curveF32[dataAt + 3];
      const th0 = curveF32[dataAt + 4], th1 = curveF32[dataAt + 5], phi = curveF32[dataAt + 6];
      [sx, sy] = arcStartPt(cx, cy, rx, ry, th0, phi);
      const a = arcEndpoint(cx, cy, rx, ry, th0, th1, phi);
      ex = a.ex; ey = a.ey;
      cmd = `A${f(a.rx)} ${f(a.ry)} ${f(a.rot)} ${a.largeArc} ${a.sweep} ${f(ex)} ${f(ey)}`;
      hdr = dataAt + 8 + 4;
    }

    // New subpath if the pen isn't already at this segment's start.
    if (isNaN(penX) || Math.abs(sx - penX) > EPS || Math.abs(sy - penY) > EPS) {
      if (openSubpath) d += 'Z';
      d += `M${f(sx)} ${f(sy)}`;
      openSubpath = true;
    }
    d += cmd;
    penX = ex; penY = ey;
  }
  if (openSubpath) d += 'Z';
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

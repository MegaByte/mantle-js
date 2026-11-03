// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDashEndAaSmoke — a dash end is an anti-aliased edge with the stroke's linecap, as SVG strokes it (the stroke-frame
// render residual).
//
// THE HAZARD. Deciding a dash by the path distance of the pixel CENTER's closest point (in a dash the segment counts,
// in a gap it does not) makes a dash end a binary cut across the stroke -- the one edge of a stroke with no AA -- and a
// pixel it halves reads 0 or 1 by the rounding of its center: the stroke-frame render smoke puts a dash end on the row of
// pixel centers y = 151.5 under scale(2 1.5), where Chrome has 0.50. And SVG caps each dash with stroke-linecap, so a
// butt cap on every dash end loses round and square caps, and a dotted line (a zero-length dash, round caps) draws nothing.
//
// The dash set is a distance (_strokeMath.glsl dashOut / strokeDashDist): the path-length distance to the nearest
// dash boundary ON the subpath, composed with the segment's distance as the dash's own SDF under its cap -- butt a plane
// across the stroke, square the plane halfW out, round the disc about the dash end -- whose plane normal is the path's
// direction, so the exact-area edge takes a dash end as it takes the body. The hit test answers the same shape.
//
// The renderer side is the SHIPPED walk in float32 (test/_glslEmu.mjs) and the pass's coverage as main() takes it
// (test/_strokeMainCov.mjs mainCov: the walk's edge record through strokeExactCov, or strokeEdgeCov from the distance
// on a text that computes that inline in main() -- those statements, quoted, compiled as that function).
// The reference is exact: SVG 2's shape of every dash as its own capped subpath, box-sampled 8 x 8 per pixel.
//
// (a) the render smoke's dashed polyline under its five carriers, including the pixels the GPU read: no pixel on the
//     wrong side of the outline (off by more than half), and dash-end pixels clear of the stroke's sides within 4/255
//     (8 under a stroke-space frame, see there);
// (b) dashed straight strokes at 0, 30 and 90 degrees under butt, square and round caps, and dotted ones ("0 5") under
//     round and square: no pixel on the wrong side, dash ends clear of the sides within 4/255 (round within 64/255:
//     a 2 px disc's edge taken as its tangent plane), and the hit test puts every pixel center clear of the outline on
//     its right side;
// (c) a dashed elliptical arc: no pixel on the wrong side.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { svgInside } from './_strokeShapeRef.mjs';
import { svgInsideGeneric, arcSegs } from './_strokeCubicArcRef.mjs';
import { arcEndpointToCenter } from '../src/svg/segment.js';
import { fillHitShape, HitMode } from '../src/hitTest/index.js';
import { mainCov, hasExact } from './_strokeMainCov.mjs';

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation');
  process.exit(0);
}

// main()'s inline stroke coverage, as a function (strokeEdgeCov's statements), for a text that does not define one.
const MAIN_COVERAGE = `float strokeEdgeCov(float minD, float halfW, vec2 grad, vec2 ePx, bool exactAa) {
    float pxSize = 0.5 * (ePx.x + ePx.y);
    float halfWMin = 0.5 * pxSize;
    float halfWVis = max(halfW, halfWMin);
    float weightFade = halfW / halfWVis;
    float distFromEdge = minD - halfWVis;
    float strokeCov = 0.0;
    if (exactAa && dot(grad, grad) > 0.5
        && distFromEdge <= 0.75 * pxSize) {
      vec2 nUn = grad * ePx;
      float il = inversesqrt(max(dot(nUn, nUn), 1e-30));
      strokeCov = exactBoxCov(nUn * il, -distFromEdge * il) * weightFade;
    } else
    if (distFromEdge <= 0.5 * pxSize) {
      strokeCov = clamp(0.5 - distFromEdge / max(pxSize, 1e-6), 0.0, 1.0) * weightFade;
    }
    return strokeCov;
}`;
let GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
if (!/float strokeEdgeCov\(/.test(GLSL)) GLSL += '\n' + MAIN_COVERAGE;
const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl: GLSL });

/// Every stroke row of a bundle, with what the walk needs; `emuCov(row, pixels)` is the main pass's coverage at them.
const EXACT = hasExact(GLSL);
function rowsOf(b) {
  const meta = new Float32Array(b.meta, 32),
    rows = [];
  for (let i = 0; i * 48 < meta.length; i++) {
    const o = i * 48,
      m = (k) => meta[o + k];
    if (!(m(12) > 0) || m(7) > 0) continue;
    const cap = m(24) | 0,
      endEnc = Math.round(m(46)) | 0;
    rows.push({
      bb: [m(0), m(1), m(2), m(3)],
      GD: [m(16) | 0, m(17) | 0, m(18) | 0, m(19) | 0],
      hw: m(12) * 0.5,
      cap,
      endCap: endEnc === 0 ? cap : endEnc - 1,
      join: m(25) | 0,
      miter: m(26),
      dashId: Math.round(m(15)) | 0,
      framed: (Math.round(m(27)) & 4) !== 0,
      N: [m(20), m(21), m(22), m(23)],
    });
  }
  return {
    rows,
    band: new Float32Array(b.bands),
    curve: new Float32Array(b.curves),
    dash: b.dashes ? new Float32Array(b.dashes) : null,
  };
}
function emuCov(B, r, pix) {
  return mainCov(emu, B, r, pix, 1, EXACT);
}
/// The coverage of pixel (x, y) by `inside` (a local-space test) through `toLocal`: 8 x 8 box samples, and where that
/// is partial 32 x 32 (a plane crossing a box is off by up to ~1/n per axis at n samples; 8 x 8 alone read 8/255 of
/// sampling noise on an exact edge).
function refCov(inside, toLocal, x, y) {
  const at = (n) => {
    let c = 0;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) if (inside(toLocal(x + (i + 0.5) / n, y + (j + 0.5) / n))) c++;
    return c / (n * n);
  };
  const c8 = at(8);
  return c8 > 0 && c8 < 1 ? at(32) : c8;
}

// ---- dashes as SVG 2 subpaths ---------------------------------------------------------------------------------------------
/// The dash intervals [a, b] of a path of length L under dasharray `D` (even length) and offset `off`.
function dashIntervals(L, D, off) {
  const cyc = D.reduce((a, b) => a + b, 0),
    out = [];
  let s = -(((off % cyc) + cyc) % cyc);
  for (let k = 0; s < L; k = (k + 1) % D.length) {
    const e = s + D[k];
    if ((k & 1) === 0 && e >= 0 && s <= L) out.push([Math.max(s, 0), Math.min(e, L)]);
    s = e;
  }
  return out;
}
/// Inside the dashed polyline P (open) of half-width h, each dash a capped subpath (a zero-length one a dot).
function dashedPolyInside(P, D, off, h, cap) {
  const lens = [],
    cum = [0];
  for (let i = 0; i + 1 < P.length; i++) {
    lens.push(Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]));
    cum.push(cum[i] + lens[i]);
  }
  const at = (s) => {
    let i = 0;
    while (i < lens.length - 1 && s > cum[i + 1]) i++;
    const t = (s - cum[i]) / lens[i];
    return [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t, i];
  };
  const dashes = dashIntervals(cum[cum.length - 1], D, off).map(([a, b]) => {
    const A = at(a),
      Bp = at(b);
    if (b - a <= 0) {
      const i = A[2],
        T = [(P[i + 1][0] - P[i][0]) / lens[i], (P[i + 1][1] - P[i][1]) / lens[i]];
      return { dot: [A[0], A[1]], T };
    }
    const pts = [[A[0], A[1]]];
    for (let v = A[2] + 1; v <= Bp[2]; v++) pts.push(P[v]);
    pts.push([Bp[0], Bp[1]]);
    return { pts };
  });
  return (p) =>
    dashes.some((d) => {
      if (d.dot) {
        const q = [p[0] - d.dot[0], p[1] - d.dot[1]];
        if (cap === 1) return Math.hypot(q[0], q[1]) <= h;
        if (cap === 2)
          return (
            Math.abs(q[0] * d.T[0] + q[1] * d.T[1]) <= h &&
            Math.abs(-q[0] * d.T[1] + q[1] * d.T[0]) <= h
          );
        return false;
      }
      return svgInside(p, d.pts, false, h, cap, 0, 4);
    });
}
/// Is pixel (x, y) wholly within the stroke's lateral band of the polyline (every sample within h of the path's line
/// through it, ignoring ends), i.e. is it decided by a dash end alone?
function clearOfSides(P, h, toLocal, x, y) {
  const lat = (p) => {
    let best = Infinity;
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i],
        b = P[i + 1],
        L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (L * L);
      if (t >= 0 && t <= 1)
        best = Math.min(
          best,
          Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / L,
        );
    }
    return best;
  };
  for (const [i, j] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ])
    if (!(lat(toLocal(x + i, y + j)) < h - 1e-9)) return false;
  return true;
}

// ---- (a) the render smoke's dashed cell -------------------------------------------------------------------------------------
{
  const D2R = Math.PI / 180,
    CELL = 104;
  const mm = (P, Q) => [
    P[0] * Q[0] + P[2] * Q[1],
    P[1] * Q[0] + P[3] * Q[1],
    P[0] * Q[2] + P[2] * Q[3],
    P[1] * Q[2] + P[3] * Q[3],
  ];
  const rot = (d) => [Math.cos(d * D2R), Math.sin(d * D2R), -Math.sin(d * D2R), Math.cos(d * D2R)];
  const CARRIERS = [
    ['rotate(30) scale(2)', mm(rot(30), [2, 0, 0, 2])],
    ['scale(2 1.5)', [2, 0, 0, 1.5]],
    ['skewX(30)', [1, 0, Math.tan(30 * D2R), 1]],
    ['rotate(30) scale(3 1)', mm(rot(30), [3, 0, 0, 1])],
    ['scale(-2 1.5) skewY(10)', mm([-2, 0, 0, 1.5], [1, Math.tan(10 * D2R), 0, 1])],
  ];
  const P = [
      [-12, -6],
      [12, -6],
      [12, 10],
    ],
    inside = dashedPolyInside(P, [6, 3], 6, 1.5, 0);
  let wrong = 0,
    gpu = [],
    endWorst = [0, 0],
    n = 0;
  for (let r = 0; r < CARRIERS.length; r++) {
    const [t, M] = CARRIERS[r],
      T = [3 * CELL + CELL / 2, r * CELL + CELL / 2];
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="520" viewBox="0 0 520 520"><g transform="translate(${T[0]} ${T[1]}) ${t}">` +
      `<path d="M-12 -6 L12 -6 L12 10" fill="none" stroke="#000" stroke-width="3" stroke-linejoin="miter" stroke-linecap="butt" stroke-dasharray="6 3" stroke-dashoffset="6"/></g></svg>`;
    const B = rowsOf(await importSvg(svg, { preserveViewport: true }));
    const det = M[0] * M[3] - M[1] * M[2],
      inv = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
    const toLocal = (px, py) => {
      const dx = px - T[0],
        dy = py - T[1];
      return [inv[0] * dx + inv[2] * dy, inv[1] * dx + inv[3] * dy];
    };
    const pix = [];
    for (let y = r * CELL; y < (r + 1) * CELL; y++)
      for (let x = 3 * CELL; x < 4 * CELL; x++) pix.push([x, y]);
    const cov = emuCov(B, B.rows[0], pix);
    pix.forEach(([x, y], k) => {
      const ref = refCov(inside, toLocal, x, y),
        e = Math.abs(cov[k] - ref);
      n++;
      if (e > 0.5) wrong++;
      if (r === 1 && y === 151 && x >= 385 && x <= 387)
        gpu.push(`(${x},151) ${cov[k].toFixed(2)} for ${ref.toFixed(2)}`);
      if (ref > 0 && ref < 1 && clearOfSides(P, 1.5, toLocal, x, y))
        endWorst[r === 0 ? 0 : 1] = Math.max(endWorst[r === 0 ? 0 : 1], e);
    });
  }
  ok(
    wrong === 0,
    `(a) the render smoke's dashed cell under its five carriers: ${wrong} of ${n} pixels on the wrong side of the outline`,
  );
  ok(
    gpu.length === 3 && gpu.every((s) => /0\.5\d for 0\.50/.test(s)),
    `(a) the pixels the GPU read 1.00 for 0.50 under scale(2 1.5): ${gpu.join(', ')}`,
  );
  // Under a stroke-space frame the SDF takes the larger of the dash plane's and the side's distances IN STROKE SPACE,
  // and the frame stretches the two by different amounts: where both are within a pixel the one taken can be the one
  // farther on screen (about 6.7/255 under a 3:1 frame on a pixel the dash end cuts and the side does not).
  ok(
    endWorst[0] <= 4 / 255 && endWorst[1] <= 8 / 255,
    `(a) dash-end pixels clear of the stroke's sides, worst off the exact area: conformal carrier ${(endWorst[0] * 255).toFixed(2)} (bar 4), stroke-space carriers ${(endWorst[1] * 255).toFixed(2)} (bar 8) /255`,
  );
}

// ---- (b) straight dashed and dotted strokes, and the hit test -------------------------------------------------------------
{
  const CAPS = ['butt', 'round', 'square'];
  const cases = [];
  for (const ang of [0, 30, 90])
    for (let cap = 0; cap < 3; cap++) cases.push({ ang, cap, D: [6, 3], off: 1.5, w: 4 });
  // dots at s = 1.25 + 5k: none on either end of the path, where whether SVG draws a zero-length dash is a coin toss
  for (const ang of [0, 30])
    for (const cap of [1, 2]) cases.push({ ang, cap, D: [0, 5], off: 3.75, w: 3, dotted: true });
  let wrong = 0,
    n = 0,
    endWorst = [0, 0, 0],
    hitBad = 0,
    hitN = 0,
    first = '';
  for (const cs of cases) {
    const T = [60.5, 60.5],
      c = Math.cos((cs.ang * Math.PI) / 180),
      s = Math.sin((cs.ang * Math.PI) / 180);
    const P = [
      [-40, 0],
      [40, 0],
    ];
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="121" height="121" viewBox="0 0 121 121"><g transform="translate(${T[0]} ${T[1]}) rotate(${cs.ang})">` +
      `<path d="M-40 0 L40 0" fill="none" stroke="#000" stroke-width="${cs.w}" stroke-linecap="${CAPS[cs.cap]}" stroke-dasharray="${cs.D.join(' ')}" stroke-dashoffset="${cs.off}"/></g></svg>`;
    const b = await importSvg(svg, { preserveViewport: true });
    const B = rowsOf(b),
      inside = dashedPolyInside(P, cs.D, cs.off, cs.w / 2, cs.cap);
    const toLocal = (px, py) => {
      const dx = px - T[0],
        dy = py - T[1];
      return [c * dx + s * dy, -s * dx + c * dy];
    };
    const pix = [];
    for (let y = 0; y < 121; y++) for (let x = 0; x < 121; x++) pix.push([x, y]);
    const cov = emuCov(B, B.rows[0], pix);
    pix.forEach(([x, y], k) => {
      const ref = refCov(inside, toLocal, x, y),
        e = Math.abs(cov[k] - ref);
      n++;
      if (e > 0.5) {
        wrong++;
        if (!first)
          first = `${CAPS[cs.cap]} ${cs.dotted ? 'dotted' : 'dashed'} at ${cs.ang} deg, (${x},${y}): ${cov[k].toFixed(2)} for ${ref.toFixed(2)}`;
      }
      if (!cs.dotted && ref > 0 && ref < 1 && clearOfSides(P, cs.w / 2, toLocal, x, y))
        endWorst[cs.cap] = Math.max(endWorst[cs.cap], e);
      // the hit test at the pixel center, where the exact answer is clear of the outline by 1% of a half-width
      const q = toLocal(x + 0.5, y + 0.5),
        h = cs.w / 2;
      const a = dashedPolyInside(P, cs.D, cs.off, h * 0.99, cs.cap)(q),
        bb = dashedPolyInside(P, cs.D, cs.off, h * 1.01, cs.cap)(q);
      if (a === bb && Math.abs(q[1]) < h * 0.99 === Math.abs(q[1]) < h * 1.01) {
        hitN++;
        if (fillHitShape(b, x + 0.5, y + 0.5, { mode: HitMode.Outline }) >= 0 !== inside(q))
          hitBad++;
      }
    });
  }
  ok(
    wrong === 0,
    `(b) dashed and dotted straight strokes, butt / round / square, at 0 / 30 / 90 degrees: ${wrong} of ${n} pixels on the wrong side${first ? ' -- first ' + first : ''}`,
  );
  // A round end's edge is a circle of radius halfW. Since the exact-edge change an ISOLATED dash end is its exact disc (strokeExactEdgeSmoke);
  // these dashes (6 3 at width 4) leave gaps narrower than the width, so every gap's pixels hold two dash ends' discs,
  // which one edge record does not unite -- they keep the distance's ramp, the tangent plane of the nearer disc: at
  // halfW = 2 px up to a quarter of a pixel.
  ok(
    endWorst[0] <= 4 / 255 && endWorst[2] <= 4 / 255 && endWorst[1] <= 64 / 255,
    `(b) dash-end pixels clear of the sides, worst off the exact area: butt ${(endWorst[0] * 255).toFixed(2)}, square ${(endWorst[2] * 255).toFixed(2)} (bar 4), round ${(endWorst[1] * 255).toFixed(2)} (bar 64: gaps narrower than the width, two discs to a pixel) /255`,
  );
  ok(
    hitBad === 0,
    `(b) the hit test: ${hitBad} of ${hitN} pixel centers clear of the outline on the wrong side`,
  );
}

// ---- (c) a dashed arc ------------------------------------------------------------------------------------------------------
{
  const T = [60.5, 60.5];
  const A = arcEndpointToCenter([-40, 10], 45, 30, 20, 0, 1, [40, 10]);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="121" height="121" viewBox="0 0 121 121"><g transform="translate(${T[0]} ${T[1]})">` +
    `<path d="M-40 10 A45 30 20 0 1 40 10" fill="none" stroke="#000" stroke-width="4" stroke-linecap="butt" stroke-dasharray="9 4"/></g></svg>`;
  const B = rowsOf(await importSvg(svg, { preserveViewport: true }));
  // dashes as sub-arcs: arc length by a fine sum, then each dash's angle range
  const th0 = A.theta1,
    dth = A.dtheta,
    K = 20000,
    cum = [0];
  const sp = (th) => Math.hypot(A.rx * Math.sin(th), A.ry * Math.cos(th));
  for (let i = 1; i <= K; i++)
    cum.push(cum[i - 1] + (Math.abs(dth) / K) * sp(th0 + (dth * (i - 0.5)) / K));
  const thAt = (s) => {
    let lo = 0,
      hi = K;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= s) lo = m;
      else hi = m;
    }
    return th0 + (dth * (lo + (s - cum[lo]) / (cum[hi] - cum[lo]))) / K;
  };
  const segs = dashIntervals(cum[K], [9, 4], 0).map(([a, b]) =>
    arcSegs(
      [{ cx: A.cx, cy: A.cy, rx: A.rx, ry: A.ry, phi: A.phi, th0: thAt(a), th1: thAt(b) }],
      false,
    ),
  );
  const inside = (p) => segs.some((sg) => svgInsideGeneric(p, sg, false, 2, 0, 0, 4));
  const toLocal = (px, py) => [px - T[0], py - T[1]];
  const pix = [];
  for (let y = 0; y < 121; y++) for (let x = 0; x < 121; x++) pix.push([x, y]);
  const cov = emuCov(B, B.rows[0], pix);
  let wrong = 0,
    first = '';
  pix.forEach(([x, y], k) => {
    const ref = refCov(inside, toLocal, x, y);
    if (Math.abs(cov[k] - ref) > 0.5) {
      wrong++;
      if (!first) first = `(${x},${y}) ${cov[k].toFixed(2)} for ${ref.toFixed(2)}`;
    }
  });
  ok(
    wrong === 0,
    `(c) a dashed elliptical arc: ${wrong} of ${pix.length} pixels on the wrong side${first ? ' -- first ' + first : ''}`,
  );
}

console.log(fail ? `STROKE-DASH-END-AA FAIL (${fail})` : 'STROKE-DASH-END-AA PASS');
process.exit(fail ? 1 : 0);

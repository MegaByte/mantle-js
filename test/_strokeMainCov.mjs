// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeMainCov.mjs — the main pass's band-walk stroke coverage, driven on the CPU from the SHIPPED text (not a test on
// its own).
//
// mantle.frag.glsl's stroke pass walks the row (strokeMinDist, or strokeMinDistLocal for a stroke-space row) and turns
// what the walk hands back into coverage: the walk's EDGE RECORD through strokeExactCov where there is
// one and the stroke is not a hairline, else strokeEdgeCov from the distance. `mainCov` does the same with the text's own
// functions compiled to float32 (test/_glslEmu.mjs), choosing as main() chooses -- and on a text with no
// strokeExactCov it is strokeEdgeCov throughout, as main() computes there. `refCov` is the exact answer to
// compare with: a membership test box-sampled over the pixel.
import * as EMU from './_glslEmu.mjs';
import { svgInside } from './_strokeShapeRef.mjs';

/// Every stroke row of a bundle (fill-less), with what the walk needs.
export function strokeRowsOf(b) {
  const meta = new Float32Array(b.meta, 32),
    rows = [];
  for (let i = 0; i * 48 < meta.length; i++) {
    const o = i * 48,
      m = (k) => meta[o + k];
    if (!(m(12) > 0) || m(7) > 0) continue;
    const cap = m(24) | 0,
      endEnc = (m(44) | 0) === 3 ? 0 : Math.round(m(46)) | 0;
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

/// Does this emulator's text carry the edge record?
export const hasExact = (glsl) => /float strokeExactCov\(/.test(glsl);

/// The main pass's stroke coverage of row `r` at the pixels `pix` ([x, y] pixel corners; the fragment is the center), em
/// per pixel `ePx`, as main() computes it. `exact` says whether the emulator's text has strokeExactCov.
export function mainCov(emu, B, r, pix, ePx, exact) {
  const W = exact ? 12 : 4,
    qs = [];
  for (const [px, py] of pix)
    for (let which = 0; which < W; which++) {
      const ex = [r.hw, r.miter, r.cap, r.endCap, r.join, r.dashId, 1, which];
      const c = [(px + 0.5) * ePx, (py + 0.5) * ePx];
      if (r.framed)
        qs.push({
          k: EMU.K_STROKE_LOCAL,
          GD: r.GD,
          bb: r.bb,
          c,
          ePx: [ePx, ePx],
          ex: [...ex, ...r.N],
        });
      else
        qs.push({
          k: EMU.K_STROKE_WALK,
          GD: r.GD,
          bb: r.bb,
          c,
          ePx: [ePx, ePx],
          ex: [
            ...ex.slice(0, 7),
            which === 3 ? 0 : which,
            Math.max(r.hw - 0.5 * Math.SQRT2 * ePx, 0),
          ],
        });
    }
  const out = emu.run(B.band, B.curve, qs, B.dash);
  const cq = pix.map((_, k) => {
    const o = W * k,
      hwD = r.framed ? out[o + 3] : r.hw;
    if (exact && out[o + 7] > 0 && hwD >= 0.5 * ePx) {
      return {
        k: EMU.K_STROKE_EXACT,
        bb: [out[o + 4], out[o + 5], out[o + 6], out[o + 7]],
        ePx: [ePx, ePx],
        ex: [
          out[o + 8],
          out[o + 9],
          out[o + 10],
          out[o + 11],
          ...(r.framed ? r.N : [1, 0, 0, 1]),
          r.hw,
        ],
        GD: [1, 0, 0, 0],
      };
    }
    return {
      k: EMU.K_STROKE_EDGE,
      bb: [out[o], hwD, out[o + 1], out[o + 2]],
      ePx: [ePx, ePx],
      GD: [1, 0, 0, 0],
    };
  });
  return emu.run(new Float32Array(4), new Float32Array(4), cq);
}

/// The coverage of the pixel box with corner (x, y) by `inside` (a test in some other space, reached through `toLocal`):
/// 9 x 9 samples over the box, its edges and corners included, and where they disagree 64 x 64 inside it.
export function refCov(inside, toLocal, x, y) {
  let cin = 0;
  for (let j = 0; j <= 8; j++)
    for (let i = 0; i <= 8; i++) if (inside(toLocal(x + i / 8, y + j / 8))) cin++;
  if (cin === 0) return 0;
  if (cin === 81) return 1;
  let c = 0;
  for (let j = 0; j < 64; j++)
    for (let i = 0; i < 64; i++) if (inside(toLocal(x + (i + 0.5) / 64, y + (j + 0.5) / 64))) c++;
  return c / 4096;
}

// ---- THE exact-EDGE CASE SET ---------------------------------------------------------------------------
// Thick strokes whose every edge is a known shape: butt, square and round caps at four angles; bevel, miter-clip and round
// joins; butt, square and round dash ends -- drawn plain and under scale(2 1.5). Each pixel near a case's features is
// compared with SVG 2's shape (test/_strokeShapeRef.mjs svgInside) box-sampled, and flagged when it lies near a CORNER
// of the outline -- where two of its edges cross the box: a butt or square end's corners, a chord's or a clip line's
// ends, a dash end's corners, the inside of a turn.
export const CARRIERS = [
  ['plain', [1, 0, 0, 1]],
  ['scale(2 1.5)', [2, 0, 0, 1.5]],
];
const D2R = Math.PI / 180;
const rotP = (p, deg) => [
  p[0] * Math.cos(deg * D2R) - p[1] * Math.sin(deg * D2R),
  p[0] * Math.sin(deg * D2R) + p[1] * Math.cos(deg * D2R),
];
const unit = (v) => {
  const l = Math.hypot(v[0], v[1]);
  return [v[0] / l, v[1] / l];
};
/// The outline's CORNERS -- where two of its edges meet at an angle -- each with the directions of its two edges: a butt
/// or square end's corners, a bevel's chord ends, a clip line's ends, and the inside of each turn.
function cornersOf(P, hw, cap, join, ml) {
  const out = [],
    seg = (i) => unit([P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]]);
  const n = (t) => [-t[1], t[0]];
  for (const [V, u] of [
    [P[0], seg(0).map((v) => -v)],
    [P[P.length - 1], seg(P.length - 2)],
  ]) {
    if (cap === 1) continue;
    const e = cap === 2 ? hw : 0,
      nn = n(u);
    for (const s of [-1, 1])
      out.push({
        p: [V[0] + u[0] * e + nn[0] * hw * s, V[1] + u[1] * e + nn[1] * hw * s],
        d1: u,
        d2: nn,
      });
  }
  for (let i = 1; i + 1 < P.length; i++) {
    const a = seg(i - 1),
      b = seg(i),
      V = P[i],
      cr = a[0] * b[1] - a[1] * b[0],
      sd = cr >= 0 ? 1 : -1;
    const nA = [sd * a[1], -sd * a[0]],
      nB = [sd * b[1], -sd * b[0]]; // outer normals
    const bis = unit([nA[0] + nB[0], nA[1] + nB[1]]),
      cosH = nA[0] * bis[0] + nA[1] * bis[1];
    out.push({ p: [V[0] - (bis[0] * hw) / cosH, V[1] - (bis[1] * hw) / cosH], d1: a, d2: b }); // the inner offsets' crossing
    const P1 = [V[0] + nA[0] * hw, V[1] + nA[1] * hw],
      P2 = [V[0] + nB[0] * hw, V[1] + nB[1] * hw];
    if (join === 'bevel') {
      const ch = unit([P2[0] - P1[0], P2[1] - P1[1]]);
      out.push({ p: P1, d1: a, d2: ch }, { p: P2, d1: b, d2: ch });
    } else if (join === 'miter-clip') {
      const L = ml * hw,
        cl = n(bis); // the clip line: across the bisector, L out from the vertex; its ends on the sides
      for (const [Pk, t] of [
        [P1, a],
        [P2, [-b[0], -b[1]]],
      ]) {
        const den = t[0] * bis[0] + t[1] * bis[1],
          s = (L - ((Pk[0] - V[0]) * bis[0] + (Pk[1] - V[1]) * bis[1])) / den;
        out.push({ p: [Pk[0] + t[0] * s, Pk[1] + t[1] * s], d1: t, d2: cl });
      }
    }
  }
  return out;
}
const dashCorners = (P, D, off, hw, cap) => {
  const L = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]),
    u = unit([P[1][0] - P[0][0], P[1][1] - P[0][1]]),
    nn = [-u[1], u[0]],
    out = [];
  if (cap === 1) return out;
  const cyc = D[0] + D[1];
  for (let s = -off; s < L + cyc; s += cyc)
    for (const [b, dir] of [
      [s, -1],
      [s + D[0], 1],
    ]) {
      if (b <= 0 || b >= L) continue;
      const ext = cap === 2 ? hw * dir : 0;
      for (const sg of [-1, 1])
        out.push({
          p: [
            P[0][0] + u[0] * (b + ext) + nn[0] * hw * sg,
            P[0][1] + u[1] * (b + ext) + nn[1] * hw * sg,
          ],
          d1: u,
          d2: nn,
        });
    }
  return out;
};
/// Pixel centers whose box two edges of a corner cross (both within 0.72 px): within 0.72 / sin(alpha / 2) of the corner,
/// alpha the angle between the edges' lines, in DOCUMENT pixels (the directions mapped by the carrier).
const cornerReach = (c, M) => {
  const m = (d) => unit([M[0] * d[0] + M[2] * d[1], M[1] * d[0] + M[3] * d[1]]);
  const d1 = m(c.d1),
    d2 = m(c.d2),
    cosA = Math.min(1, Math.abs(d1[0] * d2[0] + d1[1] * d2[1]));
  return 0.72 / Math.sin(Math.acos(cosA) / 2) + 0.05;
};
const CAPS = ['butt', 'round', 'square'];
export const CASES = [];
for (const cap of [0, 1, 2])
  for (const ang of [0, 17, 45, 71]) {
    const P = [rotP([-30, 0], ang), rotP([30, 0], ang)];
    CASES.push({
      what: `${CAPS[cap]} caps at ${ang} deg`,
      P,
      hw: 6,
      cap,
      join: 'miter',
      ml: 4,
      around: P,
    });
  }
for (const [join, turn, ml] of [
  ['bevel', 100, 4],
  ['miter-clip', 150, 1.5],
  ['round', 100, 4],
]) {
  const P = [[-30, 0], [0, 0], rotP([30, 0], turn)];
  CASES.push({
    what: `a ${join} join turning ${turn} deg`,
    P,
    hw: 6,
    cap: 0,
    join,
    ml,
    around: [P[1]],
  });
}
for (const cap of [0, 1, 2]) {
  const P = [rotP([-40, 0], 23), rotP([40, 0], 23)];
  // the middle 56 units of the 80: the path's own ends are not dash ends
  CASES.push({
    what: `${CAPS[cap]} dash ends`,
    P,
    hw: 5,
    cap,
    join: 'miter',
    ml: 4,
    dash: [12, 14],
    off: 3,
    around: [[0, 0]],
    window: 28,
  });
}
// dots: zero-length dashes, round-capped, each its whole disc
CASES.push({
  what: 'round dots',
  P: [rotP([-40, 0], 23), rotP([40, 0], 23)],
  hw: 4,
  cap: 1,
  join: 'miter',
  ml: 4,
  dash: [0, 14],
  off: 3,
  around: [[0, 0]],
  window: 28,
});
/// Every partly covered pixel of every case, plain and framed, at scale S: { e: |main pass - SVG 2|, corner, what }.
/// `importSvg` is the importer; `emu` the emulator of the text under test, `exact` whether it has the edge record.
export async function exactCasePixels(importSvg, emu, exact, S) {
  const T = [64, 64],
    SIZE = 128,
    res = [];
  for (const [cname, M] of CARRIERS)
    for (const cs of CASES) {
      const d = 'M ' + cs.P.map((p) => `${p[0].toPrecision(9)} ${p[1].toPrecision(9)}`).join(' L ');
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE * S}" height="${SIZE * S}" viewBox="0 0 ${SIZE * S} ${SIZE * S}">` +
        `<g transform="scale(${S}) translate(${T[0]} ${T[1]}) ${cname === 'plain' ? '' : cname}"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * cs.hw}"` +
        ` stroke-linecap="${CAPS[cs.cap]}" stroke-linejoin="${cs.join}" stroke-miterlimit="${cs.ml}"${cs.dash ? ` stroke-dasharray="${cs.dash.join(' ')}" stroke-dashoffset="${cs.off}"` : ''}/></g></svg>`;
      const B = strokeRowsOf(await importSvg(svg, { preserveViewport: true }));
      const det = M[0] * M[3] - M[1] * M[2],
        inv = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
      const toLocal = (px, py) => {
        const dx = px - T[0],
          dy = py - T[1];
        return [inv[0] * dx + inv[2] * dy, inv[1] * dx + inv[3] * dy];
      };
      const toDoc = (p) => [T[0] + M[0] * p[0] + M[2] * p[1], T[1] + M[1] * p[0] + M[3] * p[1]];
      let inside;
      if (cs.dash) {
        const L = 80,
          D = cs.dash,
          u = unit([cs.P[1][0] - cs.P[0][0], cs.P[1][1] - cs.P[0][1]]),
          pieces = [];
        for (let s = -cs.off; s < L; s += D[0] + D[1]) {
          const a = Math.max(s, 0),
            b = Math.min(s + D[0], L);
          if (b > a || (b === a && s >= 0 && cs.cap !== 0))
            pieces.push([
              [cs.P[0][0] + u[0] * a, cs.P[0][1] + u[1] * a],
              [cs.P[0][0] + u[0] * b, cs.P[0][1] + u[1] * b],
            ]);
        }
        // a zero-length dash is a dot: its round cap's whole disc (a square one would be its box; the case set has none)
        inside = (p) =>
          pieces.some((pc) =>
            pc[0][0] === pc[1][0] && pc[0][1] === pc[1][1]
              ? Math.hypot(p[0] - pc[0][0], p[1] - pc[0][1]) <= cs.hw
              : svgInside(p, pc, false, cs.hw, cs.cap, 0, 4),
          );
      } else
        inside = (p) =>
          svgInside(
            p,
            cs.P,
            false,
            cs.hw,
            cs.cap,
            ['miter', 'round', 'bevel', 'miter-clip', 'arcs'].indexOf(cs.join),
            cs.ml,
          );
      const corners = (
        cs.dash
          ? dashCorners(cs.P, cs.dash, cs.off, cs.hw, cs.cap)
          : cornersOf(cs.P, cs.hw, cs.cap, cs.join, cs.ml)
      ).map((k) => ({ p: toDoc(k.p), R: cornerReach(k, M) }));
      const around = cs.around.map(toDoc),
        win = cs.window || 22;
      const pix = [],
        near = [];
      for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
          const c = [x + 0.5, y + 0.5];
          if (!around.some((a) => Math.hypot(c[0] - a[0], c[1] - a[1]) < win)) continue;
          pix.push([x, y]);
          near.push(corners.some((k) => Math.hypot(c[0] - k.p[0], c[1] - k.p[1]) < k.R));
        }
      const cov = mainCov(emu, B, B.rows[0], pix, S, exact);
      pix.forEach(([x, y], k) => {
        const r = refCov(inside, toLocal, x, y);
        if (!(r > 0 && r < 1) && !(cov[k] > 0 && cov[k] < 1)) return;
        res.push({
          e: Math.abs(cov[k] - r),
          corner: near[k],
          what: `${cs.what}, ${cname}, 2^${Math.round(Math.log2(S))}: (${x},${y}) ${(cov[k] * 255).toFixed(1)} for ${(r * 255).toFixed(1)}`,
        });
      });
    }
  return res;
}

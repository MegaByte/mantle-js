// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// splitStrokeWorldReachSmoke — the split-stroke pass's segment quad reaches the stroke's AA fringe under any world matrix
//.
//
// THE HAZARD. _strokeVertexSetup.glsl pads each segment's quad by the stroke's reach plus a margin, and emPerPx is the
// em -> plane -> viewport chain's alone: uWorldM, which maps the plane after it, does not enter it. The fragment's AA
// works in device pixels (fwidth) and so does its hairline floor (half-width >= 0.5 px), so under a zoom-out by s a
// margin of 3 * emPerPx is 3s device pixels, and the quad clips the outer fringe -- a hairline's at s <= ~0.4, any
// stroke's at s < 0.24 -- on every side of a chord-aligned box.
//
// The margin is 3 of pxEm, the em size of a device pixel along its longest direction under the world matrix (the
// least stretch of the whole em -> pixel map; an affine matrix has one, a projective one takes the least at the box's
// corners). With no world matrix pxEm is emPerPx, and the draw is unchanged bit for bit.
//
// Both stages run from their shipped text in float32 (test/_glslEmu.mjs buildSplitStrokeEmu, with the vertex stage's
// view set: bbox, canvas aspect, viewport and world matrix). A query's ePx is the fwidth a fragment there reads: the
// em -> pixel map's inverse, per axis |J.x| + |J.y|.
// (a) lines 0.13-0.4 px wide, horizontal and at 45 degrees, zoomed out 0.1-0.25: every painted fragment lies inside
//     the quad (an emPerPx margin lets up to 51/255 of coverage fall outside);
// (b) CONSERVATIVE under every map: 160 random lines, quads, cubics and arcs with random ends, caps, joins and limits,
//     under zoom-outs to 2^-20, a zoom-in, a rotation on a wide canvas, an anisotropic scale, a skew and a projective
//     matrix: no painted fragment outside its quad;
// (c) with no world matrix the quad's corners are the emPerPx ones (the identity matrix gives the same corners too).
import path from 'path';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { encodeSeg, makeTexelBuffer } from '../src/svg/textures.js';
import { mkLine, mkQuad, mkCubic } from '../src/svg/segment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler');
  process.exit(0);
}
const emu = EMU.buildSplitStrokeEmu(ROOT);

/// The renderer's view: the bundle fit (renderer.js arScale) and the world matrix (column-major mat3, null for none).
function mkView(bbox, vw, vh, worldM) {
  const cAR = vw / vh,
    sAR = bbox[2] / bbox[3];
  let sx = 1,
    sy = 1;
  if (sAR > cAR) sy = cAR / sAR;
  else sx = sAR / cAR;
  return { bbox, canvasAR: [sx, sy], viewport: [vw, vh], worldM };
}
/// em -> device pixels at em point p: the pixel position and the 2x2 derivative (column-major [C00, C10, C01, C11]),
/// in double, straight from splitStroke.vert's chain (em -> plane -> uWorldM -> NDC -> viewport).
function toPx(view, p) {
  const [bx, by, bw, bh] = view.bbox,
    [ax, ay] = view.canvasAR,
    [vw, vh] = view.viewport;
  const W = view.worldM || [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const pl = [(((p[0] - bx) / bw) * 2 - 1) * ax, -(((p[1] - by) / bh) * 2 - 1) * ay]; // (plane.x, -plane.y)
  const dpl = [(2 * ax) / bw, (-2 * ay) / bh]; // d pl / d em, diagonal
  const h = [
    W[0] * pl[0] + W[3] * pl[1] + W[6],
    W[1] * pl[0] + W[4] * pl[1] + W[7],
    W[2] * pl[0] + W[5] * pl[1] + W[8],
  ];
  const n = [h[0] / h[2], h[1] / h[2]];
  const J = [
    (W[0] - n[0] * W[2]) / h[2],
    (W[1] - n[1] * W[2]) / h[2],
    (W[3] - n[0] * W[5]) / h[2],
    (W[4] - n[1] * W[5]) / h[2],
  ];
  return {
    px: [((n[0] + 1) / 2) * vw, ((n[1] + 1) / 2) * vh],
    C: [
      (vw / 2) * J[0] * dpl[0],
      (vh / 2) * J[1] * dpl[0],
      (vw / 2) * J[2] * dpl[1],
      (vh / 2) * J[3] * dpl[1],
    ],
  };
}
/// The fwidth(vEm) a fragment at p reads: J = C^-1 (em per pixel), per axis |dFdx| + |dFdy|.
function ePxAt(view, p) {
  const [a, b, c, d] = toPx(view, p).C,
    det = a * d - b * c;
  const J = [d / det, -b / det, -c / det, a / det]; // column-major inverse: J00, J10, J01, J11
  return [
    Math.fround(Math.abs(J[0]) + Math.abs(J[2])),
    Math.fround(Math.abs(J[1]) + Math.abs(J[3])),
  ];
}
/// The em size of a device pixel along its longest direction at p (1 / sigma_min of C).
function pxEmAt(view, p) {
  const [a, b, c, d] = toPx(view, p).C,
    s = a * a + b * b + c * c + d * d,
    det = a * d - b * c;
  const smax = Math.sqrt(0.5 * (s + Math.sqrt(Math.max(s * s - 4 * det * det, 0))));
  return smax / Math.abs(det);
}
const quadOf = (prim, base, st, view) => {
  const qs = [];
  for (let m = 1; m <= 8; m++) qs.push({ base, c: [0, 0], ePx: [1, 1], ...st, corner: m });
  const o = emu.run(prim, qs, view);
  return [
    [o[0], o[1]],
    [o[2], o[3]],
    [o[4], o[5]],
    [o[6], o[7]],
  ];
};
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
/// Inside a convex quad (either winding), by a margin of a hundredth of the local pixel.
const inQuad = (Q, p, tol) => {
  const s = [0, 1, 2, 3].map(
    (i) =>
      cross(Q[i], Q[(i + 1) & 3], p) /
      Math.hypot(Q[(i + 1) & 3][0] - Q[i][0], Q[(i + 1) & 3][1] - Q[i][1]),
  );
  return s.every((v) => v >= -tol) || s.every((v) => v <= tol);
};
const mkArc = (cx, cy, rx, ry, phi, th0, th1) => {
  const ev = (th) => [
    cx + rx * Math.cos(phi) * Math.cos(th) - ry * Math.sin(phi) * Math.sin(th),
    cy + rx * Math.sin(phi) * Math.cos(th) + ry * Math.cos(phi) * Math.sin(th),
  ];
  return {
    type: 3,
    cx,
    cy,
    rx,
    ry,
    phi,
    theta_start: th0,
    theta_end: th1,
    p1: ev(th0),
    p4: ev(th1),
  };
};
const endsOf = (s) =>
  s.type === 3
    ? [
        s.p1,
        s.p4,
        [s.cx - Math.max(s.rx, s.ry), s.cy - Math.max(s.rx, s.ry)],
        [s.cx + Math.max(s.rx, s.ry), s.cy + Math.max(s.rx, s.ry)],
      ]
    : s.type === 0
      ? [s.p1, s.p2]
      : s.type === 1
        ? [s.p1, s.p2, s.p3]
        : [s.p1, s.p2, s.p3, s.p4];
/// Every painted fragment of one segment on an em grid about it (pitch a quarter of a device pixel, out to the reach and
/// five pixels): how many, and the largest coverage outside its quad.
function sweep(s, fs, fe, inTan, outTan, st, view) {
  const buf = makeTexelBuffer();
  const base = encodeSeg(s, buf, fs, fe, fs ? [0, 0] : inTan, fe ? [0, 0] : outTan, 0);
  const prim = new Float32Array(buf.floats.subarray(0, buf.count * 4));
  const Q = quadOf(prim, base, st, view);
  const pts = endsOf(s),
    xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const mid = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const pxEm = Math.max(...pts.map((p) => pxEmAt(view, p)), pxEmAt(view, mid));
  const reach =
    st.halfW *
      Math.max(Math.SQRT2, Math.sqrt(st.miterLimit ** 2 + 1), st.join === 0 ? st.miterLimit : 1) +
    5 * pxEm;
  const x0 = Math.min(...xs) - reach,
    x1 = Math.max(...xs) + reach,
    y0 = Math.min(...ys) - reach,
    y1 = Math.max(...ys) + reach;
  const step = Math.max((x1 - x0) / 160, (y1 - y0) / 160, pxEm / 4);
  const qs = [];
  for (let y = y0 + 0.37 * step; y < y1; y += step)
    for (let x = x0 + 0.61 * step; x < x1; x += step) {
      const c = [Math.fround(x), Math.fround(y)];
      qs.push({ base, c, ePx: ePxAt(view, c), ...st });
    }
  const cov = emu.run(prim, qs, view);
  let n = 0,
    out = 0,
    worst = 0;
  cov.forEach((v, i) => {
    if (!(v > 0)) return;
    n++;
    if (!inQuad(Q, qs[i].c, 0.01 * pxEm)) {
      out++;
      worst = Math.max(worst, v);
    }
  });
  return { n, out, worst };
}

// ---- (a) thin lines zoomed out -------------------------------------------------------------------------------------------------
{
  const view = (s, rot = 0) =>
    mkView([0, 0, 100, 100], 100, 100, [
      s * Math.cos(rot),
      s * Math.sin(rot),
      0,
      -s * Math.sin(rot),
      s * Math.cos(rot),
      0,
      0,
      0,
      1,
    ]);
  const cases = [
    ['horizontal 0.2 px line @0.1', mkLine([20, 50], [80, 50]), 0.1, 0.1],
    ['horizontal 0.13 px hairline @0.25', mkLine([20, 50], [80, 50]), 0.065, 0.25],
    ['45-degree 0.2 px line @0.1', mkLine([20, 20], [80, 80]), 0.1, 0.1],
    ['45-degree 0.4 px line @0.2', mkLine([20, 20], [80, 80]), 0.2, 0.2],
    ['45-degree 0.13 px hairline @0.25', mkLine([20, 20], [80, 80]), 0.065, 0.25],
    [
      'a 45-degree cubic, 0.3 px @0.05',
      mkCubic([20, 20], [30, 60], [60, 30], [80, 80]),
      0.15,
      0.05,
    ],
    ['a quarter arc, 0.2 px @0.1', mkArc(50, 50, 30, 30, 0, 0.3, 0.3 + Math.PI / 2), 0.1, 0.1],
  ];
  for (const [name, s, halfW, sc] of cases)
    for (const cap of [0, 1, 2]) {
      const r = sweep(
        s,
        true,
        true,
        [0, 0],
        [0, 0],
        { halfW, cap, join: 1, miterLimit: 4 },
        view(sc),
      );
      ok(
        r.n > 50 && r.out === 0,
        `(a) ${name}, cap ${cap}: ${r.out} of ${r.n} painted fragments outside the quad${r.out ? ` (up to ${(r.worst * 255).toFixed(1)}/255)` : ''}`,
      );
    }
}

// ---- (b) conservative under every map ------------------------------------------------------------------------------------
{
  const maps = [
    ['zoom-out 0.2', mkView([0, 0, 100, 100], 100, 100, [0.2, 0, 0, 0, 0.2, 0, 0, 0, 1])],
    [
      'zoom-out 2^-20',
      mkView([0, 0, 100, 100], 100, 100, [2 ** -20, 0, 0, 0, 2 ** -20, 0, 0, 0, 1]),
    ],
    ['zoom-in 3', mkView([0, 0, 100, 100], 100, 100, [3, 0, 0, 0, 3, 0, 0, 0, 1])],
    [
      'rotation 30 deg x 0.3 on a 2:1 canvas',
      mkView([0, 0, 100, 100], 200, 100, [
        0.3 * Math.cos(0.52),
        0.3 * Math.sin(0.52),
        0,
        -0.3 * Math.sin(0.52),
        0.3 * Math.cos(0.52),
        0,
        0,
        0,
        1,
      ]),
    ],
    ['anisotropic (1, 0.1)', mkView([0, 0, 100, 100], 100, 100, [1, 0, 0, 0, 0.1, 0, 0, 0, 1])],
    ['skew', mkView([0, 0, 100, 100], 100, 100, [0.3, 0, 0, 0.25, 0.3, 0, 0, 0, 1])],
    ['projective', mkView([0, 0, 100, 100], 100, 100, [0.4, 0, 0.3, 0, 0.4, 0.2, 0, 0, 1])],
  ];
  let seed = 0x51a7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const P = () => [Math.fround(20 + rnd() * 60), Math.fround(20 + rnd() * 60)];
  const U = () => {
    const a = rnd() * 6.283;
    return [Math.cos(a), Math.sin(a)];
  };
  for (const [name, view] of maps) {
    let n = 0,
      out = 0,
      worst = 0;
    for (let k = 0; k < 24; k++) {
      const ty = k % 4;
      let s =
        ty === 0
          ? mkLine(P(), P())
          : ty === 1
            ? mkQuad(P(), P(), P())
            : ty === 2
              ? mkCubic(P(), P(), P(), P())
              : null;
      if (ty === 3) {
        const t0 = rnd() * 6.28;
        s = mkArc(
          40 + rnd() * 20,
          40 + rnd() * 20,
          3 + rnd() * 15,
          3 + rnd() * 15,
          rnd() * 3.14,
          t0,
          t0 + (rnd() < 0.5 ? 1 : -1) * (0.2 + rnd() * 5),
        );
      }
      const fs = rnd() < 0.4,
        fe = rnd() < 0.4;
      // widths from a hairline to a few pixels at the map's scale
      const halfW = (0.05 + rnd() * 3) * pxEmAt(view, [50, 50]) * (rnd() < 0.5 ? 0.1 : 1);
      const st = { halfW, cap: k % 3, join: (k >> 2) % 3, miterLimit: [1, 1.5, 4, 10][k % 4] };
      const r = sweep(s, fs, fe, U(), U(), st, view);
      n += r.n;
      out += r.out;
      worst = Math.max(worst, r.worst);
    }
    ok(
      n > 1000 && out === 0,
      `(b) ${name}: ${out} of ${n} painted fragments outside their quads${out ? ` (up to ${(worst * 255).toFixed(1)}/255)` : ''}`,
    );
  }
}

// ---- (c) no world matrix: the corners are the unit view's ----------------------------------------------------------------
{
  const buf = makeTexelBuffer();
  const base = encodeSeg(
    mkCubic([2, 3], [5, 9], [11, -4], [14, 6]),
    buf,
    true,
    true,
    [0, 0],
    [0, 0],
    0,
  );
  const prim = new Float32Array(buf.floats.subarray(0, buf.count * 4));
  const st = { halfW: 0.7, cap: 2, join: 0, miterLimit: 4 };
  const v = mkView([0, 0, 64, 64], 64, 64, null);
  const a = quadOf(prim, base, st, v).flat(),
    b = quadOf(prim, base, st, { ...v, worldM: [1, 0, 0, 0, 1, 0, 0, 0, 1] }).flat();
  const u = quadOf(prim, base, st, null).flat();
  ok(
    a.every((x, i) => x === u[i]),
    `(c) with no world matrix the corners are the unit view's bit for bit (${a.map((x) => x.toFixed(3)).join(' ')})`,
  );
  ok(
    b.every((x, i) => x === a[i]),
    '(c) ...and the identity world matrix gives the same corners',
  );
}
console.log(fail ? `SPLIT-STROKE-WORLD-REACH FAIL (${fail})` : 'SPLIT-STROKE-WORLD-REACH PASS');
process.exit(fail ? 1 : 0);

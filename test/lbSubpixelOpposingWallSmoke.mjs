// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbSubpixelOpposingWallSmoke — a feature narrower than a pixel must be antialiased by the area
// BETWEEN its two walls, not by one wall's half-plane.
//
// A kind-0 interior face carries up to three boundary LINES, and the kernel already
// computes the exact area of the pixel box on the fill side of two of them at once
// (`exactBoxCov2`, the `vLineT > 0` branch of _lbCoverage.glsl). Below a pixel of feature width the
// two walls of a bar, a stem or a sliver both cross the same box, so the second slot has to hold
// the OPPOSING wall -- otherwise the face returns one half-plane's area and the feature reads too
// dark. With one half-plane, 40 bars at 512 px (probes/lbAccuracy/_lbAaAudit.mjs) read 0.5 px bars
// at +20.8% net ink and 1.5 px squares at +16.4%, every px^2 of it from the kind-0 line rows.
//
// A mesher can lose that slot two ways, and this pins both:
//   * a face that owns a boundary edge along a whole side but whose third vertex is off that line
//     must still run findSecondLine (an `ownD <= _eps` guard would skip it and ship NO second line);
//   * an ORTHOGONAL partner touching the face (distance 0) must not outrank the opposing wall a
//     feature-width away, or the face carries the bar's CAP instead of its far side.
//
// IT MUST STAY SCALE-FREE. A mesh is reused at every zoom (the analytic-only rule), so the mesher
// may not ask how wide a pixel is -- and it does not need to: the opposing wall is INERT wherever
// it is more than a box away (its half-plane saturates, exactBoxCov2 returns the near wall's own
// area) and decisive below that. The structural half of this test asserts the row is there at both
// a sub-pixel and a many-pixel authored width, which is what "scale-free" means here.
//
// No GL. Coverage comes from the CPU twin of the shipping kernel (probes/lbAccuracy/_lbKernel.mjs)
// fed the packed mesh; the truth for an axis-aligned rectangle is exact box overlap in closed form,
// with no quadrature at all.
import { buildLbShape } from '../src/renderer/lbBuildCore.js';
import { SEG_LINE } from '../src/primitives/seg.js';
import { decodeVert, LBK } from '../probes/lbAccuracy/_lbKernel.mjs';
import { rasterMesh } from '../probes/lbAccuracy/_lbRaster.mjs';

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

const mk = (p1, p2) => ({ type: SEG_LINE, p1, p2 });
const rect = (x, y, w, h) => [
  [
    mk([x, y], [x + w, y]),
    mk([x + w, y], [x + w, y + h]),
    mk([x + w, y + h], [x, y + h]),
    mk([x, y + h], [x, y]),
  ],
];

/// Exact coverage of pixel (i, j) by the axis-aligned rectangle — closed form, no sampling.
const exactRect = (i, j, R, basePx, ox, oy) => {
  const x0 = ox + i * basePx,
    x1 = x0 + basePx,
    y0 = oy + j * basePx,
    y1 = y0 + basePx;
  const ow = Math.max(0, Math.min(x1, R.x + R.w) - Math.max(x0, R.x));
  const oh = Math.max(0, Math.min(y1, R.y + R.h) - Math.max(y0, R.y));
  return (ow * oh) / (basePx * basePx);
};

/// Render one bar with the CPU kernel twin and score it against the exact rectangle.
/// `phase` slides the bar across the pixel grid, in pixels. A bar sitting exactly on a pixel
/// boundary is the one position where a single half-plane happens to be right, so a one-position
/// measurement says nothing; and the CDT is not translation-invariant either (the same rectangle
/// four pixels along gets a different face split), so the caller sweeps whole pixels as well as
/// fractions and reports the aggregate.
function measure(widthPx, basePx, phase) {
  const R = { x: 10 + phase * basePx, y: 20 + phase * basePx, w: widthPx * basePx, h: 6 * basePx };
  const built = buildLbShape(rect(R.x, R.y, R.w, R.h), false, false);
  if (!built || !built.pk || !built.pk.vertexCount) return null;
  const ox = 10 - 8 * basePx,
    oy = 20 - 8 * basePx;
  const N = 24;
  // THE same RASTERIZER THE AUDIT USES, not a second copy of it. A private one here drifted
  // immediately: without GL's top-left tie-break a pixel center on a shared CDT edge is claimed by
  // both triangles and OVER double-counts it, which reads as over-coverage at every bar width.
  const view = {
    N,
    basePx,
    ox,
    oy,
    emX: (i) => ox + (i + 0.5) * basePx,
    emY: (j) => oy + (j + 0.5) * basePx,
  };
  const acc = new Float64Array(N * N).fill(1);
  rasterMesh(built.pk, view, acc, {}, null, null, null);
  let ink = 0,
    ref = 0,
    err = 0,
    n = 0;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const ex = exactRect(i, j, R, basePx, ox, oy);
      const mo = 1 - acc[j * N + i];
      ink += mo;
      ref += ex;
      // The AA question is about the pixels the feature actually antialiases.
      if (ex > 1e-9 && ex < 1 - 1e-9) {
        err += Math.abs(mo - ex);
        n++;
      }
    }
  return { ink, ref, err, n, pk: built.pk };
}

// ── 1. STRUCTURE: the opposing wall is in the face, at every authored width ───────────────────
// A bar is a four-sided outline, so it takes the non-overlapping partition and its interior
// faces carry their local outline as a CHAIN of points (kind 0 with tc.x = 2, the analytic poly-clip of
// _lbCoverage.glsl: P0 = C3.xy, P1 = C3.zw, P2 = C0.xy, P3 = C0.zw, P4 = tc.yz), not the one or two
// boundary LINES (with a corner type) the fast mesh of a polygon with another side count still packs.
// The guarantee this smoke exists for is the same in either encoding: a face that owns one long wall
// of the bar also holds the wall ACROSS the bar, and the kernel's exact area is taken between the two.
// In the chain it reads as the face's first two edges (P0->P1, P2->P3): the long wall and, antiparallel
// to it, the opposing one, a feature-width away. The distance is asserted against the authored width,
// so a face carrying the bar's cap in that slot (the second way the line encoding can lose it) fails too.
function chainFacesOf(pk) {
  const out = [];
  for (let t = 0; t + 2 < pk.vertexCount; t += 3) {
    const a = decodeVert(pk.verts, t + 2);
    if (a.kind !== LBK.INTERIOR || !(a.tc[0] > 1.5)) continue; // line-mode faces are the other encoding
    out.push({ A: [a.C3[0], a.C3[1], a.C3[2], a.C3[3]], B: [a.C0[0], a.C0[1], a.C0[2], a.C0[3]] });
  }
  return out;
}
for (const [label, S] of [
  ['at scale 1', 1],
  ['the same outline at 2^16', 65536],
  ['...and at 2^-16', 1 / 65536],
]) {
  const w = 0.5 * (100 / 512) * S,
    h = 6 * (100 / 512) * S;
  const built = buildLbShape(rect(10 * S, 20 * S, w, h), false, false);
  const faces = built ? chainFacesOf(built.pk) : [];
  // a face owning a long (vertical) wall: its first edge runs along y for most of the bar's length
  const vertical = faces.filter(
    (f) => Math.abs(f.A[0] - f.A[2]) < 1e-6 * h && Math.abs(f.A[1] - f.A[3]) > 0.5 * h,
  );
  const withOpp = vertical.filter((f) => {
    const dyA = f.A[3] - f.A[1],
      dyB = f.B[3] - f.B[1];
    return (
      Math.abs(f.B[0] - f.B[2]) < 1e-6 * h &&
      dyA * dyB < 0 &&
      Math.abs(Math.abs(dyB) - Math.abs(dyA)) < 1e-3 * h &&
      Math.abs(Math.abs(f.A[0] - f.B[0]) - w) < 1e-3 * w
    );
  });
  ok(
    built && built.pk.vertexCount > 0 && faces.length > 0,
    `${label}: the bar's interior faces are chain faces (${faces.length})`,
  );
  ok(vertical.length > 0, `${label}: the bar has faces owning a long wall (${vertical.length})`);
  ok(
    vertical.length > 0 && withOpp.length === vertical.length,
    `${label}: every one of them also carries the OPPOSING wall, antiparallel and one authored width away ` +
      `(${withOpp.length}/${vertical.length})`,
  );
}

// ── 2. COVERAGE: the area between the walls, against the exact rectangle ──────────────────────
// One wall against two, over the same position sweep (LB_SUBPIXEL_REPORT=1 prints the current values):
//
//              net ink              mean AA error
//   width   one wall -> two       one wall -> two
//   0.5 px   -0.38%   -2.59%       0.0111   0.0083
//   1.0 px   +4.31%   +0.66%       0.0262   0.0179
//   1.5 px   +2.61%   +0.35%       0.0179   0.0113
//   3.0 px   +0.55%   -0.56%       0.0102   0.0085
//
// The mean error falls at every width, which is the claim; net ink crosses zero at 0.5 and 3.0, so
// the bound there is the loose "did not get worse in either direction" one. The 3 px row is the
// INERTNESS row: both readings pass it, and it is here so a future change that makes the opposing wall
// bite at ordinary widths shows up as a failure.
const BASE = 100 / 512;
const CASES = [
  ['0.5 px bar', 0.5, 0.05, 0.0095],
  ['1.0 px bar', 1.0, 0.02, 0.022],
  ['1.5 px bar', 1.5, 0.015, 0.015],
  ['3.0 px bar', 3.0, 0.02, 0.012],
];
const PHASES = 16;
for (const [name, w, netMax, meanMax] of CASES) {
  let ink = 0,
    ref = 0,
    err = 0,
    n = 0,
    built = 0;
  for (let k = 0; k < PHASES; k++) {
    const m = measure(w, BASE, (k * 2) / PHASES);
    if (!m) continue;
    built++;
    ink += m.ink;
    ref += m.ref;
    err += m.err;
    n += m.n;
  }
  if (built !== PHASES) {
    fail++;
    console.error(`  FAIL ${name}: ${built}/${PHASES} phases built a mesh`);
    continue;
  }
  const net = ink / ref - 1,
    mean = err / Math.max(1, n);
  if (process.env.LB_SUBPIXEL_REPORT)
    console.log(`  [report] ${name} net ${(net * 100).toFixed(2)}% mean ${mean.toFixed(4)} n ${n}`);
  ok(
    Math.abs(net) <= netMax,
    `${name}: net ink ${(net * 100).toFixed(2)}% over ${PHASES} sub-pixel phases, within +/-${(netMax * 100).toFixed(1)}%`,
  );
  ok(mean <= meanMax, `${name}: mean AA error ${mean.toFixed(4)} within ${meanMax}`);
}

console.log(fail ? `LB-SUBPIXEL-OPPOSING-WALL FAIL (${fail})` : 'LB-SUBPIXEL-OPPOSING-WALL OK');
process.exit(fail ? 1 : 0);

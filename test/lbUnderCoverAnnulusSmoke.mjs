// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbUnderCoverAnnulusSmoke — the mesh-coverage guard must never reject a RING.
//
// `meshUnderCovers` is the one predicate in the builder that can throw a correct mesh away, so it
// promises to opt OUT whenever its bound cannot be trusted: "rejects only when a deliberate
// OVER-estimate of paintable area is under half the true area, so a passing mesh can never have
// been wrongly rejected". The bound is a sum of triangle areas, so it opts out for circles, for
// strip arcs and for ANNULI, whose entire fill is one DISC ring-mode quad (kind 7) that no triangle
// accounts for. Without the ring opt-out the predicate would report "provably cannot cover" for
// every recognized ring, about a mesh that covers the shape exactly
// (probes/lbAccuracy/_underCoverCensus.mjs counts them).
//
// The paths a recognized ring takes do not ask the predicate, which is exactly why this needs a
// test rather than a comment: the moment a caller does ask, a correct ring would decline to Slug
// and nothing in the picture would say why.
//
// The second half keeps this from being vacuous: a mesh that really cannot cover its shape must
// still be rejected.
import { buildLbShape, meshUnderCovers, fastMeshAccepted } from '../src/renderer/lbBuildCore.js';
import { SEG_CUBIC, SEG_LINE } from '../src/primitives/seg.js';

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

/// A circle as four cubics, the form the recognisers accept.
function circle(cx, cy, r, ccw) {
  const k = 0.5522847498307933 * r;
  const P = ccw
    ? [
        [cx, cy - r],
        [cx - r, cy],
        [cx, cy + r],
        [cx + r, cy],
      ]
    : [
        [cx, cy - r],
        [cx + r, cy],
        [cx, cy + r],
        [cx - r, cy],
      ];
  const T = ccw
    ? [
        [-1, 0],
        [0, 1],
        [1, 0],
        [0, -1],
      ]
    : [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const A = P[i],
      B = P[(i + 1) % 4],
      ta = T[i],
      tb = T[(i + 1) % 4];
    out.push({
      type: SEG_CUBIC,
      p1: A,
      p2: [A[0] + ta[0] * k, A[1] + ta[1] * k],
      p3: [B[0] - tb[0] * k, B[1] - tb[1] * k],
      p4: B,
    });
  }
  return out;
}

// ── 1. A RING BUILDS, AND THE GUARD LETS IT THROUGH ──────────────────────────────────────────
for (const [name, rOut, rIn] of [
  ['ring 40/25', 40, 25],
  ['thin ring 40/38', 40, 38],
  ['ring 4/2.5', 4, 2.5],
]) {
  const contours = [circle(50, 50, rOut, false), circle(50, 50, rIn, true)];
  const built = buildLbShape(contours, false, false);
  if (!built || !built.raw) {
    fail++;
    console.error(`  FAIL ${name}: no mesh at all`);
    continue;
  }
  const raw = built.raw;
  const isRing = !!(raw.annuli && raw.annuli.length);
  ok(
    isRing,
    `${name}: builds as an annulus primitive (${(raw.annuli || []).length} ring piece(s), ${built.pk.vertexCount} verts)`,
  );
  if (!isRing) continue;
  ok(
    !meshUnderCovers(raw, contours),
    `${name}: meshUnderCovers says NOTHING about it (the bound cannot see a ring quad)`,
  );
  ok(fastMeshAccepted(raw, contours), `${name}: fastMeshAccepted keeps it`);
}

// ── 2. ...AND THE GUARD IS still A GUARD ─────────────────────────────────────────────────────
// A mesh whose triangles cover a sliver of a big square really cannot paint it, and must be
// rejected — otherwise the first half above is passing for the wrong reason.
{
  const sq = [
    [
      { type: SEG_LINE, p1: [0, 0], p2: [100, 0] },
      { type: SEG_LINE, p1: [100, 0], p2: [100, 100] },
      { type: SEG_LINE, p1: [100, 100], p2: [0, 100] },
      { type: SEG_LINE, p1: [0, 100], p2: [0, 0] },
    ],
  ];
  const starved = {
    interior: new Float32Array([0, 0, 10, 0, 0, 10]),
    quads: [],
    cubics: [],
    edges: [],
    circles: [],
    annuli: [],
    fallback: [],
  };
  ok(meshUnderCovers(starved, sq), 'a 50 unit^2 mesh for a 10000 unit^2 square is still rejected');
  const full = {
    interior: new Float32Array([0, 0, 100, 0, 100, 100, 0, 0, 100, 100, 0, 100]),
    quads: [],
    cubics: [],
    edges: [],
    circles: [],
    annuli: [],
    fallback: [],
  };
  ok(!meshUnderCovers(full, sq), '...and a mesh that does cover the square is not');
}

console.log(fail ? `LB-UNDERCOVER-ANNULUS FAIL (${fail})` : 'LB-UNDERCOVER-ANNULUS OK');
process.exit(fail ? 1 : 0);

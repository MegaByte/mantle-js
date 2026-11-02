// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchDisjoint — ARE CPATCH PATCHES DISJOINT? Adding up the patches that reach a pixel is exact
// only if they partition the shape. Where that premise fails, summing counts the same ink twice —
// which shows as over-paint to ~1.0 on the slot and deep families while quad and star are large
// wins. This answers the premise directly instead of inferring it from a render:
// sample the region on a grid, and for every sample count HOW MANY patches admit it.
//
// A patch admits a point when every one of its constraints is satisfied, using the same packed
// implicit and the same inside-point sign the packer writes into the stream.
import { convertContour } from '../src/renderer/cpatchConvert.js';
import { segImplicitPacked, packedEval } from '../src/geom/cpatchImplicit.js';
import { patchCoverHull } from '../src/renderer/cpatchConvert.js';
const RES = +(process.env.RES || 400);
const SEGS = +(process.env.SEGS || 16);

const ring = (BW) => {
  const cx = 64,
    cy = 64,
    r = 44,
    P = [];
  for (let i = 0; i < SEGS; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / SEGS;
    P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  const out = [];
  for (let i = 0; i < SEGS; i++) {
    const p = P[i],
      q = P[(i + 1) % SEGS];
    const mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2;
    out.push({ t: 'quad', P: [p, [cx + (mx - cx) * BW, cy + (my - cy) * BW], q] });
  }
  return out;
};
const star = () => {
  const P = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    P.push([64 + 46 * Math.cos(a), 64 + 46 * Math.sin(a)]);
  }
  const out = [];
  for (let i = 0; i < 5; i++) out.push({ t: 'line', P: [P[i], P[(i + 1) % 5]] });
  return out;
};
const FAMS = { quad: () => ring(1.18), deep: () => ring(2.6), star };

for (const [name, mk] of Object.entries(FAMS)) {
  const curves = mk();
  let res;
  try {
    res = convertContour(curves, { maxCurves: 8 });
  } catch (e) {
    console.log(`  ${name}: threw ${e.message}`);
    continue;
  }
  const patches = (res && res.patches) || [];
  if (!patches.length) {
    console.log(`  ${name}: no patches`);
    continue;
  }
  // per patch: [{pk, sg}]
  // THE COVER POLYGON BOUNDS IT, and leaving that out is not a small error. A patch's constraints
  // are HALF-SPACES: their intersection is convex and unbounded, so a point far outside the patch
  // can satisfy every one of them and be counted as "in" a patch the rasterizer never shades there.
  // Without this the same measurement reported 31-39% overlap on every family, including the two
  // that do partition cleanly.
  const inPoly = (poly, x, y) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i],
        b = poly[j];
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
        inside = !inside;
    }
    return inside;
  };
  const pp = patches.map((p) => {
    const cs = [];
    for (const seg of p.curves) {
      const pk = segImplicitPacked(seg);
      if (!pk) return null;
      cs.push({ pk, sg: packedEval(pk, p.inside[0], p.inside[1]) >= 0 ? 1 : -1 });
    }
    const hull = patchCoverHull(p.curves) || (p.obb && p.obb.corners) || null;
    return hull ? { cs, hull } : null;
  });
  if (pp.some((x) => !x)) {
    console.log(`  ${name}: unpackable constraint`);
    continue;
  }
  let covered = 0,
    overlap = 0,
    maxN = 0,
    overArea = 0;
  for (let r = 0; r < RES; r++)
    for (let c = 0; c < RES; c++) {
      const x = (128 * (c + 0.5)) / RES,
        y = (128 * (r + 0.5)) / RES;
      let n = 0;
      for (const { cs, hull } of pp) {
        if (!inPoly(hull, x, y)) continue; // the rasterizer never shades it here
        let ok = true;
        for (const { pk, sg } of cs)
          if (sg * packedEval(pk, x, y) < 0) {
            ok = false;
            break;
          }
        if (ok) n++;
      }
      if (n >= 1) covered++;
      if (n >= 2) {
        overlap++;
        overArea += n - 1;
      }
      if (n > maxN) maxN = n;
    }
  const pct = covered ? ((100 * overlap) / covered).toFixed(2) : 'n/a';
  console.log(
    `  ${name.padEnd(6)} ${String(patches.length).padStart(3)} patches   covered ${String(covered).padStart(6)}` +
      `   OVERLAPPED ${String(overlap).padStart(6)} (${pct}%)   max patches on a point ${maxN}   excess ${overArea}`,
  );
}

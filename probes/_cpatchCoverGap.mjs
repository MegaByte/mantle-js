// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// IS THE OUTLINE COVERED? The last AA error is 40 edge pixels the CPatch kernel never runs on, so
// no cover geometry reaches them. This checks that directly and without a GPU: convert a shape the
// way _buildCPatchBundle does, then walk every patch's boundary curve and ask whether ANY patch's
// cover polygon contains the point one ramp-width OUTSIDE it. The AA ramp lives there; a point no
// cover contains is a pixel nothing can shade.
import { parsePathD } from '../src/svg/path.js';
import { convertContour } from '../src/renderer/cpatchConvert.js';
import { patchCoverHull, inPatch, patchEval } from '../src/renderer/cpatchConvert.js';
import { packCPatchContour } from '../src/renderer/cpatchPack.js';
import { _setKeyOrigin } from '../src/geom/lbContour.js';

const SEGS = +(process.env.SEGS || 16),
  FAM = process.env.FAMILY || 'quad';
// Everything here is in EM. The render this models fits an ~88em shape to 256px, so one pixel is
// ~0.344em; the vertex stage dilates each cover by 1.5px and the AA ramp reaches ~0.5px outside the
// outline. Probing further than the ramp, or against an UNDILATED cover, reports gaps that do not
// exist — a first pass did exactly that and called 21% of the ramp uncoverable.
const EMPX = +(process.env.EMPX || 88 / 256);
const DILATE = +(process.env.DILATE || 1.5) * EMPX; // what the vertex shader adds
const RAMP = +(process.env.RAMP || 0.5) * EMPX; // how far out the ramp actually reaches
const ring = () => {
  const cx = 64,
    cy = 64,
    r = 44,
    P = [];
  for (let i = 0; i < SEGS; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / SEGS;
    P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  let d = 'M' + P[0][0].toFixed(6) + ' ' + P[0][1].toFixed(6);
  for (let i = 0; i < SEGS; i++) {
    const p = P[i],
      q = P[(i + 1) % SEGS],
      mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2,
      bx = cx + (mx - cx) * 1.18,
      by = cy + (my - cy) * 1.18;
    d +=
      FAM === 'line'
        ? ' L' + q[0].toFixed(6) + ' ' + q[1].toFixed(6)
        : ' Q' +
          bx.toFixed(6) +
          ' ' +
          by.toFixed(6) +
          ' ' +
          q[0].toFixed(6) +
          ' ' +
          q[1].toFixed(6);
  }
  return d + ' Z';
};

const segs = parsePathD(ring());
const curves = [];
for (const s of segs) {
  const P = [s.p1, s.p2, s.p3, s.p4].filter(Boolean);
  const t =
    s.type === 0
      ? 'line'
      : s.type === 1
        ? 'quad'
        : s.type === 2
          ? 'cubic'
          : s.type === 4
            ? 'rquad'
            : null;
  if (!t) continue;
  const a = P[0],
    b = P[P.length - 1];
  if (t === 'line' && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) continue;
  curves.push({ t, P });
}
const res = convertContour(curves, {});
const patches = res && (res.patches || res);
if (!Array.isArray(patches)) {
  console.log('  convert returned', res && Object.keys(res));
  process.exit(1);
}

// dilate each cover the way the vertex stage does: every vertex out along its edge bisector
const dilate = (poly, d) => {
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i],
      b = poly[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const sgn = area < 0 ? -1 : 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const pv = poly[(i + n - 1) % n],
      cu = poly[i],
      nx = poly[(i + 1) % n];
    const e1x = cu[0] - pv[0],
      e1y = cu[1] - pv[1],
      e2x = nx[0] - cu[0],
      e2y = nx[1] - cu[1];
    const l1 = Math.hypot(e1x, e1y) || 1,
      l2 = Math.hypot(e2x, e2y) || 1;
    let bx = sgn * (e1y / l1) + sgn * (e2y / l2),
      by = -sgn * (e1x / l1) - sgn * (e2x / l2);
    const bl = Math.hypot(bx, by) || 1;
    out.push([cu[0] + (bx / bl) * d, cu[1] + (by / bl) * d]);
  }
  return out;
};
const covers = patches
  .map((p) => patchCoverHull(p.curves) || (p.obb && p.obb.corners))
  .filter(Boolean)
  .map((c) => dilate(c, DILATE));
const inPoly = (poly, x, y) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
};
const at = (c, u) => {
  const P = c.P;
  if (c.t === 'line') return [P[0][0] + (P[1][0] - P[0][0]) * u, P[0][1] + (P[1][1] - P[0][1]) * u];
  if (c.t === 'quad') {
    const m = 1 - u;
    return [
      m * m * P[0][0] + 2 * m * u * P[1][0] + u * u * P[2][0],
      m * m * P[0][1] + 2 * m * u * P[1][1] + u * u * P[2][1],
    ];
  }
  const m = 1 - u;
  return [
    m * m * m * P[0][0] + 3 * m * m * u * P[1][0] + 3 * m * u * u * P[2][0] + u * u * u * P[3][0],
    m * m * m * P[0][1] + 3 * m * m * u * P[1][1] + 3 * m * u * u * P[2][1] + u * u * u * P[3][1],
  ];
};

let probed = 0,
  gaps = 0;
const worst = [];
const cx = 64,
  cy = 64;
for (const p of patches)
  for (const c of p.curves) {
    for (let k = 0; k <= 16; k++) {
      const u = k / 16,
        q = at(c, u);
      // outward = away from the shape center, which is exact for this convex ring
      const dx = q[0] - cx,
        dy = q[1] - cy,
        L = Math.hypot(dx, dy) || 1;
      for (const d of [0.25, 0.5, 1.0]) {
        const x = q[0] + (dx / L) * RAMP * d,
          y = q[1] + (dy / L) * RAMP * d;
        probed++;
        if (!covers.some((poly) => inPoly(poly, x, y))) {
          gaps++;
          if (worst.length < 8) worst.push([x.toFixed(2), y.toFixed(2), d]);
        }
      }
    }
  }
// ...and what the PACKER actually emits: a patch whose implicit will not form is DROPPED, and a
// dropped patch is a hole in the cover that no dilation can fill.
let packed = null;
// the packer keys its dedup on a shared origin; without it the first vertex read throws
try {
  _setKeyOrigin([segs]);
  packed = packCPatchContour(curves, 0, {});
} catch (e) {
  console.log('  pack threw:', String(e.message));
  console.log(String(e.stack).split('\n').slice(1, 4).join('\n'));
  console.log('  patch keys:', Object.keys(patches[0]).join(','));
}
console.log(`\n  ${FAM} ring, ${SEGS} segs -> ${patches.length} patches, ${covers.length} covers`);
if (packed)
  console.log(
    `  packer emitted ${packed.cells} cell(s), DROPPED ${packed.dropped}, unresolved ${packed.unresolved}`,
  );
else console.log('  packer returned null — the whole shape would fall back');
console.log(
  `  probed ${probed} points within the ramp (${(RAMP / EMPX).toFixed(2)}px), covers dilated ${(DILATE / EMPX).toFixed(2)}px; ${gaps} lie in NO cover` +
    (gaps ? '  <-- these are pixels nothing can shade' : '  (every ramp point is coverable)'),
);
for (const w of worst) console.log(`     (${w[0]}, ${w[1]})  at ${w[2]} of the ramp width`);

// ── WHICH PATCH CLAIMS A PIXEL, AND IS IT BOUNDED? ────────────────────────────
// The GPU shows edge pixels saturating at coarse segment counts: every constraint of the patch
// painting them is satisfied, so nothing bounds that direction. Map those pixels back to em and
// ask which patches claim them — and separately, probe far outside the shape for patches that
// still call a point "inside", which is what an unbounded constraint set looks like.
const N = +(process.env.N || 256);
const sampleCurve = (c, u) => at(c, u);
let bx0 = Infinity,
  by0 = Infinity,
  bx1 = -Infinity,
  by1 = -Infinity;
for (const c of curves)
  for (let k = 0; k <= 24; k++) {
    const q = sampleCurve(c, k / 24);
    bx0 = Math.min(bx0, q[0]);
    bx1 = Math.max(bx1, q[0]);
    by0 = Math.min(by0, q[1]);
    by1 = Math.max(by1, q[1]);
  }
const sc = Math.max(bx1 - bx0, by1 - by0) / N; // the renderer fits the CONTENT bbox
const toEm = (px, py) => [bx0 + (px + 0.5) * sc, by0 + (py + 0.5) * sc];
console.log(
  `\n  ink bbox [${bx0.toFixed(2)}, ${by0.toFixed(2)}] .. [${bx1.toFixed(2)}, ${by1.toFixed(2)}]  ->  ${N}px, ${sc.toFixed(4)} em/px`,
);

const PIX = (process.env.PIX || '243,70;222,41;218,37')
  .split(';')
  .filter(Boolean)
  .map((p) => p.split(',').map(Number));
for (const [px, py] of PIX) {
  const [ex, ey] = toEm(px, py);
  const claim = [];
  for (let i = 0; i < patches.length; i++) if (inPatch(patches[i], ex, ey)) claim.push(i);
  const r = Math.hypot(ex - 64, ey - 64);
  console.log(
    `  pixel (${px},${py}) -> em (${ex.toFixed(2)}, ${ey.toFixed(2)})  r=${r.toFixed(2)}  claimed by patch(es) [${claim.join(',')}]`,
  );
}

// Unbounded test: a long way outside the ink bbox, nothing should be inside any patch.
const far = [];
const R = Math.max(bx1 - bx0, by1 - by0);
for (let a = 0; a < 64; a++) {
  const th = (a / 64) * 2 * Math.PI;
  const x = 64 + Math.cos(th) * R,
    y = 64 + Math.sin(th) * R;
  for (let i = 0; i < patches.length; i++)
    if (inPatch(patches[i], x, y)) far.push([i, x.toFixed(1), y.toFixed(1)]);
}
console.log(
  `  probing a ring at ${R.toFixed(1)}em (well outside the shape): ${far.length} point(s) still inside a patch` +
    (far.length ? '  <-- UNBOUNDED' : '  (all patches bounded)'),
);
for (const f of far.slice(0, 6)) console.log(`     patch ${f[0]} claims (${f[1]}, ${f[2]})`);

// ── GROUND TRUTH, computed here, to settle which frame is wrong ───────────────
// Three claims disagree about the same pixel: the GPU paints it 1.000, this probe says no patch
// claims its em point, and the 4x render reference calls it 0.29 covered. Flattening the real
// curves into a fine polygon and integrating the pixel BOX against it answers it without either
// renderer in the loop.
const flat = [];
for (const c of curves) for (let k = 0; k < 128; k++) flat.push(at(c, k / 128));
const inShape = (x, y) => {
  let w = false;
  for (let i = 0, j = flat.length - 1; i < flat.length; j = i++) {
    const a = flat[i],
      b = flat[j];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) w = !w;
  }
  return w;
};
const boxCoverage = (px, py) => {
  let hit = 0;
  const S = 16;
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const [ex, ey] = toEm(px + (i + 0.5) / S - 0.5, py + (j + 0.5) / S - 0.5);
      if (inShape(ex, ey)) hit++;
    }
  return hit / (S * S);
};
console.log('\n  GROUND TRUTH (curves flattened here, no renderer involved):');
for (const [px, py] of PIX) {
  const [ex, ey] = toEm(px, py);
  const r = Math.hypot(ex - 64, ey - 64),
    th = (Math.atan2(ey - 64, ex - 64) * 180) / Math.PI;
  // radius of the outline along this direction, by bisection on inShape
  let lo = 0,
    hi = 200;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    if (inShape(64 + Math.cos((th * Math.PI) / 180) * m, 64 + Math.sin((th * Math.PI) / 180) * m))
      lo = m;
    else hi = m;
  }
  console.log(
    `    pixel (${px},${py})  em (${ex.toFixed(2)}, ${ey.toFixed(2)})  r=${r.toFixed(2)} at ${th.toFixed(1)}deg` +
      `   outline r here = ${lo.toFixed(2)}   centre ${inShape(ex, ey) ? 'INSIDE' : 'outside'}` +
      `   true box coverage ${boxCoverage(px, py).toFixed(3)}`,
  );
}

// ── COVER vs IMPLICITS: which half of inPatch rejects? ────────────────────────
// inPatch tests the cover hull's half-planes AND the curve implicits. The shader tests only the
// implicits — the cover is rasterized geometry, and it is DILATED 1.5px past the hull. If a
// failing point is inside every implicit but outside the cover, that is the whole disagreement:
// the hull is a real part of the patch's boundary that the fragment stage does not enforce.
const affEval2 = (h, x, y) => h[0] * x + h[1] * y + h[2];
console.log('\n  WHICH HALF OF inPatch REJECTS:');
for (const [px, py] of PIX) {
  const [ex, ey] = toEm(px, py);
  let anyImplOk = -1,
    coverRejects = 0,
    implRejects = 0,
    obbWouldReject = 0;
  for (let i = 0; i < patches.length; i++) {
    const pt = patches[i];
    let implOk = true;
    for (let k = 0; k < pt.impls.length; k++)
      if (patchEval(pt, k, ex, ey) < 0) {
        implOk = false;
        break;
      }
    const cov = pt.cover || (pt.obb && pt.obb.lines);
    let coverOk = true;
    if (cov)
      for (const h of cov)
        if (affEval2(h, ex, ey) < 0) {
          coverOk = false;
          break;
        }
    let obbOk = true;
    const ob = pt.obb && pt.obb.lines;
    if (ob)
      for (const h of ob)
        if (affEval2(h, ex, ey) < 0) {
          obbOk = false;
          break;
        }
    if (implOk && !coverOk) {
      coverRejects++;
      if (anyImplOk < 0) anyImplOk = i;
      if (!obbOk) obbWouldReject++;
    }
    if (!implOk) implRejects++;
  }
  console.log(
    `    (${px},${py})  patches passing IMPLICITS but failing the COVER: ${coverRejects}` +
      (coverRejects ? `  (e.g. patch ${anyImplOk})  <-- the shader would paint these` : '') +
      `   patches failing an implicit: ${implRejects}` +
      `   of the cover-only ones, the 4-line OBB would reject ${obbWouldReject}`,
  );
}

// how many half-planes would enforcing the cover cost per patch?
let tc = 0,
  to = 0,
  mx = 0;
for (const p2 of patches) {
  const c = p2.cover ? p2.cover.length : 0;
  tc += c;
  to += p2.obb && p2.obb.lines ? p2.obb.lines.length : 0;
  mx = Math.max(mx, c);
}
console.log(
  `\n  cover half-planes: ${(tc / patches.length).toFixed(1)} per patch (max ${mx}), obb ${(to / patches.length).toFixed(1)};` +
    ` curves ${(patches.reduce((a, p2) => a + p2.curves.length, 0) / patches.length).toFixed(1)} per patch`,
);

// ── ARE THE IMPLICITS ALONE ENOUGH? ──────────────────────────────────────────
// Dokter defines a patch as the INTERSECTION OF HALF-SPACES of its bounding curves. If that holds,
// {all implicits >= 0} IS the patch and the cover polygon is only a rasterization convenience. If
// it does not, the decomposition is under-constrained and the cover is load-bearing — which would
// make the over-paint a converter bug, not a property of the formulation.
console.log('\n  IMPLICITS ALONE vs implicits+cover:');
let loose = 0,
  worstOver = 0;
for (let i = 0; i < patches.length; i++) {
  const pt = patches[i];
  // sample a disc well beyond the patch: is any point inside every implicit but outside the cover?
  let cx = 0,
    cy = 0,
    nn = 0,
    rad = 0;
  for (const c of pt.curves)
    for (const P of c.P || []) {
      cx += P[0];
      cy += P[1];
      nn++;
    }
  cx /= nn;
  cy /= nn;
  for (const c of pt.curves)
    for (const P of c.P || []) rad = Math.max(rad, Math.hypot(P[0] - cx, P[1] - cy));
  let over = 0,
    tot = 0;
  for (let a = 0; a < 96; a++)
    for (let rr = 1.05; rr <= 3.0; rr += 0.25) {
      const th = (a / 96) * 2 * Math.PI,
        x = cx + Math.cos(th) * rad * rr,
        y = cy + Math.sin(th) * rad * rr;
      tot++;
      let implOk = true;
      for (let k = 0; k < pt.impls.length; k++)
        if (patchEval(pt, k, x, y) < 0) {
          implOk = false;
          break;
        }
      if (implOk) over++; // inside every implicit, yet well outside the patch
    }
  if (over) {
    loose++;
    worstOver = Math.max(worstOver, over);
  }
}
console.log(
  `    ${loose} of ${patches.length} patches admit points OUTSIDE themselves on implicits alone` +
    (loose
      ? `  (worst ${worstOver} sample points)  <-- the half-space set does not close the region`
      : '  (the implicits close every patch — the cover is only a convenience)'),
);

// ── IS THE DRAWN HULL LOOSER THAN THE PATCH'S own COVER? ─────────────────────
// inPatch bounds a patch by patch.cover (a half-plane SET). The packer draws patchCoverHull (a
// POLYGON of the control points). If the polygon is looser, the rasterizer generates fragments the
// patch does not contain, the implicits pass, and they are painted — with no dilation needed.
console.log('\n  DRAWN HULL vs patch.cover, at the failing pixels:');
for (const [px, py] of PIX) {
  const [ex, ey] = toEm(px, py);
  for (let i = 0; i < patches.length; i++) {
    const pt = patches[i];
    let implOk = true;
    for (let k = 0; k < pt.impls.length; k++)
      if (patchEval(pt, k, ex, ey) < 0) {
        implOk = false;
        break;
      }
    if (!implOk) continue;
    const cov = pt.cover || (pt.obb && pt.obb.lines) || [];
    let coverOk = true;
    for (const h of cov)
      if (h[0] * ex + h[1] * ey + h[2] < 0) {
        coverOk = false;
        break;
      }
    const hull = patchCoverHull(pt.curves) || (pt.obb && pt.obb.corners);
    const inHull = hull ? inPoly(hull, ex, ey) : false;
    console.log(
      `    (${px},${py})  patch ${i}: implicits PASS, patch.cover ${coverOk ? 'pass' : 'REJECT'}, drawn hull ${inHull ? 'CONTAINS it' : 'excludes it'}` +
        (implOk && !coverOk && inHull ? '   <-- drawn geometry is looser than the patch' : ''),
    );
  }
}

// ── WHY DOES A PATCH NOT PICK UP ITS NEIGHBOUR'S CORNER ARC? ─────────────────
// Endpoint sharing, then the "cannot clip" test, counted separately, so a zero says WHICH of the
// two rejected every candidate rather than merely that none survived.
{
  const { segPt, segImplicitPacked, packedEval } = await import('../src/geom/cpatchImplicit.js');
  const EPS = 1e-9;
  const ends = [];
  for (let pi = 0; pi < patches.length; pi++) {
    const q = patches[pi];
    if (!q.obb) continue;
    for (const seg of q.curves) {
      if (seg.cut) continue;
      ends.push({ pi, seg, a: segPt(seg, 0), b: segPt(seg, 1) });
    }
  }
  const near = (u, v) => Math.abs(u[0] - v[0]) <= EPS && Math.abs(u[1] - v[1]) <= EPS;
  let nOutline = 0,
    nShare = 0,
    nSafe = 0,
    nNoObb = 0;
  for (let pi = 0; pi < patches.length; pi++) {
    const p = patches[pi];
    if (!p.obb) {
      nNoObb++;
      continue;
    }
    const hull = patchCoverHull(p.curves) || p.obb.corners || [];
    const probe = [p.inside, ...hull];
    for (const seg of p.curves) for (const P of seg.P || []) probe.push(P);
    for (const seg of p.curves) {
      if (seg.cut) continue;
      nOutline++;
      const a = segPt(seg, 0),
        b = segPt(seg, 1);
      for (const e of ends) {
        if (e.pi === pi) continue;
        if (!(near(e.a, a) || near(e.a, b) || near(e.b, a) || near(e.b, b))) continue;
        nShare++;
        const pk = segImplicitPacked(e.seg);
        if (!pk) continue;
        const sg = packedEval(pk, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
        let safe = true;
        for (const t of probe)
          if (sg * packedEval(pk, t[0], t[1]) < 0) {
            safe = false;
            break;
          }
        if (safe) nSafe++;
      }
    }
  }
  console.log(
    `\n  CORNER ARCS: ${patches.length} patches (${nNoObb} without an obb), ${nOutline} outline arcs`,
  );
  console.log(`    candidates sharing an endpoint with another patch's arc: ${nShare}`);
  console.log(`    of those, accepted as unable to clip the patch:          ${nSafe}`);
}

// Does the PACKER actually emit them? Counts, not inference.
{
  const r = packCPatchContour(curves, 0, {});
  let maxCount = 0,
    total = 0,
    nv = 0;
  for (let i = 0; i + 24 <= r.verts.length; i += 24) {
    const c = r.verts[i + 20];
    maxCount = Math.max(maxCount, c);
    total += c;
    nv++;
  }
  console.log(
    `  PACKED: ${r.texels.length / 4} texels, ${nv} verts, count/vert max ${maxCount} mean ${(total / Math.max(nv, 1)).toFixed(2)}`,
  );
}

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// silhouetteCrossingSmoke — importSvg({ computeSilhouette }) must union with an intersector that finds
// every crossing, not the bare Bezier clipper.
//
// THE HAZARD. unionPaths with no `intersect` sends quad x cubic and cubic x cubic pairs to the clipper
// alone, and the clipper drops crossings of every angle (see pathBoolean/intersect/exact.js for the
// mechanism and the recall figures). A dropped crossing leaves two DCEL edges crossing in their
// interiors, which fuses the inside and outside face cycles, so the union usually comes back EMPTY:
// two overlapping discs drawn as cubic paths would produce no `__silhouette__` shape at all, which also shifts shapeIds[0] -- the index the importer documents
// for recoloring the outline -- onto the first piece of real art.
//
// (a) THE CONSUMER PATH. Overlapping cubic discs through importSvg, from a deep overlap down to a
//     2.2-degree grazing lens, plus a ring of discs whose union has a hole: the synthetic stroke
//     shape exists, and the Outline hit test (a real consumer of it) hits exactly the band around
//     the union's boundary -- inside the band on both the outer boundary and the hole's, outside the
//     band nowhere, and never across the art's interior.
// (b) deliberate DEGENERACIES, at the union with the intersector the importer passes: a crossing AT a
//     vertex (a T-junction, vertex on vertex, a vertex touching from inside), a shared cubic edge,
//     zero-area slivers, and grazing lenses. The silhouette's even-odd region must equal the union
//     of the inputs at every grid sample.
// (c) the same cases from 1e-6 to 1e6: every tolerance on this path is relative, so the region and
//     the contour count must not move with the size of the drawing.
//
// NOT HERE, ON PURPOSE: a TANGENCY that splits both curves at the touch point, and two DIFFERENT
// parameterizations of one overlapping stretch. Both fail the same way with the bare clipper and with
// this intersector, and flip with the scale, because the DCEL orders a vertex's edges by tangent
// angle alone and the touch leaves those angles tied. That is the planar graph's defect, not a
// missed crossing, and asserting it here would pin noise.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
if (typeof globalThis.DOMParser === 'undefined') {
  globalThis.DOMParser = DOMParser;
  globalThis.XMLSerializer = XMLSerializer;
}
import { importSvg } from '../src/svg/importer.js';
import { fillHits, HitMode } from '../src/hitTest/index.js';
import { unionContours } from '../src/svg/pathBoolean/union.js';
import { pointInShape } from '../src/svg/pathBoolean/planar/fillRule.js';
import { intersectSegmentsExact } from '../src/svg/pathBoolean/intersect/exact.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};

const KAPPA = 0.5522847498307936;
const cub = (a, b, c, d) => ({ type: 2, p1: a, p2: b, p3: c, p4: d });
const rev = (s) => cub(s.p4, s.p3, s.p2, s.p1);
// A disc as four cubics, rotated by `ang` about its center so the joints land where a case wants them.
function disc(cx, cy, r, ang = 0) {
  const rot = (x, y) => [
    cx + Math.cos(ang) * (x - cx) - Math.sin(ang) * (y - cy),
    cy + Math.sin(ang) * (x - cx) + Math.cos(ang) * (y - cy),
  ];
  const P = [
      [cx + r, cy],
      [cx, cy + r],
      [cx - r, cy],
      [cx, cy - r],
    ],
    T = [
      [0, 1],
      [-1, 0],
      [0, -1],
      [1, 0],
    ];
  const segs = [];
  for (let i = 0; i < 4; i++) {
    const a = P[i],
      b = P[(i + 1) % 4],
      ta = T[i],
      tb = T[(i + 1) % 4];
    segs.push(
      cub(
        rot(...a),
        rot(a[0] + KAPPA * r * ta[0], a[1] + KAPPA * r * ta[1]),
        rot(b[0] - KAPPA * r * tb[0], b[1] - KAPPA * r * tb[1]),
        rot(...b),
      ),
    );
  }
  return segs;
}
const evalCubic = (s, t) => {
  const u = 1 - t;
  return [0, 1].map(
    (k) =>
      u * u * u * s.p1[k] + 3 * u * u * t * s.p2[k] + 3 * u * t * t * s.p3[k] + t * t * t * s.p4[k],
  );
};
function splitCubic(s, t) {
  const L = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const ab = L(s.p1, s.p2),
    bc = L(s.p2, s.p3),
    cd = L(s.p3, s.p4),
    abc = L(ab, bc),
    bcd = L(bc, cd),
    m = L(abc, bcd);
  return [cub(s.p1, ab, abc, m), cub(m, bcd, cd, s.p4)];
}
const pathD = (segs) =>
  `M${segs[0].p1.join(' ')}` +
  segs.map((s) => ` C${s.p2.join(' ')} ${s.p3.join(' ')} ${s.p4.join(' ')}`).join('') +
  ' Z';

// ---------------------------------------------------------------------------------------------------
console.log('(a) the consumer path: importSvg + Outline hit test');
const W = 4,
  HALF = W / 2,
  R = 40;
async function silhouetteBundle(discs) {
  const paths = discs
    .map(([cx, cy, r, ang]) => `<path d="${pathD(disc(cx, cy, r, ang))}" fill="#c33"/>`)
    .join('');
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-200 -200 400 400">${paths}</svg>`,
    { computeSilhouette: true, outlineWidth: W },
  );
  return b;
}
// Signed distance to the union of true circles; the kappa cubics sit within 0.03% of r of them, which
// the margins below absorb many times over.
const unionDist = (discs, x, y) =>
  Math.min(...discs.map(([cx, cy, r]) => Math.hypot(x - cx, y - cy) - r));
async function consumerCase(name, discs) {
  const b = await silhouetteBundle(discs);
  const sil = b.shapeIds.findIndex((id) => id.startsWith('__silhouette__'));
  check(
    sil === 0 && b.numShapes === discs.length + 1,
    `${name}: silhouette shape present at index 0 (numShapes ${b.numShapes}, shapeIds[0] ${b.shapeIds[0]})`,
  );
  if (sil !== 0) return;
  let inBand = 0,
    inMiss = 0,
    outBand = 0,
    outHit = 0,
    interior = 0,
    interiorHit = 0;
  for (const [cx, cy, r] of discs) {
    for (let k = 0; k < 96; k++) {
      const a = ((k + 0.37) * 2 * Math.PI) / 96,
        ux = Math.cos(a),
        uy = Math.sin(a);
      for (const off of [-1, 1, -3.5, 3.5, -8]) {
        const x = cx + (r + off) * ux,
          y = cy + (r + off) * uy;
        const d = unionDist(discs, x, y); // < 0 inside the union
        const hit = fillHits(b, x, y, HitMode.Outline).includes(0);
        // Outside the union d IS the distance to its boundary. Inside it is not -- a point can sit
        // beside a rim another disc buries -- so interior points are judged by the nearest rim no
        // other disc covers.
        if (d > 0 && d < HALF - 0.5) {
          inBand++;
          if (!hit) inMiss++;
        } else if (d > HALF + 0.5) {
          outBand++;
          if (hit) outHit++;
        } else if (d < 0 && nearestExposedRim(discs, x, y) > HALF + 0.5) {
          interior++;
          if (hit) interiorHit++;
        }
      }
    }
  }
  check(
    inBand > 0 && inMiss === 0,
    `${name}: ${inBand - inMiss}/${inBand} points in the outline band outside the art hit the outline`,
  );
  check(outHit === 0, `${name}: 0/${outBand} points beyond the band hit it (got ${outHit})`);
  check(
    interiorHit === 0,
    `${name}: 0/${interior} interior points away from every exposed rim hit it (got ${interiorHit})`,
  );
  return b;
}
// Distance to the nearest point of any disc's rim that no other disc covers (the union's true boundary).
function nearestExposedRim(discs, x, y) {
  let best = Infinity;
  for (const [cx, cy, r] of discs)
    for (let k = 0; k < 720; k++) {
      const a = (k * 2 * Math.PI) / 720,
        px = cx + r * Math.cos(a),
        py = cy + r * Math.sin(a);
      if (
        discs.some(([qx, qy, qr]) => (qx !== cx || qy !== cy) && Math.hypot(px - qx, py - qy) < qr)
      )
        continue;
      best = Math.min(best, Math.hypot(px - x, py - y));
    }
  return best;
}
for (const [dist, a0, a1] of [
  [40, 0, 0],
  [60, 0.3, 1.1],
  [75, 0.2, 2.9],
  [79.9, 0.7, 0.1],
  [79.985, 1.3, 0.4],
]) {
  await consumerCase(`two discs ${dist} apart (r ${R})`, [
    [-dist / 2, 0, R, a0],
    [dist / 2, 0, R, a1],
  ]);
}
{
  // A ring of four discs around an uncovered center: the silhouette has an outer boundary AND a hole.
  const ring = [
    [50, 0, R, 0.1],
    [0, 50, R, 0.6],
    [-50, 0, R, 1.7],
    [0, -50, R, 2.3],
  ];
  const b = await consumerCase('ring of four discs (union with a hole)', ring);
  if (b) {
    // Just inside the hole, 1 unit off each disc's inner rim: visible outline, not art.
    let hits = 0;
    const probes = [
      [9, 0],
      [-9, 0],
      [0, 9],
      [0, -9],
    ];
    for (const [x, y] of probes) if (fillHits(b, x, y, HitMode.Outline).includes(0)) hits++;
    check(
      hits === probes.length,
      `ring: the hole carries an outline (${hits}/${probes.length} probes 1 unit inside the hole hit it)`,
    );
    check(
      !fillHits(b, 0, 0, HitMode.Outline).includes(0),
      'ring: the center of the hole, 10 units from every rim, does not',
    );
  }
}

// ---------------------------------------------------------------------------------------------------
const S = (segs) => ({ segs, fillRule: 'nonzero' });
function degenerateCases() {
  const out = [];
  {
    // B's vertex sits exactly ON A's curve (A's cubic evaluated at t = 1/2), with one of B's edges
    // crossing A just beside it: missing that second crossing empties this union.
    const A = disc(0, 0, 10, Math.PI / 4);
    const V = evalCubic(A[3], 0.5);
    out.push({
      name: 'crossing at a vertex: B vertex on A curve (T-junction)',
      shapes: [
        S(A),
        S([
          cub([20, -8], [14, -6], [8, -3], V),
          cub(V, [14, 3], [16, 6], [20, 8]),
          cub([20, 8], [26, 8], [26, -8], [20, -8]),
        ]),
      ],
    });
    out.push({
      name: 'vertex on A curve, both B edges inside A (touch from inside)',
      shapes: [
        S(A),
        S([
          cub([20, -8], [14, -6], [8, -3], V),
          cub(V, [8, 3], [14, 6], [20, 8]),
          cub([20, 8], [26, 8], [26, -8], [20, -8]),
        ]),
      ],
    });
    out.push({
      name: 'crossing at a vertex: vertex on vertex',
      shapes: [
        S(disc(0, 0, 10)),
        S([
          cub([20, -8], [14, -6], [6, -3], [10, 0]),
          cub([10, 0], [14, 3], [16, 6], [20, 8]),
          cub([20, 8], [26, 8], [26, -8], [20, -8]),
        ]),
      ],
    });
  }
  {
    const C = cub([-10, 0], [-5, 8], [5, -8], [10, 0]);
    out.push({
      name: 'coincident: shared cubic edge (abutting)',
      shapes: [
        S([C, cub([10, 0], [10, 12], [-10, 12], [-10, 0])]),
        S([rev(C), cub([-10, 0], [-10, -12], [10, -12], [10, 0])]),
      ],
    });
    out.push({
      name: 'zero-area sliver: there-and-back contour across a disc',
      shapes: [
        S(disc(0, 0, 10, 0.2)),
        S([
          cub([-15, -2], [-5, 6], [5, -6], [15, 2]),
          rev(cub([-15, -2], [-5, 6], [5, -6], [15, 2])),
        ]),
      ],
    });
    const D = disc(0, 0, 10, 0.2);
    out.push({
      name: 'zero-area sliver: a disc edge doubled back on itself',
      shapes: [S(D), S([D[0], rev(D[0])])],
    });
    const [h0] = splitCubic(D[1], 0.5);
    out.push({
      name: 'zero-area sliver: half an edge doubled back',
      shapes: [S(D), S([h0, rev(h0)])],
    });
  }
  out.push({
    name: 'grazing: discs overlapping by 1e-2',
    shapes: [S(disc(0, 0, 10, Math.PI / 4)), S(disc(20 - 1e-2, 0, 10, Math.PI / 5))],
  });
  out.push({
    name: 'grazing: discs overlapping by 1e-4',
    shapes: [S(disc(0, 0, 10, Math.PI / 4)), S(disc(20 - 1e-4, 0, 10, Math.PI / 5))],
  });
  out.push({
    name: 'transversal: three discs, pairwise crossings',
    shapes: [S(disc(0, 0, 10, 0.3)), S(disc(12, 3, 9, 1.1)), S(disc(5, 11, 8, 2.0))],
  });
  return out;
}
const scaleShapes = (shapes, f) =>
  shapes.map((sh) => ({
    ...sh,
    segs: sh.segs.map((s) => cub(...[s.p1, s.p2, s.p3, s.p4].map((p) => [p[0] * f, p[1] * f]))),
  }));
function regionMismatch(shapes, silSegs, G = 56) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sh of shapes)
    for (const s of sh.segs)
      for (const p of [s.p1, s.p2, s.p3, s.p4]) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
  const px = 0.05 * (x1 - x0),
    py = 0.05 * (y1 - y0);
  x0 -= px;
  x1 += px;
  y0 -= py;
  y1 += py;
  let bad = 0,
    inside = 0;
  for (let i = 0; i < G; i++)
    for (let j = 0; j < G; j++) {
      const p = [x0 + ((i + 0.5013) * (x1 - x0)) / G, y0 + ((j + 0.5027) * (y1 - y0)) / G];
      const truth = shapes.some((sh) => pointInShape(p, sh.segs, sh.fillRule));
      if (truth) inside++;
      if (pointInShape(p, silSegs, 'evenodd') !== truth) bad++;
    }
  return { bad, inside };
}

console.log('(b) deliberate degeneracies, at the union the importer runs');
const base = new Map();
for (const cs of degenerateCases()) {
  const contours = unionContours(cs.shapes, { intersect: intersectSegmentsExact });
  const { bad, inside } = regionMismatch(cs.shapes, contours.flat());
  base.set(cs.name, contours.length);
  check(
    contours.length > 0 && bad === 0,
    `${cs.name}: ${contours.length} contour(s), ${bad} of ${inside}+ samples off the union`,
  );
}

console.log('(c) the same cases across scale');
for (const f of [1e-6, 3.3e-5, 1e-3, 0.37, 1e3, 4.2e4, 1e6]) {
  let worst = 0,
    moved = [];
  for (const cs of degenerateCases()) {
    const shapes = scaleShapes(cs.shapes, f);
    const contours = unionContours(shapes, { intersect: intersectSegmentsExact });
    const { bad } = regionMismatch(shapes, contours.flat(), 40);
    worst = Math.max(worst, bad);
    if (contours.length !== base.get(cs.name))
      moved.push(`${cs.name} ${base.get(cs.name)}->${contours.length}`);
  }
  check(
    worst === 0 && moved.length === 0,
    `scale ${f}: every case matches the union (worst ${worst} samples), contour counts unchanged${moved.length ? ' -- moved: ' + moved.join('; ') : ''}`,
  );
}

if (fail) {
  console.error(`SILHOUETTE-CROSSING FAIL (${fail})`);
  process.exit(1);
}
console.log('SILHOUETTE-CROSSING PASS');

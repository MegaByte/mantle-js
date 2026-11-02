// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Mesh preparation must preserve geometry and coverage records under translation.
// Checks packed data only; pixel accuracy is covered by physical-GPU tests.
import { buildLbShape } from '../src/renderer/lbBuildCore.js';
import { mkLine } from '../src/primitives/seg.js';
// Packed INTERIOR layout from lbPack.js. No shader arithmetic is simulated.
const LBK = { INTERIOR: 0 };
function decodeVert(v, i) {
  const o = i * 24;
  return {
    pos: [...v.slice(o, o + 2)],
    tc: [...v.slice(o + 2, o + 5)],
    kind: Math.floor(v[o + 5] + 1e-4),
    sign: v[o + 6],
    C0: [...v.slice(o + 7, o + 11)],
    C3: [...v.slice(o + 19, o + 23)],
    seam: v[o + 23],
  };
}
import { _kox, _koy, _koScale, _setKeyOrigin, lbFrameOrigin } from '../src/geom/lbContour.js';

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
const warn = console.warn;
console.warn = () => {};

const PX = 100 / 512; // one device pixel at the size these are measured
const W = 0.5 * PX,
  H = 6 * PX,
  Y = 20; // the sub-pixel bar: 0.5 px wide, 6 px tall
const bar = (x0) => [
  [
    mkLine([x0, Y], [x0 + W, Y]),
    mkLine([x0 + W, Y], [x0 + W, Y + H]),
    mkLine([x0 + W, Y + H], [x0, Y + H]),
    mkLine([x0, Y + H], [x0, Y]),
  ],
];

// ── 1. the vertex KEYS are position-independent — `_setKeyOrigin` is not the cause ───────────
{
  const keyOf = (x, y) =>
    Math.round((Math.fround(x) - _kox) * _koScale) * 2097152 +
    Math.round((Math.fround(y) - _koy) * _koScale);
  const keysAt = (x0) => {
    _setKeyOrigin(bar(x0));
    return [
      [x0, Y],
      [x0 + W, Y],
      [x0 + W, Y + H],
      [x0, Y + H],
    ]
      .map(([x, y]) => keyOf(x, y))
      .join(',');
  };
  const base = keysAt(0);
  const moved = [1, 2, 8, 10, 16, 16.25, 32, 64, 128].map(keysAt);
  ok(
    moved.every((k) => k === base),
    `every vertex key is identical at 0, 1, 2, 8, 10, 16, 16.25, 32, 64 and 128 (${base})`,
  );
  // ...and the unit the tolerances are written in is identical too.
  const scales = [0, 1, 16, 16.25, 1000].map((x0) => {
    _setKeyOrigin(bar(x0));
    return _koScale;
  });
  ok(new Set(scales).size === 1, `_koScale is the same at every position (${scales[0]})`);
}

// ── 2. the mesh TOPOLOGY is position-independent ─────────────────────────────────────────────
// Kinds, seams, signs, vertex counts and the triangle geometry with the translation removed.
const kindsOf = (pk) => {
  const out = [];
  for (let t = 0; t + 2 < pk.vertexCount; t += 3) {
    const a = decodeVert(pk.verts, t + 2);
    out.push(`${a.kind}|${a.seam}|${a.sign}`);
  }
  return out.join(';');
};
/// The worst triangle-vertex displacement between two builds, in FLOAT32 ULPS OF THE POSITION.
/// The packed mesh stores absolute coordinates in float32, so a bar at x = 1000 cannot reproduce a
/// bar at x = 0 to better than an ulp there -- that is the format, not the builder, and a test that
/// demanded exactness would be measuring float32 rather than translation invariance.
const maxUlpShift = (pa, pb, x0) => {
  let worst = 0;
  const n = Math.min(pa.vertexCount, pb.vertexCount);
  for (let i = 0; i < n; i++) {
    const a = decodeVert(pa.verts, i).pos,
      b = decodeVert(pb.verts, i).pos;
    const ulp = Math.max(Math.abs(b[0]), Math.abs(b[1]), 1) * 2 ** -23;
    worst = Math.max(worst, Math.abs(b[0] - x0 - a[0]) / ulp, Math.abs(b[1] - a[1]) / ulp);
  }
  return worst;
};
// Normalize the coverage record into the shape frame.
const planOf = (pk, x0) => {
  const out = [];
  for (let t = 0; t + 2 < pk.vertexCount; t += 3) {
    const a = decodeVert(pk.verts, t + 2);
    if (a.kind !== LBK.INTERIOR) continue;
    if (a.tc[0] === 2) {
      // Straight chain: C3=P0,P1, C0=P2,P3, tc.yz=P4.
      out.push([
        2,
        a.C3[0] - x0,
        a.C3[1],
        a.C3[2] - x0,
        a.C3[3],
        a.C0[0] - x0,
        a.C0[1],
        a.C0[2] - x0,
        a.C0[3],
        a.tc[1] - x0,
        a.tc[2],
      ]);
    } else {
      out.push([
        0,
        a.C3[0],
        a.C3[1],
        a.C3[2] - a.C3[0] * x0,
        a.tc[0],
        a.tc[1],
        a.tc[2] - a.tc[0] * x0,
      ]);
    }
  }
  return out;
};
/// Do two row plans describe the same lines? Normals must agree exactly (they are differences of
/// coordinates, so a translation leaves them untouched); the line constants are compared against
/// one float32 ulp of the magnitude the constant was stored at, with a few ulps of headroom.
const planSame = (pa, pb, x0) => {
  if (pa.length !== pb.length) return false;
  const tol = 8 * 2 ** -23 * Math.max(Math.abs(x0), 1) + 1e-9;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i].length !== pb[i].length || pa[i][0] !== pb[i][0]) return false;
    const exact = pa[i][0] === 2 ? [] : [1, 2, 4, 5];
    for (let k = 1; k < pa[i].length; k++) {
      if (exact.includes(k) ? pa[i][k] !== pb[i][k] : Math.abs(pa[i][k] - pb[i][k]) > tol)
        return false;
    }
  }
  return true;
};

// Dyadic and non-dyadic placements, inside and far outside the shape's own binade.
const POSITIONS = [
  0, 1, 2, 4, 8, 10, 12, 15, 16, 16.25, 17.3, 20, 32, 33, 40, 64, 100, 128, 1000, 1000.7,
];
const built = POSITIONS.map((x0) => ({ x0, b: buildLbShape(bar(x0), false, false) }));
ok(
  built.every((r) => r.b && r.b.pk.vertexCount > 0),
  'the bar builds at every position',
);
{
  const v = new Set(built.map((r) => r.b.pk.vertexCount));
  ok(v.size === 1, `every position packs the same vertex count (${[...v].join(', ')})`);
  const t0 = kindsOf(built[0].b.pk);
  const bad = built.filter((r) => kindsOf(r.b.pk) !== t0).map((r) => r.x0);
  ok(
    bad.length === 0,
    `every triangle's kind, seam and sign is identical at all ${POSITIONS.length} positions` +
      (bad.length ? ` — differs at ${bad.join(', ')}` : ''),
  );
  let worstUlp = 0,
    worstAt = 0;
  for (const r of built) {
    const u = maxUlpShift(built[0].b.pk, r.b.pk, r.x0);
    if (u > worstUlp) {
      worstUlp = u;
      worstAt = r.x0;
    }
  }
  ok(
    worstUlp <= 2,
    `...and every vertex lands within ${worstUlp.toFixed(2)} float32 ulps of its origin-build position ` +
      `(worst at x = ${worstAt}) — the geometry is translated, not rebuilt`,
  );
}

// ── 3. THE ROW PLAN, the part a tie-break can move ───────────────────────────────────────────────
{
  const p0 = planOf(built[0].b.pk, 0);
  const bad = built.filter((r) => !planSame(planOf(r.b.pk, r.x0), p0, r.x0)).map((r) => r.x0);
  ok(
    bad.length === 0,
    `the row plan is the origin build's at all ${POSITIONS.length} positions` +
      (bad.length ? ` — differs at [${bad.join(', ')}]` : ''),
  );
  // ...and it is a plan, not an empty list: a build that stopped emitting interior line rows would
  // otherwise satisfy the equality above trivially.
  ok(
    p0.length > 0 && p0.some((r) => Math.abs(r[0]) + Math.abs(r[1]) > 0),
    `and it is a real plan: ${p0.length} interior faces, carrying boundary lines`,
  );
  const frameBad = POSITIONS.filter((x0) => {
    const o = lbFrameOrigin(bar(x0));
    return o[0] !== x0 || o[1] !== Y;
  });
  ok(
    frameBad.length === 0,
    `pinned mechanism: the build frame is the bar's own corner at all ${POSITIONS.length} positions` +
      (frameBad.length ? ` — not at [${frameBad.join(', ')}]` : ''),
  );
  // ...and the comparison can fail. It must reject the plan a position-dependent tie produces -- one face
  // carrying its third line first -- and a line constant moved by twice its own tolerance.
  const swapped = p0.map((r, i) => (i === 0 ? r.map((v, k) => (k === 1 ? v + 1 : v)) : r));
  const xFar = POSITIONS[POSITIONS.length - 1];
  const nudged = p0.map((r, i) =>
    i === 0 ? r.map((v, k) => (k === 3 ? v + 16 * 2 ** -23 * Math.max(Math.abs(xFar), 1) : v)) : r,
  );
  ok(
    !planSame(swapped, p0, 0) && !planSame(nudged, p0, xFar),
    'the plan comparison rejects changed coverage geometry and a coordinate 16 ulps off',
  );
}

console.warn = warn;
console.log(fail ? `LB-TRANSLATION-INVARIANCE FAIL (${fail})` : 'LB-TRANSLATION-INVARIANCE OK');
process.exit(fail ? 1 : 0);

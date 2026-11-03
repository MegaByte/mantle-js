// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPairQuadHullSplitSmoke.mjs — a morph pair subdivides overlapping quad hulls on both poses in lockstep, so a
// ring's hole crescents stay inside the ring at t = 0, 1/2 and 1.
//
// The static partition halves quads whose control triangles overlap before its CDT (lbQuadHullCrossSmoke). The morph
// pair cannot just switch that split off for its source pose (the destination is derived by contour and segment index,
// and a split on one pose alone would desync the two): a ring whose hole is four quarter arcs would keep each hole
// arc's whole control triangle, the control point sits at r * sqrt(2), past the ring's OUTER arc, and the crescent
// would paint solid ink outside the ring in four wedges. So the pair halves the same segments on both poses. Halving at t = 1/2 is linear in the control points for a shared weight, so it
// commutes with the vertex stage's lerp and every in-between pose is the exact split of its own curves.
//
// No GPU: pack the pair's two endpoint meshes and their vertex-wise midpoint, and compare, at samples clear of the
// outline, the kernel's own verdict with the exact fill of the matching pose. The static build is checked the same way.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
(await import('../src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false); // a circular ring would take the annulus SDF
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');
const { buildLoopBlinnPartitionPair } = await import('../src/renderer/lbPartitionPair.js');
const { packLoopBlinnMesh, LB_VERT_FLOATS: S } = await import('../src/renderer/lbPack.js');
const { curveRangeToContours } = await import('../src/renderer/loopBlinn.js');
const { rayWinding } = await import('../src/geom/lbContour.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// Four quarter arcs outside, four inside, wound opposite: the hole arcs' control points reach past the outer arc.
const ring = (cx, cy, R, r) =>
  `M${cx} ${cy - R} A${R} ${R} 0 0 0 ${cx - R} ${cy} A${R} ${R} 0 0 0 ${cx} ${cy + R} ` +
  `A${R} ${R} 0 0 0 ${cx + R} ${cy} A${R} ${R} 0 0 0 ${cx} ${cy - R} Z ` +
  `M${cx} ${cy - r} A${r} ${r} 0 0 1 ${cx + r} ${cy} A${r} ${r} 0 0 1 ${cx} ${cy + r} ` +
  `A${r} ${r} 0 0 1 ${cx - r} ${cy} A${r} ${r} 0 0 1 ${cx} ${cy - r} Z`;
const cases = [
  // Button_blue_pushed's blue ring.
  ['thick arc ring', '0 0 252 252', ring(126, 126, 99.8, 76.2)],
  // The same construction on an ellipse, which no primitive recognizer takes, so it reaches the partition either way.
  [
    'elliptical arc ring',
    '0 0 252 252',
    'M126 46A110 80 0 0 0 16 126A110 80 0 0 0 126 206A110 80 0 0 0 236 126A110 80 0 0 0 126 46Z ' +
      'M126 68A86 58 0 0 1 212 126A86 58 0 0 1 126 184A86 58 0 0 1 40 126A86 58 0 0 1 126 68Z',
  ],
];

const mapContours = (ct, f) =>
  ct.map((c) =>
    c.map((g) => {
      const o = { ...g };
      for (const k of ['p1', 'p2', 'p3', 'p4']) if (g[k]) o[k] = f(g[k], k, c.indexOf(g));
      return o;
    }),
  );

// Over- and under-paint of one packed mesh against the exact fill of its own pose.
function check(verts, count, contours) {
  const inkAt = (x, y) => contours.reduce((s, c) => s + rayWinding(c, x, y), 0) !== 0;
  const tris = [];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of contours)
    for (const g of c)
      for (const P of [g.p1, g.p2, g.p3, g.p4])
        if (P) {
          x0 = Math.min(x0, P[0]);
          x1 = Math.max(x1, P[0]);
          y0 = Math.min(y0, P[1]);
          y1 = Math.max(y1, P[1]);
        }
  const v = verts;
  for (let t = 0; t + 2 < count; t += 3) {
    const o = t * S,
      kind = Math.round(v[o + 5]) & 63;
    if (kind !== 0 && kind !== 5) continue;
    const X = [v[o], v[o + S], v[o + 2 * S]],
      Y = [v[o + 1], v[o + S + 1], v[o + 2 * S + 1]];
    const area = (X[1] - X[0]) * (Y[2] - Y[0]) - (Y[1] - Y[0]) * (X[2] - X[0]);
    // band entries ship as zero-area triangles the vertex stage expands: they are not the mesh's cover
    if (area !== 0) tris.push({ o, kind, X, Y, area });
  }
  // An interior triangle paints what it covers; a crescent paints where sign * (u^2 - v r) < 0, within its chord span
  // and its lone-crescent chord.
  const paints = (T, x, y) => {
    const w0 = ((T.X[1] - x) * (T.Y[2] - y) - (T.Y[1] - y) * (T.X[2] - x)) / T.area;
    const w1 = ((T.X[2] - x) * (T.Y[0] - y) - (T.Y[2] - y) * (T.X[0] - x)) / T.area;
    const w2 = 1 - w0 - w1;
    if (w0 < 0 || w1 < 0 || w2 < 0) return false;
    if (T.kind === 0) return true;
    const o = T.o,
      W = [w0, w1, w2];
    const [U, V, R] = [2, 3, 4].map(
      (k) => W[0] * v[o + k] + W[1] * v[o + S + k] + W[2] * v[o + 2 * S + k],
    );
    const sign = v[o + 6],
      s5 = sign > 0 ? 1 : -1;
    const ax = v[o + 19],
      ay = v[o + 20],
      bx = v[o + 21],
      by = v[o + 22],
      cx = bx - ax,
      cy = by - ay;
    if (
      cx * cx + cy * cy > 0 &&
      ((x - ax) * cx + (y - ay) * cy < 0 || (x - bx) * cx + (y - by) * cy > 0)
    )
      return false;
    if (Math.abs(sign) > 2 && !(s5 * (V - U) < 0)) return false;
    return s5 * (U * U - V * R) < 0;
  };
  // A sample counts only when the fill agrees with itself a small step away in every direction, so the antialiased
  // band (where the kernel ramps rather than decides) never enters the verdict.
  const step = 0.004 * Math.hypot(x1 - x0, y1 - y0);
  const G = 200;
  let used = 0;
  const over = [],
    under = [];
  for (let i = 0; i <= G; i++)
    for (let j = 0; j <= G; j++) {
      const x = x0 + ((x1 - x0) * i) / G,
        y = y0 + ((y1 - y0) * j) / G;
      const ink = inkAt(x, y);
      let clear = true;
      for (let k = 0; k < 8 && clear; k++) {
        const a = (k * Math.PI) / 4;
        if (inkAt(x + step * Math.cos(a), y + step * Math.sin(a)) !== ink) clear = false;
      }
      if (!clear) continue;
      used++;
      const painted = tris.some((T) => paints(T, x, y));
      if (painted && !ink) over.push(`(${x.toFixed(1)},${y.toFixed(1)})`);
      if (!painted && ink) under.push(`(${x.toFixed(1)},${y.toFixed(1)})`);
    }
  return { used, over, under };
}
const report = (label, r) => {
  ok(r.used > 10000, `${label}: samples clear of the outline (${r.used})`);
  ok(
    r.over.length === 0,
    `${label}: nothing painted outside the path` +
      (r.over.length ? ` (${r.over.length}, first ${r.over.slice(0, 3).join(' ')})` : ''),
  );
  ok(
    r.under.length === 0,
    `${label}: nothing left bare inside the path` +
      (r.under.length ? ` (${r.under.length}, first ${r.under.slice(0, 3).join(' ')})` : ''),
  );
};

for (const [name, vb, d] of cases) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><path fill="#7777ff" d="${d}"/></svg>`;
  const b = await importSvg(svg, { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const cf = new Float32Array(b.curves),
    r = b.curveRangesByShape[0];
  const src = curveRangeToContours(cf, r.begin, r.end);

  const out = buildLbBundle({
    curveFloats: cf,
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    ranges: b.curveRangesByShape,
    numShapes: b.numShapes,
  });
  const p = out.packed[0];
  ok(p && !p.slug && p.vertexCount > 0, `${name}: static build has a mesh`);
  if (p && !p.slug) report(`${name} static`, check(p.verts, p.vertexCount, src));

  // A real morph: the destination is the ring grown by a tenth and moved, so the pair's endpoints differ.
  const dst = mapContours(src, (P) => [126 + 1.1 * (P[0] - 126) + 6, 126 + 1.1 * (P[1] - 126) - 4]);
  const pair =
    buildLoopBlinnPartitionPair(src, dst, 'nonzero') ||
    buildLoopBlinnPartitionPair(src, dst, 'nonzero', { plainDstRows: true });
  ok(!!pair, `${name}: the morph pair builds`);
  if (!pair) continue;
  const pkS = packLoopBlinnMesh(pair.src),
    pkD = packLoopBlinnMesh(pair.dst);
  ok(
    pkS.vertexCount > 0 && pkS.vertexCount === pkD.vertexCount,
    `${name}: both poses pack the same vertex count (${pkS.vertexCount})`,
  );
  if (!(pkS.vertexCount > 0 && pkS.vertexCount === pkD.vertexCount)) continue;
  report(`${name} pair t=0`, check(pkS.verts, pkS.vertexCount, src));
  report(`${name} pair t=1`, check(pkD.verts, pkD.vertexCount, dst));
  // The vertex stage lerps every attribute; the midpoint pose is the lerp of the two contours.
  const n = pkS.vertexCount * S,
    mid = new Float32Array(n);
  for (let i = 0; i < n; i++) mid[i] = (pkS.verts[i] + pkD.verts[i]) / 2;
  const midC = src.map((c, ci) =>
    c.map((g, si) => {
      const o = { ...g };
      for (const k of ['p1', 'p2', 'p3', 'p4'])
        if (g[k]) o[k] = [(g[k][0] + dst[ci][si][k][0]) / 2, (g[k][1] + dst[ci][si][k][1]) / 2];
      return o;
    }),
  );
  report(`${name} pair t=1/2`, check(mid, pkS.vertexCount, midC));
}

// lbGpuMorphSmoke's disc: an outer circle and a same-wound inner circle (ink on both sides of it under nonzero) whose
// control points cross the outer chords. The inner hulls fill solid and cannot paint air, so the pair keeps the
// unsplit topology -- split in lockstep, the morph would read 14 px off its static endpoints at 0.43. And
// the outer circle is the same curve in both poses, so its bands must pack the same on both streams: the destination's
// interior sign is verified as well as calibrated: unverified, it can negate every band's end normals on one stream.
{
  const { readFileSync } = await import('fs');
  const load = async (f) => {
    const b = await importSvg(
      readFileSync(new URL('../examples/smoke/' + f, import.meta.url), 'utf8'),
    );
    const r = b.curveRangesByShape[0];
    return curveRangeToContours(new Float32Array(b.curves), r.begin, r.end);
  };
  const sc = await load('lbGpuMorph__SRC.svg'),
    dc = await load('lbGpuMorph__DST.svg');
  const pair =
    buildLoopBlinnPartitionPair(sc, dc, 'nonzero') ||
    buildLoopBlinnPartitionPair(sc, dc, 'nonzero', { plainDstRows: true });
  ok(!!pair, 'invisible inner circle: the morph pair builds');
  if (pair) {
    const segs = (m) => (m.hulls9 || []).length;
    ok(
      segs(pair.src) === 8,
      `invisible inner circle: no quad is split for the invisible boundary (${segs(pair.src)} hulls, 8 authored)`,
    );
    const pkS = packLoopBlinnMesh(pair.src),
      pkD = packLoopBlinnMesh(pair.dst);
    let bands = 0,
      differ = 0;
    for (let v = 0; v < pkS.vertexCount && v < pkD.vertexCount; v++) {
      const o = v * S;
      if ((Math.round(pkS.verts[o + 5]) & 63) !== 12) continue;
      bands++;
      // Fields past the position; the outer contour's bands are the same curve on both poses.
      const X = [pkS.verts[o + 19], pkS.verts[o + 20], pkS.verts[o + 21], pkS.verts[o + 22]];
      const r0 = Math.hypot(X[0] - 100, X[1] - 100),
        r1 = Math.hypot(X[2] - 100, X[3] - 100);
      if (!(r0 > 70 && r1 > 70)) continue;
      for (let f = 2; f < S; f++)
        if (pkS.verts[o + f] !== pkD.verts[o + f]) {
          differ++;
          break;
        }
    }
    ok(
      bands > 0 && differ === 0,
      `invisible inner circle: the outer circle's band vertices pack identically on both streams (${differ} of ${bands} differ)`,
    );
  }
}

if (fail) {
  console.log(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log(
  "\nlbPairQuadHullSplitSmoke: a morph pair splits overlapping quad hulls on both poses and paints each pose's exact fill",
);

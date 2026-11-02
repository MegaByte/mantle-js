// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbAirFaceCrescentSmoke.mjs — the partition's all-air face drop must keep a crescent whose own
// curve runs through it.
//
// A quad crescent's face is the curve's hull: the curve starts and ends on two of its vertices and
// crosses no edge. On a hole's rim the face centroid sits in the hole, so the drop leans entirely on
// seeing the curve inside the face. When the endpoints do not round exactly to float32 (a ring at
// 50 + 20 cos 30), an endpoint containment test misses it and the ring loses two inner-edge
// crescents: a band of ink between the arc and its control point with no triangle over it.
//
// No GPU: build the packed mesh the worker ships and require every sample in the band just past
// each rim to lie inside some triangle. A missing triangle cannot paint, whatever its kernel.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
(await import('../src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false); // the annulus SDF would bypass the partition
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const ring = (
  cx,
  cy,
  R,
  r,
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <path fill="#3366cc" d="M${cx} ${cy - R} A${R} ${R} 0 1 0 ${cx} ${cy + R} A${R} ${R} 0 1 0 ${cx} ${cy - R} Z
    M${cx} ${cy - r} A${r} ${r} 0 1 1 ${cx} ${cy + r} A${r} ${r} 0 1 1 ${cx} ${cy - r} Z"/></svg>`;

const inside = (T, x, y) => {
  const s = (ax, ay, bx, by) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const s1 = s(T[0], T[1], T[2], T[3]),
    s2 = s(T[2], T[3], T[4], T[5]),
    s3 = s(T[4], T[5], T[0], T[1]);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
};

for (const [name, cx, cy, R, r] of [
  ['lbHoleParity ring', 50, 50, 44, 20],
  ['offset ring', 50.1, 49.7, 43.3, 19.7],
]) {
  const b = await importSvg(ring(cx, cy, R, r), { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const out = buildLbBundle({
    curveFloats: new Float32Array(b.curves),
    metaFloats: pm.metaFloats,
    metaFloatsPerShape: pm.floatsPerShape,
    ranges: b.curveRangesByShape,
    numShapes: b.numShapes,
  });
  const p = out.packed[0];
  ok(p && !p.slug && p.vertexCount > 0, `${name}: builds a mesh`);
  if (!p || p.slug) continue;
  const stride = p.verts.length / p.vertexCount;
  const tris = [];
  for (let v = 0; v + 2 < p.vertexCount; v += 3) {
    const T = [];
    for (let k = 0; k < 3; k++) T.push(p.verts[(v + k) * stride], p.verts[(v + k) * stride + 1]);
    // band entries ship as zero-area triangles the vertex stage expands: they are not the mesh's cover
    if (Math.abs((T[2] - T[0]) * (T[5] - T[1]) - (T[4] - T[0]) * (T[3] - T[1])) > 1e-9)
      tris.push(T);
  }
  // just past the inner rim (into the ink, inside the quads' control polygon) and just inside the outer rim
  for (const [rim, rad] of [
    ['inner', r + 0.6],
    ['outer', R - 0.6],
  ]) {
    const bare = [];
    for (let i = 0; i < 720; i++) {
      const a = ((i + 0.5) / 720) * 2 * Math.PI,
        x = cx + rad * Math.cos(a),
        y = cy + rad * Math.sin(a);
      if (!tris.some((T) => inside(T, x, y))) bare.push(`${((a * 180) / Math.PI).toFixed(1)}deg`);
    }
    ok(
      bare.length === 0,
      `${name}: every ${rim}-rim sample lies under a triangle` +
        (bare.length ? ` (${bare.length} bare, first ${bare.slice(0, 4).join(' ')})` : ''),
    );
  }
}

if (fail) {
  console.log(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log(
  '\nlbAirFaceCrescentSmoke: the all-air face drop keeps crescents whose curve runs through the face',
);

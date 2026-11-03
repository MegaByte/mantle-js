// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbQuadHullCrossSmoke.mjs — two quads whose control triangles properly cross are subdivided, so the
// CDT keeps every hull constraint and the mesh paints the path's own fill.
//
// A CDT cannot honor two crossing constraints: recovery inserts one and cavity insertion deletes the
// other, and faces then straddle the missing edge. At a thin tip or on a thin ring that paints solid
// ink outside the path (a face carrying one curve's implicit across the other curve) or leaves ink
// uncovered (a face in the ink handed to the wrong hull). So the partition halves both curves until
// their hulls stop crossing.
//
// No GPU: build the packed mesh the worker ships and compare, at samples clear of the outline, the
// kernel's own verdict with the exact fill. An interior triangle paints what it covers; a crescent
// paints where sign * (u^2 - v r) < 0, within its chord span and its lone-crescent chord.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
(await import('../src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false); // the annulus SDF would bypass the partition
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');
const { curveRangeToContours } = await import('../src/renderer/loopBlinn.js');
const { rayWinding } = await import('../src/geom/lbContour.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const cases = [
  // An even-odd ring of two arcs each, 10 units wide: each outer arc's chord cuts through the inner rim's hulls.
  [
    'thin arc ring',
    '0 0 100 100',
    'evenodd',
    'M50 10 a40 40 0 1 0 0.1 0 Z M50 20 a30 30 0 1 0 0.1 0 Z',
  ],
  // A leaf whose two sides bulge the same way: the inner side's control point sits inside the outer side's hull (bucket).
  [
    'same-way leaf',
    '-25 -34 12 10',
    'nonzero',
    'M -17.85 -27.6 L -14.1 -31.25 Q -19.531 -32.644 -23.725 -26.6 L -23.625 -26.6 Q -22.363 -29.021 -17.85 -27.6 Z',
  ],
  // A long bar with a rounded end made of three quads whose hulls cross at the end (toyBoat): under-fill, not over-paint.
  [
    'rounded bar end',
    '-36 3 72 11',
    'nonzero',
    'M -34 4.8 Q -33.05 8.7 -25.3 9.05 L 34 9.05 L 34 12.05 L 30 12.05 L -25.3 12.05 Q -27.575 11.947 -29.275 11.55 Q -33.329 10.555 -34 7.8 Z',
  ],
  // A sliver whose inner side's control point pokes past the outer side's arc: the hulls NEST without an edge crossing,
  // and the inner hull's face held a piece of the outer curve (crab01).
  [
    'nested sliver',
    '-19.3 13.5 0.5 2.8',
    'evenodd',
    'M -18.875 13.65 Q -19.175 14.972 -19 16.125 Q -19.125 15.107 -18.9 13.95 Q -18.892 13.795 -18.875 13.65 Z',
  ],
];

for (const [name, vb, rule, d] of cases) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><path fill="#3366cc" fill-rule="${rule}" d="${d}"/></svg>`;
  const b = await importSvg(svg, { preserveViewport: true });
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
  const r = b.curveRangesByShape[0];
  const contours = curveRangeToContours(new Float32Array(b.curves), r.begin, r.end);
  const evenodd = rule === 'evenodd';
  const inkAt = (x, y) => {
    const w = contours.reduce((s, c) => s + rayWinding(c, x, y), 0);
    return evenodd ? (w & 1) === 1 : w !== 0;
  };
  const S = p.verts.length / p.vertexCount,
    v = p.verts;
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
  for (let t = 0; t + 2 < p.vertexCount; t += 3) {
    const o = t * S,
      kind = Math.round(v[o + 5]) & 63;
    if (kind !== 0 && kind !== 5) continue;
    const X = [v[o], v[o + S], v[o + 2 * S]],
      Y = [v[o + 1], v[o + S + 1], v[o + 2 * S + 1]];
    const area = (X[1] - X[0]) * (Y[2] - Y[0]) - (Y[1] - Y[0]) * (X[2] - X[0]);
    // band entries ship as zero-area triangles the vertex stage expands: they are not the mesh's cover
    if (area !== 0) tris.push({ o, kind, X, Y, area });
  }
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
  // A sample counts only when the fill agrees with itself a small step away in every direction, so the
  // antialiased band (where the kernel ramps rather than decides) never enters the verdict.
  const step = 0.004 * Math.hypot(x1 - x0, y1 - y0);
  const G = 240;
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
      if (painted && !ink) over.push(`(${x.toFixed(2)},${y.toFixed(2)})`);
      if (!painted && ink) under.push(`(${x.toFixed(2)},${y.toFixed(2)})`);
    }
  ok(used > 10000, `${name}: samples clear of the outline (${used})`);
  ok(
    over.length === 0,
    `${name}: nothing painted outside the path` +
      (over.length ? ` (${over.length}, first ${over.slice(0, 3).join(' ')})` : ''),
  );
  ok(
    under.length === 0,
    `${name}: nothing left bare inside the path` +
      (under.length ? ` (${under.length}, first ${under.slice(0, 3).join(' ')})` : ''),
  );
}

if (fail) {
  console.log(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log(
  '\nlbQuadHullCrossSmoke: crossing quad hulls are subdivided and the partition paints the exact fill',
);

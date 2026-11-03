// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbNotchAirFaceSmoke.mjs — a hull sub-face whose vertices are the outline's own joints is still
// dropped when it is all air.
//
// A long convex quad's control hull can hold a whole notch of the shape: the outline doubles back
// inside it along straight edges, so the CDT carves the hull into faces on both sides of those
// edges. The faces on the notch side carry the quad's implicit, which is negative over all of them,
// and the all-air drop is the only thing between them and the frame. A straddle test that uses a
// closed containment test for each segment's endpoints reads every notch face as straddled, since
// every notch face has a vertex where a contour line ends -- so none is dropped, and they paint the
// notch solid.
//
// No GPU: build the packed mesh the worker ships and require that no interior or crescent triangle
// paints a sample deep inside the notch, using the kernel's own sign (a crescent paints where
// sign * (u^2 - v r) < 0, within its chord span and its lone-crescent chord).
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
(await import('../src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(false);
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

// The quad runs from (25,-8.95) to (5.05,11.35) with its control point far up-left; the staircase
// of lines to its right cuts a notch into the ink. The small concave quad on the staircase keeps
// the shape off the convex earcut fast path, so it takes the partition.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -12 30 26" width="300" height="260">
  <path fill="#0EE0A4" d="M 25 -8.95 Q 4.25 -10.15 5.05 11.35 L 25 11.4 L 25 10.4 L 17.3 10.4 L 17.3 5.35 L 8.85 5.35
    L 8.85 -2.35 L 13.1 -2.35 Q 13.4 -3.15 13.9 -3.35 L 17.3 -4.6 L 17.3 -7.4 L 25 -7.4 Z"/></svg>`;

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
ok(p && !p.slug && p.vertexCount > 0, 'the notched shape builds a mesh');
if (p && !p.slug) {
  const r = b.curveRangesByShape[0];
  const contours = curveRangeToContours(new Float32Array(b.curves), r.begin, r.end);
  const inkAt = (x, y) => contours.reduce((w, c) => w + rayWinding(c, x, y), 0) !== 0;
  const S = p.verts.length / p.vertexCount,
    v = p.verts;
  const tris = [];
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
  // Samples half a unit clear of the notch's walls: the rectangle under the staircase's top step and
  // the tall one to the right of x = 17.3.
  let air = 0;
  const painted = [];
  for (const [x0, x1, y0, y1] of [
    [9.35, 16.8, -1.85, 4.85],
    [17.8, 24.5, -6.9, 9.9],
  ]) {
    for (let i = 0; i <= 24; i++)
      for (let j = 0; j <= 24; j++) {
        const x = x0 + ((x1 - x0) * i) / 24,
          y = y0 + ((y1 - y0) * j) / 24;
        if (inkAt(x, y)) continue;
        air++;
        if (tris.some((T) => paints(T, x, y))) painted.push(`(${x.toFixed(2)},${y.toFixed(2)})`);
      }
  }
  ok(air > 1000, `the notch samples are air (${air})`);
  ok(
    painted.length === 0,
    'no interior or crescent triangle paints the notch' +
      (painted.length
        ? ` (${painted.length} painted, first ${painted.slice(0, 4).join(' ')})`
        : ''),
  );
}

if (fail) {
  console.log(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log(
  '\nlbNotchAirFaceSmoke: all-air hull sub-faces are dropped even when contour lines end on their vertices',
);

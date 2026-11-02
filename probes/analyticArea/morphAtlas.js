// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { parseMetaBin } from '../../src/core/metaBin.js';
// Fixed union control hulls enclose every polynomial pose, including extrema
// that occur at neither endpoint. Pad by one f32 ulp before storing the box.
export function fixedMorphHull(points) {
  const P = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = (ps) => {
    const out = [];
    for (const p of ps) {
      while (out.length > 1 && cr(out.at(-2), out.at(-1), p) <= 0) out.pop();
      out.push(p);
    }
    return out;
  };
  const lo = half(P),
    hi = half(P.slice().reverse());
  lo.pop();
  hi.pop();
  return [...lo, ...hi];
}
export function fixMorphAtlasCovers(sections, atlas, options = {}) {
  const {
      metaFloats: meta,
      floatsPerShape: stride,
      numShapes,
    } = parseMetaBin(sections.meta, sections.metaFloatsPerShape),
    bounds = [],
    hulls = [];
  for (const g of atlas.groups) {
    const [a, b, c, d, tx, ty] = g.matrix;
    for (const [i, [x0, y0, x1, y1]] of g.pieceBboxes.entries()) {
      const P = [
        [x0, y0],
        [x0, y1],
        [x1, y0],
        [x1, y1],
      ].map(([x, y]) => [a * x + c * y + tx, b * x + d * y + ty]);
      const v = [
        Math.min(...P.map((p) => p[0])),
        Math.min(...P.map((p) => p[1])),
        Math.max(...P.map((p) => p[0])),
        Math.max(...P.map((p) => p[1])),
      ];
      const pad = Math.max(1, ...v.map(Math.abs)) * 2 ** -23;
      bounds.push([v[0] - pad, v[1] - pad, v[2] + pad, v[3] + pad]);
      if (options.hull) {
        if (!g.piecePoints?.[i]) throw Error('Fixed hull requires both endpoint control polygons');
        const Q = g.piecePoints[i].map(([x, y]) => [a * x + c * y + tx, b * x + d * y + ty]);
        // Atlas geometry is already in target pixels. Minkowski sum with a
        // one-pixel square encloses the entire box-filter support, plus f32
        // rounding. Disable vertex dilation for this pre-expanded fixed hull.
        const reach = 1 + pad;
        hulls.push(
          fixedMorphHull(
            Q.flatMap(([x, y]) =>
              [
                [-reach, -reach],
                [-reach, reach],
                [reach, -reach],
                [reach, reach],
              ].map(([dx, dy]) => [x + dx, y + dy]),
            ),
          ),
        );
      }
    }
  }
  if (bounds.length !== numShapes) throw Error('Importer changed piece count');
  const byGid = new Map();
  for (let i = 0; i < numShapes; i++) {
    meta.set(bounds[i], i * stride);
    byGid.set(Math.round(meta[i * stride + 14]), { box: bounds[i], hull: hulls[i] });
  }
  const src = new Float32Array(sections.curveGeom),
    out = [];
  for (let i = 0; i + 12 <= src.length;) {
    const n = Math.round(src[i]),
      record = byGid.get(Math.round(src[i + 1])),
      box = record?.box,
      hull = record?.hull;
    if (!box || n <= 0 || i + 12 * (n + 1) > src.length)
      throw Error('Unexpected piece cover chunk');
    if (hull) {
      if (hull.length < 3) throw Error('Degenerate fixed morph hull');
      out.push(3 * (hull.length - 2), ...src.subarray(i + 1, i + 12));
      for (let k = 1; k + 1 < hull.length; k++)
        for (const p of [hull[0], hull[k], hull[k + 1]])
          out.push(...p, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1);
      i += 12 * (n + 1);
      continue;
    }
    out.push(6, ...src.subarray(i + 1, i + 12));
    const [x0, y0, x1, y1] = box,
      P = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y0],
        [x1, y1],
        [x0, y1],
      ],
      N = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, -1],
        [1, 1],
        [-1, 1],
      ];
    for (let j = 0; j < 6; j++) out.push(...P[j], ...N[j], 0, 0, 0, 0, 0, 0, 1, -1);
    i += 12 * (n + 1);
  }
  sections.curveGeom = new Float32Array(out).buffer;
  atlas.stats.fixedHullCovers = !!options.hull;
  let vertices = 0;
  for (let at = 0; at < out.length; at += 12 * (out[at] + 1)) vertices += out[at];
  atlas.stats.fixedCoverVertices = vertices;
  return sections;
}

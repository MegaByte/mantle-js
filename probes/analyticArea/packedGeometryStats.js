// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Validate the actual float32 LB cubics that the chain area routine consumes.
// Axis-aligned draws only. Reverse derivative bounds any backward excursion;
// accepting <= .001 px is explicitly a numerical preparation tolerance.
export function packedGeometryStats(bundle, c) {
  const out = { vertices: 0, bytes: 0, cubicChains: 0, maxReverseDerivativePx: 0, kinds: {} };
  const bb = c.bbox || bundle.globalBBox;
  const px = c.size / Math.max(bb[2], bb[3]);
  const check = (P) => {
    out.cubicChains++;
    for (let axis = 0; axis < 2; axis++) {
      const d = [0, 1, 2].map((i) => 3 * (P[i + 1][axis] - P[i][axis]));
      const a = d[0] - 2 * d[1] + d[2],
        b = 2 * (d[1] - d[0]);
      const t = a ? -b / (2 * a) : -1,
        values = [d[0], d[2]];
      if (t > 0 && t < 1) values.push((a * t + b) * t + d[0]);
      const dir = Math.sign(P[3][axis] - P[0][axis]);
      const reverse = dir
        ? Math.max(0, ...values.map((v) => -dir * v))
        : Math.max(...values.map(Math.abs));
      out.maxReverseDerivativePx = Math.max(out.maxReverseDerivativePx, reverse * px);
    }
  };
  for (const m of bundle._lbMeshes || []) {
    if (!m || m.slug) continue;
    const v = m.verts;
    if (!v) continue;
    out.vertices += v.length / 24;
    out.bytes += v.byteLength;
    if (bundle._fillMeshOwner !== 'lb') continue;
    for (let i = 0; i < v.length; i += 72) {
      const kind = Math.round(v[i + 5]);
      out.kinds[kind] = (out.kinds[kind] || 0) + 1;
      const p = (j) => [v[i + j], v[i + j + 1]];
      if (kind === 0) {
        const mode = v[i + 2];
        if (mode > 3.5) {
          const P = [p(19), p(21), p(7), p(9), p(3)];
          check(mode > 4.5 ? P.slice(1) : P.slice(0, 4));
        }
        if (v[i + 23] > 0.5) check([p(11), p(13), p(15), p(17)]);
      } else if (kind === 4 && v[i + 23] > 9.5) check([p(7), p(9), p(11), p(13)]);
    }
  }
  return out;
}

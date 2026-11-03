// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

const SUB_PLANE = 32 * 2 ** -23;
export function snapSubPrecisionLines(out) {
  let mag = 0;
  for (const sg of out)
    for (const p of sg.P) {
      const m = Math.max(Math.abs(p[0]), Math.abs(p[1]));
      if (m > mag) mag = m;
    }
  const tol = SUB_PLANE * mag;
  let res = out;
  for (let i = res.length - 1; i >= 0 && res.length > 2; i--) {
    const sg = res[i];
    if (sg.t !== 'line' || sg.P.length !== 2 || sg.w != null) continue;
    if (Math.hypot(sg.P[1][0] - sg.P[0][0], sg.P[1][1] - sg.P[0][1]) > tol) continue;
    const n = res.length,
      prev = res[(i + n - 1) % n],
      nxt = res[(i + 1) % n];
    const pe = prev.P[prev.P.length - 1];
    if (Math.hypot(nxt.P[0][0] - pe[0], nxt.P[0][1] - pe[1]) > tol) continue; // the neighbors do not meet through it: a real gap
    // Keep a COPY of the first start, so the join is one value: the next curve starts exactly where the previous one ends.
    const joined = { ...nxt, P: [[pe[0], pe[1]], ...nxt.P.slice(1)] };
    res = res.slice();
    res[(i + 1) % n] = joined;
    res.splice(i, 1);
  }
  return res;
}

export function snapSubPrecisionHandles(out) {
  let mag = 0;
  for (const sg of out)
    for (const p of sg.P) {
      const m = Math.max(Math.abs(p[0]), Math.abs(p[1]));
      if (m > mag) mag = m;
    }
  const plane = SUB_PLANE * mag;
  return out.map((sg) => {
    if (sg.t !== 'cubic' || sg.P.length !== 4) return sg;
    const P = sg.P;
    let len = 0;
    for (let k = 1; k < 4; k++) len += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
    const tol = Math.min(plane, 1e-4 * len);
    const h0 = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]),
      h1 = Math.hypot(P[3][0] - P[2][0], P[3][1] - P[2][1]);
    const z0 = h0 > 0 && h0 <= tol,
      z1 = h1 > 0 && h1 <= tol;
    if (!z0 && !z1) return sg;
    return { ...sg, P: [P[0], z0 ? P[0] : P[1], z1 ? P[3] : P[2], P[3]] };
  });
}

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Whole-interval injectivity and control-hull separation for one native contour.
const EPS = 32 * 2 ** -23;
const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
const mix = (a, b, t) => a.map((p, i) => p.map((v, k) => v + (b[i][k] - v) * t));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
function axes(A, B = [], cardinal = true) {
  const out = cardinal
    ? [
        [1, 0],
        [0, 1],
      ]
    : [];
  for (const P of [A, B])
    for (let i = 0; i < P.length; i++)
      for (let j = i + 1; j < P.length; j++) {
        const d = sub(P[j], P[i]);
        if (d[0] || d[1]) out.push(d, [-d[1], d[0]]);
      }
  return out;
}
function certifyInterval(s, maxDepth = 8) {
  const curves = s.curves,
    coord = Math.max(...curves.flatMap((c) => [...c.p0.flat(), ...c.p1.flat()].map(Math.abs))),
    stats = { visits: 0, maxDepth: 0, curves: curves.length };
  const pad = (n) => EPS * coord * (Math.abs(n[0]) + Math.abs(n[1]));
  function injective(c, a, b) {
    const P = mix(c.p0, c.p1, a),
      Q = mix(c.p0, c.p1, b);
    const ds = [P, Q].flatMap((P) => P.slice(1).map((p, i) => sub(p, P[i])));
    const vectors = ds.filter((d) => d[0] || d[1]);
    const accepts = (n) =>
      dot(n, sub(P.at(-1), P[0])) > pad(n) &&
      dot(n, sub(Q.at(-1), Q[0])) > pad(n) &&
      P.slice(1).every((p, i) => {
        const a = sub(p, P[i]),
          b = sub(Q[i + 1], Q[i]);
        return (!(a[0] || a[1]) && !(b[0] || b[1])) || (dot(n, a) > pad(n) && dot(n, b) > pad(n));
      });
    if (vectors.some(accepts)) return true;
    for (const x of vectors)
      for (const y of vectors) {
        const l = Math.hypot(...x),
          m = Math.hypot(...y);
        if (accepts([x[0] / l + y[0] / m, x[1] / l + y[1] / m])) return true;
      }
    return false;
  }
  function separated(x, y, a, b, joint) {
    let A = [...mix(x.p0, x.p1, a), ...mix(x.p0, x.p1, b)],
      B = [...mix(y.p0, y.p1, a), ...mix(y.p0, y.p1, b)];
    if (joint) {
      const J0 = mix(x.p0, x.p1, a)[joint === 1 ? x.p0.length - 1 : 0],
        J1 = mix(x.p0, x.p1, b)[joint === 1 ? x.p0.length - 1 : 0];
      A = A.map((p, i) => sub(p, i < x.p0.length ? J0 : J1));
      B = B.map((p, i) => sub(p, i < y.p0.length ? J0 : J1));
      function side(P, len, n, sign) {
        for (let i = 0; i < len; i++) {
          const a = P[i],
            b = P[i + len];
          if (!(a[0] || a[1]) && !(b[0] || b[1])) continue;
          if (!(sign * dot(n, a) > pad(n) && sign * dot(n, b) > pad(n))) return false;
        }
        return true;
      }
      const candidates = axes([[0, 0], ...A, ...B]);
      // A normal between the two ray directions can strictly separate an
      // acute joint even when neither ray nor its perpendicular can.
      // Endpoint inequalities below still certify the whole interval.
      for (const u of A)
        for (const v of B) {
          const lu = Math.hypot(...u),
            lv = Math.hypot(...v);
          if (lu && lv) candidates.push([u[0] / lu - v[0] / lv, u[1] / lu - v[1] / lv]);
        }
      return candidates.some((n) =>
        [1, -1].some((sign) => side(A, x.p0.length, n, -sign) && side(B, y.p0.length, n, sign)),
      );
    }
    const separates = (n) => {
      const va = A.map((p) => dot(n, p)),
        vb = B.map((p) => dot(n, p));
      return (
        Math.min(...vb) - Math.max(...va) > 2 * pad(n) ||
        Math.min(...va) - Math.max(...vb) > 2 * pad(n)
      );
    };
    if (separates([1, 0]) || separates([0, 1])) return true;
    return axes(A, B, false).some(separates);
  }
  function cover(test, a = 0, b = 1, depth = 0) {
    stats.visits++;
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    if (stats.visits > 50000) return false;
    if (test(a, b)) return true;
    if (depth >= maxDepth) return false;
    const m = (a + b) / 2;
    return cover(test, a, m, depth + 1) && cover(test, m, b, depth + 1);
  }
  for (let i = 0; i < curves.length; i++)
    if (!cover((a, b) => injective(curves[i], a, b)))
      return { accepted: false, reason: 'injectivity', index: i, ...stats };
  for (let i = 0; i < curves.length; i++)
    for (let j = i + 1; j < curves.length; j++) {
      const joint = j === i + 1 ? 1 : i === 0 && j === curves.length - 1 ? -1 : 0;
      if (!cover((a, b) => separated(curves[i], curves[j], a, b, joint)))
        return { accepted: false, reason: 'separation', pair: [i, j], ...stats };
    }
  return { accepted: true, ...stats };
}
export function certifyPolynomialMorph(A, B) {
  if (
    !A ||
    !B ||
    A.length !== B.length ||
    A.length < 3 ||
    A.length > (A.some((c) => c.t === 'cubic') ? 256 : 64)
  )
    return null;
  const curves = [];
  for (let i = 0; i < A.length; i++) {
    const a = A[i],
      b = B[i],
      n = a.t === 'line' ? 2 : a.t === 'quad' ? 3 : a.t === 'cubic' ? 4 : 0;
    if (!n || a.t !== b.t || a.cut || b.cut || a.P.length !== n || b.P.length !== n) return null;
    if ([...a.P.flat(), ...b.P.flat()].some((x) => !Number.isFinite(x))) return null;
    if (!eq(a.P.at(-1), A[(i + 1) % A.length].P[0]) || !eq(b.P.at(-1), B[(i + 1) % B.length].P[0]))
      return null;
    curves.push({ p0: a.P, p1: b.P });
  }
  const certificate = certifyInterval({ curves });
  if (!certificate.accepted) return null;
  const P = curves.flatMap((c) => [...c.p0, ...c.p1]);
  const bounds = [
    Math.min(...P.map((p) => p[0])),
    Math.min(...P.map((p) => p[1])),
    Math.max(...P.map((p) => p[0])),
    Math.max(...P.map((p) => p[1])),
  ];
  return { certificate, bounds, frame: [Math.fround(bounds[0]), Math.fround(bounds[1])] };
}

// The mesh decoder may normalize nearby joins and remove short segments.
// Admit its curves as native only when every retained control is unchanged.
export function nativePairIsExact(A, B, range, pair, arcPlanes = null) {
  if (
    !(A instanceof Float32Array) ||
    !(B instanceof Float32Array) ||
    !range ||
    !pair ||
    pair.A.length < 3 ||
    pair.A.length > 256
  )
    return false;
  const { begin, end } = range;
  if (
    !Number.isInteger(begin) ||
    !Number.isInteger(end) ||
    begin < 0 ||
    end < begin ||
    begin % 4 ||
    end % 4 ||
    end > A.length ||
    end > B.length
  )
    return false;
  let index = 0,
    subpaths = 0;
  for (let at = begin; at < end;) {
    const h = A[at],
      type = h & 3;
    if (!Number.isInteger(h) || h < 0 || h >= 16 || h !== B[at]) return false;
    if (at === begin || h & 8) subpaths++;
    let X = A,
      Y = B;
    if (type === 3) {
      // Endpoint-form radii interpolate linearly. A common zero axis
      // makes this record a chord throughout the interval.
      X = arcPlanes && arcPlanes.A;
      Y = arcPlanes && arcPlanes.B;
      if (
        !(X instanceof Float32Array) ||
        !(Y instanceof Float32Array) ||
        X.length < end ||
        Y.length < end ||
        !arcPlanes.offsets?.includes(at) ||
        !((X[at + 8] === 0 && Y[at + 8] === 0) || (X[at + 9] === 0 && Y[at + 9] === 0))
      )
        return false;
    }
    const count = type === 0 || type === 3 ? 2 : type === 1 ? 3 : 4;
    const size = type === 0 ? 12 : type === 3 ? 20 : 16,
      data = at + 4;
    if (at + size > end) return false;
    let constant = true;
    for (let k = 1; k < count; k++)
      for (let axis = 0; axis < 2; axis++) {
        if (X[data + 2 * k + axis] !== X[data + axis] || Y[data + 2 * k + axis] !== Y[data + axis])
          constant = false;
      }
    if (!constant) {
      const a = pair.A[index],
        b = pair.B[index];
      const kind = type === 0 || type === 3 ? 'line' : type === 1 ? 'quad' : 'cubic';
      if (!a || !b || a.t !== kind || b.t !== kind || a.P.length !== count || b.P.length !== count)
        return false;
      for (let k = 0; k < count; k++)
        for (let axis = 0; axis < 2; axis++) {
          if (
            !Object.is(X[data + 2 * k + axis], a.P[k][axis]) ||
            !Object.is(Y[data + 2 * k + axis], b.P[k][axis])
          )
            return false;
        }
      index++;
    }
    at += size;
  }
  return subpaths === 1 && index === pair.A.length && index === pair.B.length;
}

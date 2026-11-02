// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Independent float64 circle/half-plane interval oracle; no importer or shader coverage code.
export function largeCircleArea(d) {
  const intersection = (a, b) => [Math.max(a[0], b[0]), Math.min(a[1], b[1])],
    width = (a) => Math.max(0, a[1] - a[0]);
  const half = (a, nx, ny, off, y) => {
    if (nx === 0) return ny * y <= off ? a : [0, -1];
    const x = (off - ny * y) / nx;
    return nx > 0 ? [a[0], Math.min(a[1], x)] : [Math.max(a[0], x), a[1]];
  };
  const disc = (fx, fy, r, y) => {
    const t = r * r - (y + fy) * (y + fy);
    if (t <= 0) return [0, -1];
    const h = Math.sqrt(t);
    return [-fx - h, -fx + h];
  };
  const halfScalar = (a, n, b) => {
    if (n === 0) return b >= 0 ? a : [0, -1];
    return n > 0 ? [a[0], Math.min(a[1], b / n)] : [Math.max(a[0], b / n), a[1]];
  };
  function span(q, y) {
    const n0 = [q.N[0], q.N[1]],
      n1 = [q.N[2], q.N[3]],
      u = [Math.cos(q.ang), Math.sin(q.ang)],
      rho = q.R + (q.kind === 'band' || q.kind === 'sector' ? 6 : 0) + q.e,
      F = [u[0] * rho + n1[0] * y, u[1] * rho + n1[1] * y],
      box = [-0.5, 0.5],
      dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    const disc = (r) => {
      const A = dot(n0, n0),
        B = 2 * dot(n0, F),
        C = dot(F, F) - r * r,
        det = B * B - 4 * A * C;
      if (det <= 0) return [0, -1];
      const sd = Math.sqrt(det),
        z = -0.5 * (B + (B >= 0 ? sd : -sd)),
        r1 = z / A,
        r2 = z !== 0 ? C / z : -B / A;
      return intersection(box, [Math.min(r1, r2), Math.max(r1, r2)]);
    };
    const h = (a, n, off) => halfScalar(a, dot(n, n0), off - dot(n, F));
    if (q.kind === 'band') return width(disc(q.R + 6)) - width(disc(q.R - 6));
    if (q.kind === 'sector') {
      let c = disc(q.R + 6),
        b = disc(q.R - 6);
      const a = q.ang - Math.atan2(0.2, rho),
        r0 = [Math.cos(a), Math.sin(a)],
        r1 = [Math.cos(a + Math.PI / 2), Math.sin(a + Math.PI / 2)];
      for (const n of [
        [r0[1], -r0[0]],
        [-r1[1], r1[0]],
      ]) {
        c = h(c, n, 0);
        b = h(b, n, 0);
      }
      return width(c) - width(b);
    }
    const c = disc(q.R),
      n = [-u[1], u[0]],
      pn = [-n[1], n[0]];
    if (q.kind === 'half-cap') return width(h(c, [-n[0], -n[1]], 0));
    const s = h(h(h(box, n, 0), pn, q.R), [-pn[0], -pn[1]], q.R);
    return width(c) + width(s) - width(intersection(c, s));
  }
  const integral = (f, n) => {
    let a = 0;
    for (let i = 0; i < n; i++) a += f((i + 0.5) / n - 0.5);
    return a / n;
  };
  const base =
      d.rows.find((r) => r.version === 'baseline') || d.rows.find((r) => r.version === 'candidate'),
    cand = d.rows.find((r) => r.version === 'candidate');
  const direct = [];
  for (let i = 0; i < base.helper.queries.length; i++) {
    const q = base.helper.queries[i];
    if (q.scale !== 1) continue;
    const ref = integral((y) => span(q, y), 16384),
      coarse = integral((y) => span(q, y), 4096);
    const errors = {};
    for (const r of d.rows) {
      for (const scale of [2 ** -20, 1, 2 ** 20]) {
        const a = r.helper.queries.find(
          (v) =>
            v.R === q.R &&
            v.e === q.e &&
            v.ang === q.ang &&
            v.kind === q.kind &&
            v.scale === scale &&
            JSON.stringify(v.N) === JSON.stringify(q.N),
        );
        errors[r.version + '-2^' + Math.log2(scale)] = 255 * Math.abs(a.gpu - ref);
      }
    }
    const reach =
        0.5 *
        Math.max(
          Math.hypot(q.N[0] + q.N[2], q.N[1] + q.N[3]),
          Math.hypot(q.N[0] - q.N[2], q.N[1] - q.N[3]),
        ),
      radius = q.R + (['band', 'sector'].includes(q.kind) ? 6 : 0),
      selected = cand.helper.queries.find(
        (v) =>
          v.scale === 1 &&
          v.kind === q.kind &&
          v.R === q.R &&
          v.e === q.e &&
          v.ang === q.ang &&
          JSON.stringify(v.N) === JSON.stringify(q.N),
      ),
      route =
        radius > 4096 * reach
          ? 'legacy-plane'
          : selected.guardOuter === 1
            ? 'early-plane'
            : 'legacy-area';
    direct.push({
      route,
      N: q.N,
      guardOuter: selected.guardOuter,
      guardInner: selected.guardInner,
      kind: q.kind,
      R: q.R,
      e: q.e,
      ang: q.ang,
      ref,
      coarse,
      driftBytes: 255 * Math.abs(ref - coarse),
      errors,
    });
  }
  function realSpan(r, x, y) {
    const fx = x + 0.5 - r.center[0],
      fy = y + 0.5 - r.center[1];
    return (yy) => {
      const Y = fy + yy,
        box = [fx - 0.5, fx + 0.5];
      if (r.kind === 'cap') {
        const c = intersection(box, disc(0, 0, r.R, Y));
        let slab = intersection(box, [0, 4 * r.R]);
        if (Math.abs(Y) > r.R) slab = [0, -1];
        return width(c) + width(slab) - width(intersection(c, slab));
      }
      let c = intersection(box, disc(0, 0, r.R + 6, Y)),
        b = intersection(box, disc(0, 0, r.R - 6, Y));
      if (Y < 0) return 0;
      c = intersection(c, [0, Infinity]);
      b = intersection(b, [0, Infinity]);
      return width(c) - width(b);
    };
  }
  const render = [];
  for (let i = 0; i < base.renders.length; i++) {
    const a = base.renders[i],
      b = cand.renders[i];
    if (a.kind !== b.kind || a.R !== b.R || a.scale !== b.scale) throw Error('Order mismatch');
    const pix = [];
    let maxB = 0,
      maxC = 0,
      maxD = 0,
      worse = 0,
      better = 0;
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) {
        const at = ((127 - y) * 128 + x) * 4,
          pa = a.pixels.slice(at, at + 4),
          pb = b.pixels.slice(at, at + 4),
          fx = x + 0.5 - a.center[0],
          fy = y + 0.5 - a.center[1],
          rho = Math.hypot(fx, fy),
          reach = Math.SQRT1_2;
        const boundary =
          a.kind === 'cap'
            ? Math.abs(rho - a.R) <= reach ||
              Math.abs(fy - a.R) <= 0.5 ||
              Math.abs(fy + a.R) <= 0.5 ||
              Math.abs(fx) <= 0.5 ||
              Math.abs(fx - 4 * a.R) <= 0.5
            : Math.abs(rho - a.R - 6) <= reach ||
              Math.abs(rho - a.R + 6) <= reach ||
              Math.abs(fx) <= 0.5 ||
              Math.abs(fy) <= 0.5;
        const f = realSpan(a, x, y),
          inside =
            a.kind === 'cap'
              ? rho <= a.R || (fx >= 0 && fx <= 4 * a.R && Math.abs(fy) <= a.R)
              : rho <= a.R + 6 && rho >= a.R - 6 && fx >= 0 && fy >= 0,
          ref = boundary ? integral(f, 16384) : +inside,
          coarse = boundary ? integral(f, 4096) : +inside,
          want = [36, 105, 174, 255].map((v) =>
            Math.round(v * 0.65 * (a.mode === 'group' ? 0.7 : 1) * ref),
          );
        const eb = Math.max(...pa.map((v, k) => Math.abs(v - want[k]))),
          ec = Math.max(...pb.map((v, k) => Math.abs(v - want[k]))),
          drift = 255 * 0.65 * (a.mode === 'group' ? 0.7 : 1) * Math.abs(ref - coarse);
        maxB = Math.max(maxB, eb);
        maxC = Math.max(maxC, ec);
        maxD = Math.max(maxD, drift);
        if (ec > eb) worse++;
        if (ec < eb) better++;
        pix.push({
          x,
          y,
          reference: want,
          coverage: ref,
          coarse,
          driftBytes: drift,
          baseline: pa,
          candidate: pb,
          baselineError: eb,
          candidateError: ec,
        });
      }
    render.push({
      mode: a.mode,
      kind: a.kind,
      R: a.R,
      scale: a.scale,
      pixels: pix,
      maxBaselineBytes: maxB,
      maxCandidateBytes: maxC,
      maxDriftBytes: maxD,
      worsePixels: worse,
      betterPixels: better,
    });
  }
  const worst = (a, key) => Math.max(...a.map((x) => x[key]));
  const directMax = {};
  for (const row of direct)
    for (const [k, v] of Object.entries(row.errors)) directMax[k] = Math.max(directMax[k] || 0, v);
  const qualified = direct.filter(
      (r) => r.route === 'early-plane' || JSON.stringify(r.N) === '[1,0,0,1]',
    ),
    qualifiedMax = {};
  for (const row of qualified)
    for (const [k, v] of Object.entries(row.errors))
      qualifiedMax[k] = Math.max(qualifiedMax[k] || 0, v);
  const unchanged = direct.filter(
    (r) => r.route === 'legacy-plane' || (r.guardOuter === 0 && r.guardInner === 0),
  );
  let legacyMaxDifference = 0;
  if (d.rows.some((r) => r.version === 'baseline'))
    for (const q of cand.helper.queries) {
      const a = base.helper.queries.find(
        (v) =>
          v.scale === q.scale &&
          v.kind === q.kind &&
          v.R === q.R &&
          v.e === q.e &&
          v.ang === q.ang &&
          JSON.stringify(v.N) === JSON.stringify(q.N),
      );
      const reach =
          0.5 *
          q.scale *
          Math.max(
            Math.hypot(q.N[0] + q.N[2], q.N[1] + q.N[3]),
            Math.hypot(q.N[0] - q.N[2], q.N[1] - q.N[3]),
          ),
        radius = (q.R + (['band', 'sector'].includes(q.kind) ? 6 : 0)) * q.scale;
      if (radius > 4096 * reach || (q.guardOuter === 0 && q.guardInner === 0))
        legacyMaxDifference = Math.max(legacyMaxDifference, Math.abs(q.gpu - a.gpu));
    }
  const result = {
    qualifiedMax,
    earlyCases: direct.filter((r) => r.route === 'early-plane').length,
    unchangedCases: unchanged.length,
    legacyMaxDifference,
    scope:
      'Independent double-precision horizontal interval geometry, 4096/16384 midpoint row integration on every potential boundary pixel, conservative corner-reach classification elsewhere. Every actual128x128pixel checked; direct helper inputs and authored SVG arc/round-cap area; no shared coverage/importer code.',
    directMax,
    directDrift: worst(direct, 'driftBytes'),
    renderMax: {
      baseline: worst(render, 'maxBaselineBytes'),
      candidate: worst(render, 'maxCandidateBytes'),
      drift: worst(render, 'maxDriftBytes'),
    },
    direct,
    render,
  };
  return result;
}

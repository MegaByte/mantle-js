// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// transformArcConditioningSmoke — a native arc under a transform lands where the transform puts it, to float32
// resolution, however round the ellipse and however close its axes come to x or y.
//
// transformArcNative (svg/transform.js) eigen-decomposes the transformed conic Q' = M^-T Q M^-1. Two differences in it
// cancel in the classic form:
//   - the eigenvector [Qp01, lamSmall - Qp00]: lamSmall - Qp00 is -(hd + sd/2), hd = (Qp00 - Qp11) / 2, and as a
//     difference of the eigenvalue and the diagonal it cancels when the small eigenvalue's axis lies near x (hd < 0),
//     or near a circle. Its rounding is then as large as a small Qp01 and the axis turns by up to a right angle: an
//     ellipse 10 x 100 under rotate(30) rotate(30) rotate(30), a 2.8e-16 rotation residue past 90 degrees, would import
//     13.6 thick instead of 10, and random ellipses whose axes land within a residue of x or y would be off by up to
//     millions of float32 ulps.
//   - disc = tr^2 - 4 dQ, (Qp00 - Qp11)^2 + 4 Qp01^2 through a cancellation: near a circle sd comes out sqrt(eps) of tr,
//     and radii 10 and 10.0000001 under rotate(30) would come out 9.999999992 and 10.000000108 (under half an ulp of
//     the points on its own, but the eigenvector form above reads sd).
// Both take the difference form once the classic one has lost three digits, so a bundle at scale 1 is unchanged by it.
//
// Assertions:
//   (a) the ellipse above, as <ellipse> with a composed transform, in nested groups and as a path of two arcs, imports
//       100 x 10: its meta bbox and the decoded arc's extent;
//   (b) a circle 1e-7 out of round under rotate(30) keeps radii 10.0000001 and 10;
//   (c) a seeded sweep of 40,000 arcs (near-circles, ellipses a transform makes near-circular, ellipses whose axes land
//       within 1e-17 .. 1e-6 rad of x or y, generic ones; centered and not; at 1, 2^-20, 2^20 and a 16384 origin):
//       every point of the transformed arc is within half a float32 ulp of the transformed source point (2^-23 of the
//       largest |coordinate|), at 17 matching parameter fractions.
// With only the eigenvector form reverted to the classic one (a) and (c) fail; with only the discriminant form
// reverted, (b).
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { transformArcNative, parseTransform } = await import('../src/svg/transform.js');
const { mkArc } = await import('../src/svg/segment.js');
const { decodeSegs, SEG_ARC } = await import('../src/hitTest/curveGeom.js');

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const _warn = console.warn;
console.warn = () => {};

console.log('(a) an ellipse 10 x 100 turned 90 degrees by three rotate(30)');
for (const [label, el] of [
  [
    '<ellipse transform="rotate(30) rotate(30) rotate(30)">',
    '<ellipse cx="0" cy="0" rx="10" ry="100" transform="rotate(30) rotate(30) rotate(30)" fill="#345"/>',
  ],
  [
    '<ellipse> in two rotate(30) groups',
    '<g transform="rotate(30)"><g transform="rotate(30)"><ellipse cx="0" cy="0" rx="10" ry="100" transform="rotate(30)" fill="#345"/></g></g>',
  ],
  [
    'a path of two arcs',
    '<path d="M0 -100 A10 100 0 0 1 0 100 A10 100 0 0 1 0 -100 Z" transform="rotate(30) rotate(30) rotate(30)" fill="#345"/>',
  ],
]) {
  const b = await importSvg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-120 -120 240 240">${el}</svg>`,
    { preserveViewport: true },
  );
  const bb = Array.from(new Float32Array(b.meta, 32, 4));
  const r = b.curveRangesByShape[0];
  let y0 = Infinity,
    y1 = -Infinity,
    arcs = 0;
  for (const s of decodeSegs(new Float32Array(b.curves), r.begin, r.end, 0)) {
    if (s.t !== SEG_ARC) continue;
    arcs++;
    for (let i = 0; i <= 256; i++) {
      const th = s.th0 + ((s.th1 - s.th0) * i) / 256;
      const py = s.cy + s.rx * Math.cos(th) * s.sp + s.ry * Math.sin(th) * s.cp;
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
  }
  const ok =
    arcs > 0 &&
    Math.abs(bb[1] + 10) < 1e-4 &&
    Math.abs(bb[3] - 10) < 1e-4 &&
    Math.abs(bb[0] + 100) < 1e-4 &&
    Math.abs(bb[2] - 100) < 1e-4 &&
    Math.abs(y0 + 10) < 1e-3 &&
    Math.abs(y1 - 10) < 1e-3;
  check(
    ok,
    `${label}: bbox ${bb.map((v) => v.toFixed(4)).join(',')}, arcs ${arcs} reach y ${y0.toFixed(4)} .. ${y1.toFixed(4)} (want -10 .. 10)`,
  );
}

console.log('(b) a circle 1e-7 out of round under rotate(30)');
{
  const out = transformArcNative(
    mkArc(5, 5, 10, 10.0000001, 0, Math.PI, 0.3, 0, 1),
    parseTransform('rotate(30)'),
  );
  const big = Math.max(out.rx, out.ry),
    small = Math.min(out.rx, out.ry);
  check(
    Math.abs(big - 10.0000001) < 1e-13 && Math.abs(small - 10) < 1e-13,
    `radii ${out.rx} and ${out.ry} (want 10.0000001 and 10)`,
  );
}

console.log('(c) seeded sweep, error in float32 ulps of the coordinates');
{
  let seed = 20260916;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const TWO = 2 * Math.PI;
  const pt = (s, th) => {
    const cp = Math.cos(s.phi),
      sp = Math.sin(s.phi),
      ct = Math.cos(th),
      st = Math.sin(th);
    return [s.cx + cp * s.rx * ct - sp * s.ry * st, s.cy + sp * s.rx * ct + cp * s.ry * st];
  };
  const rot = (a) => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
  const mul = (A, B) => [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    0,
    0,
  ];
  const KINDS = ['near-circle', 'made near-circular', 'axes near x or y', 'generic'];
  const worst = KINDS.map(() => 0);
  for (let k = 0; k < 40000; k++) {
    const kind = k % 4,
      r = 10 ** (rnd() * 4 - 1),
      S = 2 ** [0, -20, 20][(k >> 2) % 3];
    const delta = (rnd() < 0.5 ? -1 : 1) * 10 ** (-16 + 14 * rnd());
    let rx = r,
      ry,
      phi = rnd() * TWO - Math.PI,
      m;
    if (kind === 0) {
      ry = r * (1 + delta);
      m = mul(rot(rnd() * TWO), [S, 0, 0, S, 0, 0]);
    } else if (kind === 1) {
      ry = r * (0.2 + 3 * rnd());
      m = mul(rot(rnd() * TWO), mul([S, 0, 0, (S * r * (1 + delta)) / ry, 0, 0], rot(-phi)));
    } else if (kind === 2) {
      ry = r * (rnd() < 0.3 ? 1 + delta : 0.05 + 20 * rnd());
      phi = (Math.floor(rnd() * 4) * Math.PI) / 2;
      m = mul(
        rot(
          (Math.floor(rnd() * 4) * Math.PI) / 2 + (rnd() < 0.5 ? -1 : 1) * 10 ** (-17 + 11 * rnd()),
        ),
        [S, 0, 0, S * (rnd() < 0.3 ? -1 : 1), 0, 0],
      );
    } else {
      ry = r * (0.2 + 3 * rnd());
      m = mul(
        rot(rnd() * TWO),
        mul(
          [S * (0.3 + 2 * rnd()), 0, 0, S * (0.3 + 2 * rnd()) * (rnd() < 0.2 ? -1 : 1), 0, 0],
          rot(rnd() * TWO),
        ),
      );
    }
    const centered = (k >> 4) % 2 === 0,
      origin = (k >> 5) % 2 === 0 ? 0 : 16384 * S;
    const cx = centered ? 0 : (rnd() - 0.5) * 4 * r,
      cy = centered ? 0 : (rnd() - 0.5) * 4 * r;
    m[4] = centered ? 0 : origin + (rnd() - 0.5) * r * S;
    m[5] = centered ? 0 : origin + (rnd() - 0.5) * r * S;
    const ts = rnd() * TWO - Math.PI,
      sweep = (rnd() < 0.1 ? TWO : rnd() * TWO) * (rnd() < 0.5 ? -1 : 1);
    const src = mkArc(
      cx,
      cy,
      rx,
      ry,
      ts,
      ts + sweep,
      phi,
      Math.abs(sweep) > Math.PI ? 1 : 0,
      sweep > 0 ? 1 : 0,
    );
    const out = transformArcNative(src, m);
    let err = 0,
      mag = Math.max(Math.abs(out.cx), Math.abs(out.cy), out.rx, out.ry);
    for (let i = 0; i <= 16; i++) {
      const t = i / 16,
        p = pt(src, src.theta_start + t * (src.theta_end - src.theta_start));
      const P = [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
      const Q = pt(out, out.theta_start + t * (out.theta_end - out.theta_start));
      err = Math.max(err, Math.hypot(P[0] - Q[0], P[1] - Q[1]));
      mag = Math.max(mag, Math.abs(P[0]), Math.abs(P[1]));
    }
    worst[kind] = Math.max(worst[kind], err / (2 ** -23 * mag));
  }
  KINDS.forEach((name, i) =>
    check(worst[i] < 0.5, `${name}: worst ${worst[i].toExponential(2)} ulps`),
  );
}

console.warn = _warn;
if (fail) {
  console.error(`TRANSFORM-ARC-CONDITIONING FAIL (${fail})`);
  process.exit(1);
}
console.log('TRANSFORM-ARC-CONDITIONING PASS');

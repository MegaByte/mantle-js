// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CSS basic-shape clip-path (inset, circle, ellipse, polygon, path, rect, xywh with reference boxes) and clip-path on a nested
// <svg>: the region a clipped shape answers a hit test in is the exact outline of the shape, in the user space of
// the element that carries the property, at every scale. Also the stroke bounding box the default (border-box) reference box
// is, in closed form (svg/strokeBox.js), and the grammar's refusals.
import { fillHits, HitMode } from '../src/hitTest/index.js';
import { mkLine, mkQuad, mkCubic } from '../src/svg/segment.js';
// (loaded lazily: a tree without the modules fails the checks below instead of failing to start)
const { parseClipPathShape } = await import('../src/svg/basicShape.js').catch(() => ({
  parseClipPathShape: () => undefined,
}));
const { strokeBoxOf } = await import('../src/svg/strokeBox.js').catch(() => ({
  strokeBoxOf: () => [NaN, NaN, NaN, NaN],
}));

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e * Math.max(1, Math.abs(a), Math.abs(b));

// Regions in the carrier's own space: in(q), d(q) = distance to the boundary (points within 0.25 of an edge are not scored).
const box = (x0, y0, x1, y1) => ({
  in: (q) => q[0] > x0 && q[0] < x1 && q[1] > y0 && q[1] < y1,
  d: (q) =>
    q[0] > x0 && q[0] < x1 && q[1] > y0 && q[1] < y1
      ? Math.min(q[0] - x0, x1 - q[0], q[1] - y0, y1 - q[1])
      : Math.hypot(Math.max(x0 - q[0], 0, q[0] - x1), Math.max(y0 - q[1], 0, q[1] - y1)),
});
const ellipse = (cx, cy, rx, ry) => ({
  in: (q) => ((q[0] - cx) / rx) ** 2 + ((q[1] - cy) / ry) ** 2 < 1,
  d: (q) =>
    Math.abs(Math.sqrt(((q[0] - cx) / rx) ** 2 + ((q[1] - cy) / ry) ** 2) - 1) * Math.min(rx, ry),
});
const and = (...R) => ({
  in: (q) => R.every((r) => r.in(q)),
  d: (q) => Math.min(...R.map((r) => r.d(q))),
});
const not = (R) => ({ in: (q) => !R.in(q), d: R.d });
const poly = (pts) => ({
  in: (q) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i],
        [xj, yj] = pts[j];
      if (yi > q[1] !== yj > q[1] && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  },
  d: (q) => {
    let m = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i],
        b = pts[(i + 1) % pts.length],
        vx = b[0] - a[0],
        vy = b[1] - a[1],
        t = Math.max(
          0,
          Math.min(1, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / (vx * vx + vy * vy)),
        );
      m = Math.min(m, Math.hypot(q[0] - a[0] - t * vx, q[1] - a[1] - t * vy));
    }
    return m;
  },
});
// A rounded rectangle with circular corners of radius r (signed distance form).
const rround = (x0, y0, x1, y1, r) => {
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2,
    hx = (x1 - x0) / 2 - r,
    hy = (y1 - y0) / 2 - r;
  const sd = (q) => {
    const dx = Math.abs(q[0] - cx) - hx,
      dy = Math.abs(q[1] - cy) - hy;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
  };
  return { in: (q) => sd(q) < 0, d: (q) => Math.abs(sd(q)) };
};

const svgOf = (body, s = 1, vb = 100) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb * s} ${vb * s}">` +
  (s === 1 ? body : `<g transform="scale(${s})">${body}</g>`) +
  '</svg>';
// q (viewBox points at scale s) -> carrier space, `inv` the inverse of the carrier's transform (the identity unless given)
async function check(
  name,
  body,
  want,
  {
    scales = [1, 2 ** -20, 2 ** 20],
    inv = (q) => q,
    vb = 100,
    mode = HitMode.Auto,
    empty = false,
  } = {},
) {
  for (const s of scales) {
    const b = await importSvg(svgOf(body, s, vb));
    const o = { mode, worldMatrix: [1 / s, 0, 0, 0, 1 / s, 0, 0, 0, 1] };
    let n = 0,
      nIn = 0,
      bad = 0,
      first = '';
    for (let y = 0.37; y < vb; y += 1.13)
      for (let x = 0.29; x < vb; x += 1.13) {
        const q = inv([x, y]);
        if (want.d(q) < 0.25) continue;
        const w = want.in(q),
          got = fillHits(b, x, y, o).length > 0;
        n++;
        if (w) nIn++;
        if (got !== w) {
          bad++;
          if (!first) first = ` -- first (${x.toFixed(2)}, ${y.toFixed(2)}): ${w ? 'miss' : 'hit'}`;
        }
      }
    ok(
      (empty || nIn > 20) && n - nIn > 20 && bad === 0,
      `${name}${s === 1 ? '' : s < 1 ? ' at scale 2^-20' : ' at scale 2^20'}: ${bad} of ${n} points wrong (${nIn} in)${first}`,
    );
  }
}
// the carrier: x 10..90, y 20..80 (80 x 60); its fill box
const RECT = (st, extra = '') =>
  `<rect x="10" y="20" width="80" height="60" fill="#c00" ${extra} style="${st}"/>`;
const B = box(10, 20, 90, 80);
const diag = Math.sqrt((80 * 80 + 60 * 60) / 2);

console.log('(a) shapes on a rect (fill box)');
await check(
  'circle(25px at 30% 40%)',
  RECT('clip-path:circle(25px at 30% 40%)'),
  and(B, ellipse(34, 44, 25, 25)),
);
await check(
  'circle(50%): a percentage radius is of sqrt((w^2+h^2)/2)',
  RECT('clip-path:circle(50%)'),
  and(B, ellipse(50, 50, diag / 2, diag / 2)),
);
await check(
  'circle(closest-side)',
  RECT('clip-path:circle(closest-side)'),
  and(B, ellipse(50, 50, 30, 30)),
);
await check(
  'circle(farthest-side at left top)',
  RECT('clip-path:circle(farthest-side at left top)'),
  and(B, ellipse(10, 20, 80, 80)),
);
await check(
  'ellipse(30% 20% at 25% 75%)',
  RECT('clip-path:ellipse(30% 20% at 25% 75%)'),
  and(B, ellipse(30, 65, 24, 12)),
);
await check(
  'ellipse at the 4-value position (right 10px bottom 20%)',
  RECT('clip-path:ellipse(10px 10px at right 10px bottom 20%)'),
  and(B, ellipse(80, 68, 10, 10)),
);
await check(
  'inset(5px 10px 15px 20px)',
  RECT('clip-path:inset(5px 10px 15px 20px)'),
  box(30, 25, 80, 65),
);
await check(
  'inset(10px round 20px)',
  RECT('clip-path:inset(10px round 20px)'),
  rround(20, 30, 80, 70, 20),
);
await check(
  'inset(0 round 50px) overlapping radii scale down together',
  RECT('clip-path:inset(0 round 50px)'),
  rround(10, 20, 90, 80, 30),
);
await check(
  'inset with an empty interior clips everything',
  RECT('clip-path:inset(40px 10px)'),
  not(box(-1, -1, 101, 101)),
  { empty: true },
);
await check(
  'polygon(50% 0, 100% 100%, 0 100%)',
  RECT('clip-path:polygon(50% 0, 100% 100%, 0 100%)'),
  and(
    B,
    poly([
      [50, 20],
      [90, 80],
      [10, 80],
    ]),
  ),
);
await check(
  'polygon(evenodd, star)',
  RECT('clip-path:polygon(evenodd, 50% 0, 80% 100%, 0 38%, 100% 38%, 20% 100%)'),
  (() => {
    const P = [
      [50, 20],
      [74, 80],
      [10, 42.8],
      [90, 42.8],
      [26, 80],
    ];
    const p = poly(P);
    const inner = poly([[50, 42.8 - 1]]);
    void inner;
    return {
      in: (q) => {
        let c = 0;
        for (let i = 0; i < 5; i++) {
          const a = P[i],
            b = P[(i + 1) % 5];
          if (
            a[1] > q[1] !== b[1] > q[1] &&
            q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]
          )
            c++;
        }
        return (c & 1) === 1;
      },
      d: p.d,
    };
  })(),
);
await check(
  'path(evenodd, ...) is relative to the box origin',
  RECT("clip-path:path(evenodd, 'M 0 0 H 80 V 60 H 0 Z M 20 15 H 60 V 45 H 20 Z')"),
  and(B, not(box(30, 35, 70, 65))),
);
await check(
  'xywh(10px 5px 30px 20px)',
  RECT('clip-path:xywh(10px 5px 30px 20px)'),
  box(20, 25, 50, 45),
);
await check(
  'rect(5px 60px 40px 10px)',
  RECT('clip-path:rect(5px 60px 40px 10px)'),
  box(20, 25, 70, 60),
);
await check('a lone fill-box is the box', RECT('clip-path:fill-box'), B);
await check(
  'the attribute form',
  `<rect x="10" y="20" width="80" height="60" fill="#c00" clip-path="inset(10px)"/>`,
  box(20, 30, 80, 70),
);
await check(
  'a stylesheet rule',
  `<style>.k{clip-path:circle(30px)}</style><rect class="k" x="10" y="20" width="80" height="60" fill="#c00"/>`,
  and(B, ellipse(50, 50, 30, 30)),
);
await check(
  'em units are of the element font size',
  RECT('font-size:5px;clip-path:inset(2em)'),
  box(20, 30, 80, 70),
);
await check(
  'calc() mixes a percentage and a length',
  RECT('clip-path:inset(calc(10% + 4px))'),
  box(10 + 12, 20 + 10, 90 - 12, 80 - 10),
);
await check('an invalid value (negative radius) is ignored', RECT('clip-path:circle(-5px)'), B, {
  scales: [1],
});

console.log("(b) the carrier's user space and its box");
const rot = (a) => ({ c: Math.cos(a), s: Math.sin(a) });
{
  const a = (25 * Math.PI) / 180,
    { c, s } = rot(a);
  // <g transform="translate(5 3) rotate(25)"><rect ...></g>: the clip is the circle in the rect's own (rotated) space
  const inv = (q) => {
    const x = q[0] - 5,
      y = q[1] - 3;
    return [c * x + s * y, -s * x + c * y];
  };
  await check(
    'a rotated carrier turns the clip with it',
    `<g transform="translate(5 3) rotate(25)"><rect x="10" y="20" width="60" height="40" fill="#c00" style="clip-path:circle(40%)"/></g>`,
    and(
      box(10, 20, 70, 60),
      ellipse(
        40,
        40,
        0.4 * Math.sqrt((60 * 60 + 40 * 40) / 2),
        0.4 * Math.sqrt((60 * 60 + 40 * 40) / 2),
      ),
    ),
    { inv, scales: [1] },
  );
  await check(
    "the element's own transform carries the clip",
    `<rect x="10" y="20" width="60" height="40" fill="#c00" transform="translate(5 3) rotate(25)" style="clip-path:inset(5px round 10px)"/>`,
    rround(15, 25, 65, 55, 10),
    { inv, scales: [1] },
  );
  await check(
    'a non-uniform scale makes the circle an ellipse',
    `<g transform="scale(1.5 .5)"><rect x="4" y="20" width="40" height="80" fill="#c00" style="clip-path:circle(50%)"/></g>`,
    and(
      box(4 * 1.5, 10, 44 * 1.5, 50),
      ellipse(
        24 * 1.5,
        30,
        0.5 * Math.sqrt((40 * 40 + 80 * 80) / 2) * 1.5,
        0.5 * Math.sqrt((40 * 40 + 80 * 80) / 2) * 0.5,
      ),
    ),
    { scales: [1] },
  );
}
await check(
  'a group: the box is the union of its children',
  `<g style="clip-path:circle(50%)"><rect x="10" y="10" width="30" height="30" fill="#c00"/><rect x="50" y="40" width="40" height="50" fill="#0c0"/></g>`,
  (() => {
    const w = 80,
      h = 80,
      r = 0.5 * Math.sqrt((w * w + h * h) / 2);
    const e = ellipse(50, 50, r, r);
    const u = [box(10, 10, 40, 40), box(50, 40, 90, 90)];
    return {
      in: (q) => e.in(q) && u.some((b) => b.in(q)),
      d: (q) => Math.min(e.d(q), Math.min(...u.map((b) => b.d(q)))),
    };
  })(),
);
await check(
  'view-box: the viewBox is the box',
  RECT('clip-path:circle(50%) view-box'),
  and(B, ellipse(50, 50, 50, 50)),
  { scales: [1] },
);
await check(
  'a <use> carries a clip on its own instance',
  `<defs><rect id="r" x="10" y="20" width="30" height="30" fill="#c00"/></defs><use href="#r" x="40" y="20" style="clip-path:circle(50%)"/>`,
  and(
    box(50, 40, 80, 70),
    ellipse(
      65,
      55,
      0.5 * Math.sqrt((30 * 30 + 30 * 30) / 2),
      0.5 * Math.sqrt((30 * 30 + 30 * 30) / 2),
    ),
  ),
  { scales: [1] },
);

console.log('(c) clip-path on a nested <svg>');
await check(
  'url(#clipPath) on a nested svg (userSpaceOnUse)',
  `<defs><clipPath id="c"><circle cx="40" cy="40" r="25"/></clipPath></defs><svg x="10" y="10" width="60" height="60" viewBox="0 0 30 30" clip-path="url(#c)"><rect width="30" height="30" fill="#c00"/></svg>`,
  and(box(10, 10, 70, 70), ellipse(90, 90, 50, 50)),
  { scales: [1] },
); // a userSpaceOnUse clip of a nested svg is in the space inside its viewBox, as in Chrome
await check(
  'a basic shape on a nested svg: its box is its content in the parent space',
  `<svg x="10" y="10" width="60" height="60" viewBox="0 0 30 30" style="clip-path:circle(50%)"><rect width="30" height="30" fill="#c00"/></svg>`,
  and(box(10, 10, 70, 70), ellipse(40, 40, 30, 30)),
  { scales: [1] },
);
await check(
  'a basic shape on an overflow:visible nested svg',
  `<svg x="10" y="10" width="30" height="30" overflow="visible" style="clip-path:inset(0 round 6px)"><rect x="-10" y="-10" width="60" height="60" fill="#c00"/></svg>`,
  rround(0, 0, 60, 60, 6),
  { scales: [1] },
);

console.log('(d) clips compose');
await check(
  'a basic shape inside an inherited url() clip is their intersection',
  `<defs><clipPath id="c"><rect x="0" y="0" width="50" height="100"/></clipPath></defs><g clip-path="url(#c)">${RECT('clip-path:circle(50%)')}</g>`,
  and(B, ellipse(50, 50, diag / 2, diag / 2), box(0, 0, 50, 100)),
  { scales: [1] },
);
await check(
  'a basic shape on a clipPath child',
  `<defs><clipPath id="c"><rect x="10" y="20" width="80" height="60" style="clip-path:circle(50%)"/></clipPath></defs><rect width="100" height="100" fill="#c00" clip-path="url(#c)"/>`,
  and(B, ellipse(50, 50, diag / 2, diag / 2)),
  { scales: [1] },
);

await check(
  "an objectBoundingBox outer clip meets a child's own clip (the outer is kept)",
  `<defs><clipPath id="o" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5"/></clipPath><clipPath id="c"><rect x="0" y="0" width="60" height="100"/></clipPath></defs><g clip-path="url(#o)"><rect x="10" y="10" width="80" height="80" fill="#c00" clip-path="url(#c)"/></g>`,
  and(box(10, 10, 90, 90), ellipse(50, 50, 40, 40), box(0, 0, 60, 100)),
  { scales: [1] },
);
await check(
  'an objectBoundingBox clip on a nested svg',
  `<defs><clipPath id="c" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".4"/></clipPath></defs><svg x="10" y="10" width="60" height="60" viewBox="0 0 30 30" clip-path="url(#c)"><rect x="2" y="2" width="20" height="16" fill="#c00"/></svg>`,
  and(box(14, 14, 54, 46), ellipse(34, 30, 0.4 * 40, 0.4 * 32)),
  { scales: [1] },
);

console.log('(e) the stroke bounding box, in closed form');
{
  const I = [1, 0, 0, 1, 0, 0];
  const bx = (segs, o, M = I) =>
    strokeBoxOf(segs, { miterLimit: 4, capStyle: 0, joinStyle: 0, ...o }, M);
  const eq = (a, b) => a.length === 4 && a.every((v, i) => near(v, b[i], 1e-9));
  const line = [mkLine([0, 0], [10, 0])];
  ok(
    eq(bx(line, { halfW: 2 }), [0, -2, 10, 2]),
    'a butt-capped horizontal line: the cross-section only',
  );
  ok(
    eq(bx(line, { halfW: 2, capStyle: 1, endCapStyle: 1 }), [-2, -2, 12, 2]),
    'round caps: the half discs',
  );
  ok(eq(bx(line, { halfW: 2, capStyle: 2, endCapStyle: 2 }), [-2, -2, 12, 2]), 'square caps');
  const diagL = [mkLine([0, 0], [10, 10])];
  const k = 2 / Math.SQRT2;
  ok(
    eq(bx(diagL, { halfW: 2 }), [-k, -k, 10 + k, 10 + k]),
    'a butt-capped diagonal: the corners of the cross-section',
  );
  const bb = bx(diagL, { halfW: 2, capStyle: 2, endCapStyle: 2 });
  ok(
    near(bb[0], -2 * Math.SQRT2 + 0, 1e-9) && near(bb[2], 10 + 2 * Math.SQRT2, 1e-9),
    'a square cap on a diagonal reaches sqrt(2) halfW along the axis',
  );
  const vee = [mkLine([0, 10], [5, 0]), mkLine([5, 0], [10, 10])];
  const mit = bx(vee, { halfW: 1, joinStyle: 0, miterLimit: 10 });
  const tip = Math.hypot(5, 10),
    miterLen = (1 * tip) / 5; // halfW / sin(half-angle)
  ok(
    near(mit[1], -miterLen, 1e-9),
    `a miter join reaches its tip (${mit[1].toFixed(6)} vs ${(-miterLen).toFixed(6)})`,
  );
  ok(bx(vee, { halfW: 1, joinStyle: 2 })[1] > -miterLen + 0.5, 'a bevel join does not');
  ok(
    near(bx(vee, { halfW: 1, joinStyle: 1 })[1], -1, 1e-9),
    'a round join is the disc about the vertex',
  );
  const arcU = [mkQuad([0, 0], [5, -10], [10, 0])]; // y(t) = -10 * 2t(1-t): extremum -5 at t = .5
  ok(
    near(bx(arcU, { halfW: 1 })[1], -6, 1e-9),
    'a quadratic: the offset curve at its vertical tangent',
  );
  // a stroke wider than the curve's radius of curvature (the offset curve has a cusp of its own): with round caps the ink is a union of
  // discs, so its box is the curve's sampled box grown by halfW along each carrier axis (by halfW times the row length under a map)
  {
    const hair = [mkCubic([22, 50], [28, 16], [36, 16], [42, 50])];
    const sampled = (M) => {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (let i = 0; i <= 20000; i++) {
        const t = i / 20000,
          u = 1 - t,
          c = hair[0];
        const x =
          u * u * u * c.p1[0] +
          3 * u * u * t * c.p2[0] +
          3 * u * t * t * c.p3[0] +
          t * t * t * c.p4[0];
        const y =
          u * u * u * c.p1[1] +
          3 * u * u * t * c.p2[1] +
          3 * u * t * t * c.p3[1] +
          t * t * t * c.p4[1];
        const X = M[0] * x + M[2] * y + M[4],
          Y = M[1] * x + M[3] * y + M[5];
        x0 = Math.min(x0, X);
        x1 = Math.max(x1, X);
        y0 = Math.min(y0, Y);
        y1 = Math.max(y1, Y);
      }
      return [x0, y0, x1, y1];
    };
    for (const [name, M] of [
      ['identity', I],
      [
        'rotated and anisotropic',
        [1.3 * Math.cos(0.5), 1.3 * Math.sin(0.5), -0.7 * Math.sin(0.5), 0.7 * Math.cos(0.5), 3, 4],
      ],
    ]) {
      const h = 13,
        sb = sampled(M),
        rx = Math.hypot(M[0], M[2]),
        ry = Math.hypot(M[1], M[3]);
      const want = [sb[0] - h * rx, sb[1] - h * ry, sb[2] + h * rx, sb[3] + h * ry];
      const got = bx(hair, { halfW: h, capStyle: 1, endCapStyle: 1, joinStyle: 1 }, M);
      ok(
        got.every((v, i) => near(v, want[i], 2e-3)),
        `a hairpin stroked wider than its radius of curvature, ${name}: the box is the disc-union box (${got.map((v) => v.toFixed(3))} vs ${want.map((v) => v.toFixed(3))})`,
      );
    }
  }
  // under a map: the same line rotated 90 degrees (x -> y), a butt cap now has its cross-section along x
  const R90 = [0, 1, -1, 0, 0, 0];
  ok(
    eq(bx(line, { halfW: 2 }, R90), [-2, 0, 2, 10]),
    'under a rotation the box turns with the stroke',
  );
  const S = [2, 0, 0, 3, 5, 7];
  ok(
    eq(bx(line, { halfW: 1, capStyle: 1, endCapStyle: 1 }, S), [5 - 2, 7 - 3, 5 + 20 + 2, 7 + 3]),
    'under a non-uniform scale the round cap is an ellipse',
  );
}

console.log('(f) the grammar');
{
  const bad = [
    'circle(',
    'circle(5px 6px)',
    'ellipse(5px)',
    'inset()',
    'inset(1px 2px 3px 4px 5px)',
    'polygon()',
    'polygon(1px)',
    'polygon(1px 2px 3px)',
    'path(foo)',
    'xywh(1px 2px 3px)',
    'circle(5px) circle(5px)',
    'fill-box stroke-box',
    'blob()',
    'circle(5px at nowhere)',
  ];
  for (const v of bad) ok(parseClipPathShape(v) === null, `refused: ${v}`);
  for (const v of ['none', 'url(#a)', ''])
    ok(parseClipPathShape(v) === null, `not a shape: ${JSON.stringify(v)}`);
  const good = [
    'circle()',
    'circle(closest-side at center)',
    'ellipse(10px 20px at 10% 20%)',
    'inset(1px)',
    'inset(1px round 2px / 3px)',
    'polygon(0 0, 1px 1px, 2px 0)',
    'path("M0 0")',
    'circle(5px) border-box',
    'margin-box inset(0)',
    'rect(auto auto auto auto)',
    'xywh(0 0 1px 1px round 2px)',
  ];
  for (const v of good) ok(parseClipPathShape(v) !== null, `accepted: ${v}`);
}

if (fail) {
  console.error(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nbasicShapeClipSmoke: ok');

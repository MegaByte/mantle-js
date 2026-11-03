// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// hitSpecModelSmoke — the default hit model is the SVG one.
//
// SVG 1.1 §16.4 / SVG 2 interact.html 'pointer-events' and CSS Masking: a point hits the fill iff it is inside the shape's
// interior by the fill rule, and the stroke iff it is inside the exact stroked outline; `painted` means paint != none, never
// alpha > 0; opacity, fill-opacity, stroke-opacity, mask, filter and blend never matter; clip-path cuts the target; markers are not
// separate targets. This file checks all of it against independent oracles:
//   (a) fills: exact winding of finely flattened curves, both fill rules, holes, at 2^-20 .. 2^20;
//   (b) strokes: the stroked outline built from rectangles, join wedges, miter tips and caps (exact point-in-convex-polygon
//       tests), dashes cut by arc length, round strokes of curves as the distance to the flattened centerline;
//   (c) the pointer-events table: 11 values x visibility x fill x stroke x paint kind, against the spec's table written out here;
//   (d) transparent paints (transparent, fill-opacity 0, opacity 0, a gradient, hidden leaves) hit through the hit-only table;
//   (e) inheritance (group, <use>, class, stylesheet, inherit, invalid), clip-path, document order of hit-only shapes;
//   (f) overrides, morph poses, anchors; empty-draw bundles; HitMode.Coverage still the opt-in rendered coverage.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const {
  importSvg,
  createBundle,
  createRenderer,
  createShapeMorph,
  fillHitShape,
  fillHits,
  fillHitId,
  fillHitHref,
} = await import('../src/index.js');
const svg = (body, vb = '0 0 100 100') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${vb}">${body}</svg>`;

let seed = 0xc0ffee;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ── geometry: a path is contours of segments; the SVG text and the flattened polygon come from the same numbers ──
const flattenContour = (c, steps = 3000) => {
  const pts = [c.start.slice()];
  let p = c.start;
  for (const s of c.segs) {
    if (s[0] === 'L') {
      pts.push([s[1], s[2]]);
      p = [s[1], s[2]];
      continue;
    }
    const ctrl =
      s[0] === 'Q'
        ? [p, [s[1], s[2]], [s[3], s[4]]]
        : [p, [s[1], s[2]], [s[3], s[4]], [s[5], s[6]]];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps,
        u = 1 - t;
      if (ctrl.length === 3)
        pts.push([
          u * u * ctrl[0][0] + 2 * u * t * ctrl[1][0] + t * t * ctrl[2][0],
          u * u * ctrl[0][1] + 2 * u * t * ctrl[1][1] + t * t * ctrl[2][1],
        ]);
      else
        pts.push([
          u * u * u * ctrl[0][0] +
            3 * u * u * t * ctrl[1][0] +
            3 * u * t * t * ctrl[2][0] +
            t * t * t * ctrl[3][0],
          u * u * u * ctrl[0][1] +
            3 * u * u * t * ctrl[1][1] +
            3 * u * t * t * ctrl[2][1] +
            t * t * t * ctrl[3][1],
        ]);
    }
    p = ctrl[ctrl.length - 1];
  }
  return pts;
};
const dOf = (contours, k = 1) =>
  contours
    .map(
      (c) =>
        `M${c.start[0] * k} ${c.start[1] * k}` +
        c.segs
          .map(
            (s) =>
              s[0] +
              s
                .slice(1)
                .map((v) => v * k)
                .join(' '),
          )
          .join('') +
        (c.closed === false ? '' : 'Z'),
    )
    .join('');
const poly = (pts, closed = true) => ({
  start: pts[0],
  segs: pts.slice(1).map((p) => ['L', p[0], p[1]]),
  closed,
});

/// The polygons' edges (thousands a curve), bucketed by y: `(y) => [a0, b0, a1, b1, ...]` is every edge whose y range, widened by `pad`, reaches y's row,
/// so every edge that can cross the horizontal through y or come within `pad` of a point on it. `closed` false: open polylines (no closing edge).
function edgeRows(polys, pad, n = 256, closed = true) {
  let lo = Infinity,
    hi = -Infinity;
  for (const P of polys)
    for (const p of P) {
      lo = Math.min(lo, p[1]);
      hi = Math.max(hi, p[1]);
    }
  lo -= pad;
  hi += pad;
  const h = (hi - lo) / n || 1,
    rows = Array.from({ length: n }, () => []);
  const row = (y) => Math.min(n - 1, Math.max(0, Math.floor((y - lo) / h)));
  for (const P of polys)
    for (let i = 0; i < (closed ? P.length : P.length - 1); i++) {
      const a = P[i],
        b = P[(i + 1) % P.length];
      for (let r = row(Math.min(a[1], b[1]) - pad); r <= row(Math.max(a[1], b[1]) + pad); r++)
        rows[r].push(a, b);
    }
  return (y) => (y < lo || y > hi ? [] : rows[row(y)]);
}
/// signed crossing number around q of the edges `E` (edgeRows(...)(q[1])); [nonzero, evenodd]
function winding(E, q) {
  let w = 0;
  for (let i = 0; i < E.length; i += 2) {
    const a = E[i],
      b = E[i + 1];
    if (a[1] <= q[1] !== b[1] <= q[1]) {
      const x = a[0] + ((q[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
      if (x > q[0]) w += b[1] > a[1] ? 1 : -1;
    }
  }
  return w;
}
const distSeg = (q, a, b) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
};
/// is q within `eps` of one of the edges `E` (`orOn`: or at `eps`)
const nearEdge = (E, q, eps, orOn = false) => {
  for (let i = 0; i < E.length; i += 2) {
    const d = distSeg(q, E[i], E[i + 1]);
    if (d < eps || (orOn && d === eps)) return true;
  }
  return false;
};

// ── the stroke oracle ──
const inConvex = (P, q) => {
  let s = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i],
      b = P[(i + 1) % P.length];
    const c = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
    if (c !== 0) {
      if (s && Math.sign(c) !== s) return false;
      s = Math.sign(c);
    }
  }
  return true;
};
const unit = (a, b) => {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
};
/// primitives (convex polygons and discs) whose union is the stroke of a polyline
function strokePrims(pts, closed, hw, cap, join, ml) {
  const prims = [],
    n = pts.length,
    segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = pts[i],
      b = pts[(i + 1) % n],
      d = unit(a, b),
      nx = -d[1] * hw,
      ny = d[0] * hw;
    let a2 = a,
      b2 = b;
    if (!closed && cap === 'square') {
      if (i === 0) a2 = [a[0] - d[0] * hw, a[1] - d[1] * hw];
      if (i === segs - 1) b2 = [b[0] + d[0] * hw, b[1] + d[1] * hw];
    }
    prims.push({
      poly: [
        [a2[0] + nx, a2[1] + ny],
        [b2[0] + nx, b2[1] + ny],
        [b2[0] - nx, b2[1] - ny],
        [a2[0] - nx, a2[1] - ny],
      ],
    });
  }
  if (!closed && cap === 'round') {
    prims.push({ disc: pts[0], r: hw });
    prims.push({ disc: pts[n - 1], r: hw });
  }
  const joints = closed
    ? [...Array(n).keys()]
    : [...Array(Math.max(0, n - 2)).keys()].map((i) => i + 1);
  for (const j of joints) {
    const p0 = pts[(j - 1 + n) % n],
      v = pts[j],
      p1 = pts[(j + 1) % n];
    const da = unit(p0, v),
      db = unit(v, p1),
      cr = da[0] * db[1] - da[1] * db[0],
      dot = da[0] * db[0] + da[1] * db[1];
    if (join === 'round') {
      prims.push({ disc: v, r: hw });
      continue;
    }
    if (Math.abs(cr) < 1e-12 && dot > 0) continue;
    const s = cr > 0 ? -1 : 1,
      na = [-da[1] * s, da[0] * s],
      nb = [-db[1] * s, db[0] * s];
    const A = [v[0] + na[0] * hw, v[1] + na[1] * hw],
      B = [v[0] + nb[0] * hw, v[1] + nb[1] * hw];
    prims.push({ poly: [v, A, B] });
    const ratio = Math.sqrt(2 / (1 + dot));
    if (join === 'miter' && dot > -1 + 1e-12 && ratio <= ml) {
      const k = hw / (1 + dot),
        tip = [v[0] + (na[0] + nb[0]) * k, v[1] + (na[1] + nb[1]) * k];
      prims.push({ poly: [v, A, tip, B] });
    }
  }
  return prims;
}
const inPrims = (prims, q) =>
  prims.some((p) =>
    p.disc ? Math.hypot(q[0] - p.disc[0], q[1] - p.disc[1]) <= p.r : inConvex(p.poly, q),
  );
/// cut a polyline into dashes by arc length (open polylines)
function dashPieces(pts, dash, offset) {
  const total = dash.reduce((a, b) => a + b, 0),
    out = [];
  let pos = -((offset % total) + total) % total,
    on = true,
    di = 0,
    cur = null;
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  // position 0 of the path is `-offset` into the pattern
  let into = ((offset % total) + total) % total,
    k = 0;
  while (into >= dash[k]) {
    into -= dash[k];
    k = (k + 1) % dash.length;
  }
  let left = dash[k] - into,
    onNow = k % 2 === 0;
  if (onNow) cur = [pts[0]];
  for (let i = 0; i < lens.length; i++) {
    let rem = lens[i],
      t0 = 0;
    const a = pts[i],
      b = pts[i + 1];
    while (rem > left) {
      t0 += left / lens[i];
      rem -= left;
      const p = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      if (onNow) {
        cur.push(p);
        out.push(cur);
        cur = null;
      } else cur = [p];
      onNow = !onNow;
      k = (k + 1) % dash.length;
      left = dash[k];
    }
    left -= rem;
    if (onNow) cur.push(b);
  }
  if (onNow && cur && cur.length > 1) out.push(cur);
  return out;
}
const strokeContains = (pts, closed, w, cap, join, ml, dash, offset, q) => {
  const hw = w / 2;
  if (dash)
    return dashPieces(pts, dash, offset).some((pc) =>
      inPrims(strokePrims(pc, false, hw, cap, join, ml), q),
    );
  return inPrims(strokePrims(pts, closed, hw, cap, join, ml), q);
};

// ── comparison helper: sample points, skip those within `eps` of the boundary, report mismatches ──
function sweep(
  name,
  b,
  truth,
  nearBoundary,
  { count = 3000, k = 1, opts = {}, lo = -5, hi = 105 } = {},
) {
  let bad = 0,
    inside = 0,
    used = 0,
    first = '';
  for (let i = 0; i < count; i++) {
    const q = [lo + rnd() * (hi - lo), lo + rnd() * (hi - lo)];
    if (nearBoundary(q)) continue;
    used++;
    const want = truth(q);
    if (want) inside++;
    const got = fillHitShape(b, q[0] * k, q[1] * k, opts) >= 0;
    if (got !== want) {
      bad++;
      if (!first)
        first = ` first (${q[0].toFixed(3)}, ${q[1].toFixed(3)}): ${want ? 'miss' : 'hit'}`;
    }
  }
  ok(
    bad === 0 && inside > used * 0.02 && used - inside > used * 0.02,
    `${name}: ${bad} of ${used} wrong, ${inside} inside${first}`,
  );
}
const fillCase = async (name, contours, rule, { ks = [1], attrs = '' } = {}) => {
  const edges = edgeRows(
    contours.map((c) => flattenContour(c)),
    1e-3,
  );
  for (const k of ks) {
    const b = await importSvg(
      svg(
        `<path d="${dOf(contours, k)}" fill="#c00" fill-rule="${rule}" stroke="none" ${attrs}/>`,
        `0 0 ${100 * k} ${100 * k}`,
      ),
    );
    sweep(
      `${name} (${rule}${k === 1 ? '' : `, scale 2^${Math.log2(k)}`})`,
      b,
      (q) =>
        rule === 'evenodd' ? winding(edges(q[1]), q) % 2 !== 0 : winding(edges(q[1]), q) !== 0,
      (q) => nearEdge(edges(q[1]), q, 1e-3),
      { k },
    );
  }
};

console.log('(a) fills: exact interior by the fill rule');
{
  const star = poly(
    [0, 1, 2, 3, 4].map((i) => [
      50 + 45 * Math.sin((i * 4 * Math.PI) / 5),
      52 - 45 * Math.cos((i * 4 * Math.PI) / 5),
    ]),
  );
  const KS = [2 ** -20, 2 ** -10, 1, 2 ** 10, 2 ** 20];
  await fillCase('pentagram', [star], 'nonzero', { ks: KS });
  await fillCase('pentagram', [star], 'evenodd', { ks: KS });
  const outer = poly([
    [10, 10],
    [90, 10],
    [90, 90],
    [10, 90],
  ]);
  await fillCase(
    'donut, inner wound the same way',
    [
      outer,
      poly([
        [30, 30],
        [70, 30],
        [70, 70],
        [30, 70],
      ]),
    ],
    'nonzero',
  );
  await fillCase(
    'donut, inner wound the same way',
    [
      outer,
      poly([
        [30, 30],
        [70, 30],
        [70, 70],
        [30, 70],
      ]),
    ],
    'evenodd',
  );
  await fillCase(
    'donut, inner wound the other way',
    [
      outer,
      poly([
        [30, 30],
        [30, 70],
        [70, 70],
        [70, 30],
      ]),
    ],
    'nonzero',
  );
  const blob = {
    start: [20, 50],
    segs: [
      ['C', 20, 0, 80, 0, 80, 50],
      ['C', 80, 100, 20, 100, 20, 50],
    ],
  };
  await fillCase('cubic blob', [blob], 'nonzero', { ks: KS });
  const lens = {
    start: [10, 50],
    segs: [
      ['Q', 50, 0, 90, 50],
      ['Q', 50, 100, 10, 50],
    ],
  };
  await fillCase('quadratic lens', [lens], 'evenodd');
  const circle = {
    start: [80, 50],
    segs: [
      ['C', 80, 77.6142, 77.6142, 80, 50, 80],
      ['C', 22.3858, 80, 20, 77.6142, 20, 50],
    ].concat([
      ['C', 20, 22.3858, 22.3858, 20, 50, 20],
      ['C', 77.6142, 20, 80, 22.3858, 80, 50],
    ]),
  };
  const polysC = [flattenContour(circle)];
  for (const k of KS) {
    const b = await importSvg(
      svg(
        `<circle cx="${50 * k}" cy="${50 * k}" r="${30 * k}"/><ellipse cx="${50 * k}" cy="${50 * k}" rx="${40 * k}" ry="${10 * k}" fill="blue"/>`,
        `0 0 ${100 * k} ${100 * k}`,
      ),
    );
    sweep(
      `circle + ellipse primitives, scale 2^${Math.log2(k)}`,
      b,
      (q) =>
        Math.hypot(q[0] - 50, q[1] - 50) < 30 ||
        ((q[0] - 50) / 40) ** 2 + ((q[1] - 50) / 10) ** 2 < 1,
      (q) =>
        Math.abs(Math.hypot(q[0] - 50, q[1] - 50) - 30) < 1e-2 ||
        Math.abs(((q[0] - 50) / 40) ** 2 + ((q[1] - 50) / 10) ** 2 - 1) < 1e-2,
      { k },
    );
    void polysC;
  }
  // a rotated/skewed shape: the hit lives in document space
  const b = await importSvg(
    svg(
      `<g transform="rotate(30 50 50) skewX(10)"><rect x="25" y="30" width="50" height="40" fill="red"/></g>`,
    ),
  );
  const ang = (30 * Math.PI) / 180,
    sk = Math.tan((10 * Math.PI) / 180);
  const toLocal = (q) => {
    const dx = q[0] - 50,
      dy = q[1] - 50,
      c = Math.cos(-ang),
      s = Math.sin(-ang);
    let x = c * dx - s * dy + 50,
      y = s * dx + c * dy + 50;
    x -= sk * y;
    return [x, y];
  };
  const rd = (q) => {
    const l = toLocal(q);
    return Math.min(
      Math.abs(l[0] - 25),
      Math.abs(l[0] - 75),
      Math.abs(l[1] - 30),
      Math.abs(l[1] - 70),
    );
  };
  sweep(
    'rotated and skewed rect',
    b,
    (q) => {
      const l = toLocal(q);
      return l[0] > 25 && l[0] < 75 && l[1] > 30 && l[1] < 70;
    },
    (q) => rd(q) < 0.05,
  );
}

console.log('(b) strokes: the exact stroked outline');
{
  const zig = [
    [15, 80],
    [45, 20],
    [60, 75],
    [88, 30],
  ];
  const caps = ['butt', 'round', 'square'],
    joins = ['miter', 'round', 'bevel'];
  for (const cap of caps)
    for (const join of joins)
      for (const [w, ml] of [
        [14, 4],
        [14, 1.2],
      ]) {
        const b = await importSvg(
          svg(
            `<polyline points="${zig.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#00c" stroke-width="${w}" stroke-linecap="${cap}" stroke-linejoin="${join}" stroke-miterlimit="${ml}"/>`,
          ),
        );
        sweep(
          `open polyline, cap ${cap}, join ${join}, miterlimit ${ml}`,
          b,
          (q) => strokeContains(zig, false, w, cap, join, ml, null, 0, q),
          (q) =>
            strokeContains(zig, false, w * 1.0005, cap, join, ml, null, 0, q) !==
            strokeContains(zig, false, w * 0.9995, cap, join, ml, null, 0, q),
        );
      }
  const tri = [
    [20, 20],
    [85, 30],
    [50, 85],
  ];
  for (const join of joins) {
    const b = await importSvg(
      svg(
        `<polygon points="${tri.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#00c" stroke-width="10" stroke-linejoin="${join}"/>`,
      ),
    );
    sweep(
      `closed triangle, join ${join}`,
      b,
      (q) => strokeContains(tri, true, 10, 'butt', join, 4, null, 0, q),
      (q) =>
        strokeContains(tri, true, 10.005, 'butt', join, 4, null, 0, q) !==
        strokeContains(tri, true, 9.995, 'butt', join, 4, null, 0, q),
    );
  }
  for (const cap of caps)
    for (const [dash, off] of [
      [[10, 6], 0],
      [[10, 6], 7],
      [[4, 4, 12], 3],
      [Array(34).fill(2), 0],
    ]) {
      const line = [
        [8, 50],
        [92, 50],
      ];
      const b = await importSvg(
        svg(
          `<path d="M8 50H92" fill="none" stroke="#00c" stroke-width="8" stroke-linecap="${cap}" stroke-dasharray="${dash.join(' ')}" stroke-dashoffset="${off}"/>`,
        ),
      );
      sweep(
        `dashes ${dash.join(' ')} offset ${off}, cap ${cap}`,
        b,
        (q) => strokeContains(line, false, 8, cap, 'miter', 4, dash, off, q),
        (q) =>
          strokeContains(line, false, 8.005, cap, 'miter', 4, dash, off, q) !==
          strokeContains(line, false, 7.995, cap, 'miter', 4, dash, off, q),
        { count: 4000, lo: 8, hi: 92 },
      ); // a dash cap reaching past the path's own end is clipped there, as drawn (not modeled)
    }
  const curve = { start: [10, 80], segs: [['C', 20, 0, 70, 120, 90, 20]], closed: false };
  const cedges = edgeRows([flattenContour(curve)], 4.5 + 2e-3, 256, false);
  for (const k of [2 ** -20, 1, 2 ** 20]) {
    const b = await importSvg(
      svg(
        `<path d="${dOf([curve], k).replace('Z', '')}" fill="none" stroke="#00c" stroke-width="${9 * k}" stroke-linecap="round" stroke-linejoin="round"/>`,
        `0 0 ${100 * k} ${100 * k}`,
      ),
    );
    // round caps and joins: the stroke is every point within half the width of the centerline
    sweep(
      `cubic with round caps, scale 2^${Math.log2(k)}`,
      b,
      (q) => nearEdge(cedges(q[1]), q, 4.5, true),
      (q) => {
        const E = cedges(q[1]);
        let m = Infinity;
        for (let i = 0; i < E.length; i += 2) m = Math.min(m, distSeg(q, E[i], E[i + 1]));
        return Math.abs(m - 4.5) < 2e-3;
      },
      { k },
    );
  }
  // an arc stroke and a circle stroke (annulus)
  const bc = await importSvg(
    svg('<circle cx="50" cy="50" r="30" fill="none" stroke="#00c" stroke-width="12"/>'),
  );
  sweep(
    'circle stroke (annulus)',
    bc,
    (q) => Math.abs(Math.hypot(q[0] - 50, q[1] - 50) - 30) <= 6,
    (q) => Math.abs(Math.abs(Math.hypot(q[0] - 50, q[1] - 50) - 30) - 6) < 1e-2,
  );
  // non-scaling stroke: a constant 10 px band at any zoom, the shape itself scaled
  for (const S of [0.25, 1, 4]) {
    const b = await importSvg(
      svg(
        '<path d="M20 50H80" fill="none" stroke="#00c" stroke-width="10" vector-effect="non-scaling-stroke" stroke-linecap="butt"/>',
      ),
    );
    const hw = 5 / S;
    let bad = 0,
      n = 0;
    for (let i = 0; i < 800; i++) {
      const q = [10 + rnd() * 80, 50 + (rnd() - 0.5) * 30];
      if (
        Math.abs(Math.abs(q[1] - 50) - hw) < 1e-3 ||
        Math.abs(q[0] - 20) < 1e-3 ||
        Math.abs(q[0] - 80) < 1e-3
      )
        continue;
      n++;
      const want = q[0] > 20 && q[0] < 80 && Math.abs(q[1] - 50) < hw;
      const got =
        fillHitShape(b, q[0] * S, q[1] * S, { worldMatrix: [S, 0, 0, 0, S, 0, 0, 0, 1] }) >= 0;
      if (got !== want) bad++;
    }
    ok(
      bad === 0,
      `non-scaling-stroke at ${S} px per unit: the band stays 10 px wide (${bad} of ${n} wrong)`,
    );
  }
}

console.log('(c) the pointer-events table');
{
  // SVG 2 interact.html, written out: [visibility needed, fill paint needed, stroke paint needed] per region.
  const spec = (pe, vis, fillPaint, strokePaint) => {
    const visible = vis === 'visible',
      fp = fillPaint !== 'none',
      sp = strokePaint !== 'none';
    switch (pe) {
      case 'auto':
      case 'visiblePainted':
        return { fill: visible && fp, stroke: visible && sp };
      case 'visibleFill':
        return { fill: visible, stroke: false };
      case 'visibleStroke':
        return { fill: false, stroke: visible };
      case 'visible':
        return { fill: visible, stroke: visible };
      case 'painted':
        return { fill: fp, stroke: sp };
      case 'fill':
        return { fill: true, stroke: false };
      case 'stroke':
        return { fill: false, stroke: true };
      case 'all':
        return { fill: true, stroke: true };
      case 'none':
        return { fill: false, stroke: false };
      case 'bounding-box':
        return { fill: true, stroke: false };
    }
  };
  const PES = [
    'auto',
    'visiblePainted',
    'visibleFill',
    'visibleStroke',
    'visible',
    'painted',
    'fill',
    'stroke',
    'all',
    'none',
    'bounding-box',
  ];
  const FILLS = [
    ['red', ''],
    ['none', ''],
    ['transparent', ''],
    ['red', 'fill-opacity="0"'],
    ['red', 'opacity="0"'],
    ['url(#g)', ''],
    ['url(#gt)', ''],
    ['rgba(0,0,0,0)', ''],
  ];
  const STROKES = [
    ['none', ''],
    ['blue', ''],
    ['transparent', ''],
    ['blue', 'stroke-opacity="0"'],
  ];
  const defs =
    '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>' +
    '<linearGradient id="gt"><stop offset="0" stop-color="red" stop-opacity="0"/><stop offset="1" stop-color="blue" stop-opacity="0"/></linearGradient></defs>';
  let cases = 0,
    bad = 0,
    firstBad = '';
  for (const pe of PES)
    for (const vis of ['visible', 'hidden', 'collapse'])
      for (const [fill, fx] of FILLS)
        for (const [stroke, sx] of STROKES) {
          const b = await importSvg(
            svg(
              defs +
                `<rect x="20" y="20" width="60" height="60" fill="${fill}" stroke="${stroke}" stroke-width="10" ${fx} ${sx} pointer-events="${pe}" visibility="${vis}"/>`,
            ),
          );
          const want = spec(pe, vis, fill, stroke);
          // a bounding-box target is the geometry box (fill region), whatever the paints
          const strokeProbe = [17, 50],
            fillProbe = [50, 50];
          for (const [name, p, w] of [
            ['fill', fillProbe, want.fill],
            ['stroke', strokeProbe, want.stroke],
            ['outside', [3, 3], false],
          ]) {
            cases++;
            const got = fillHitShape(b, p[0], p[1]) >= 0;
            if (got !== w) {
              bad++;
              if (!firstBad)
                firstBad = ` first: pe=${pe} visibility=${vis} fill=${fill} ${fx} stroke=${stroke} ${sx} at the ${name} probe: ${w ? 'miss' : 'hit'}`;
            }
          }
        }
  ok(
    bad === 0,
    `${PES.length} values x 3 visibilities x ${FILLS.length} fills x ${STROKES.length} strokes: ${bad} of ${cases} probes wrong${firstBad}`,
  );
}

console.log('(d) transparent paints and hidden leaves are targets');
{
  const hit = async (body, ...pts) => {
    const b = await importSvg(svg(body));
    return pts.map(([x, y]) => fillHitShape(b, x, y) >= 0);
  };
  const R = (a) => `<rect x="10" y="10" width="40" height="40" ${a}/>`;
  for (const a of [
    'fill="transparent"',
    'fill-opacity="0"',
    'opacity="0"',
    'style="fill:rgba(1,2,3,0)"',
    'fill="#00000000"',
    'fill="red" opacity="0"',
    'fill="hsla(0,0%,0%,0)"',
  ])
    ok(
      (await hit(R(a), [30, 30], [70, 70])).join() === 'true,false',
      `${a}: the interior is a target (visiblePainted), outside is not`,
    );
  ok((await hit(R('fill="none"'), [30, 30])).join() === 'false', 'fill="none": no target');
  ok(
    (
      await hit(R('fill="none" stroke="transparent" stroke-width="6"'), [10, 30], [30, 30])
    ).join() === 'true,false',
    'stroke="transparent": the stroke is a target, the none fill is not',
  );
  ok(
    (
      await hit(R('fill="none" stroke="blue" stroke-opacity="0" stroke-width="6"'), [10, 30])
    ).join() === 'true',
    'stroke-opacity 0: the stroke is a target',
  );
  ok(
    (await hit(R('visibility="hidden"'), [30, 30])).join() === 'false',
    'visibility:hidden under visiblePainted: no target',
  );
  ok(
    (await hit(R('visibility="hidden" pointer-events="all"'), [30, 30])).join() === 'true',
    'visibility:hidden under pointer-events:all: a target',
  );
  ok(
    (await hit(`<g visibility="hidden">${R('visibility="visible"')}</g>`, [30, 30])).join() ===
      'true',
    'a visible child of a hidden group is a target',
  );
  ok(
    (await hit(`<g visibility="hidden" pointer-events="painted">${R('')}</g>`, [30, 30])).join() ===
      'true',
    'painted ignores visibility (inherited pointer-events)',
  );
  ok(
    (await hit('<g opacity="0">' + R('') + '</g>', [30, 30])).join() === 'true',
    'a group at opacity 0 still targets its children',
  );
  ok((await hit(R('display="none"'), [30, 30])).join() === 'false', 'display:none: never a target');
  ok(
    (await hit(`<g display="none" pointer-events="all">${R('')}</g>`, [30, 30])).join() === 'false',
    'display:none on a group: never a target, whatever pointer-events says',
  );
  // the hit-only table, the draw rows and keepInvisibleShapes
  const only = await importSvg(svg(R('fill="transparent"')), { keepInvisibleShapes: false });
  ok(
    only.numShapes === 0 && only.hitOnly && only.hitOnly.rows.length === 1,
    'a document of only a transparent shape: no draw rows, one hit-only region',
  );
  ok(
    fillHitShape(only, 30, 30) === 0 && fillHits(only, 30, 30).join() === '0',
    '...answered as index numShapes + k',
  );
  const kept = await importSvg(svg(R('fill="transparent"')), { keepInvisibleShapes: true });
  ok(
    kept.numShapes === 1 && !kept.hitOnly && fillHitShape(kept, 30, 30) === 0,
    'keepInvisibleShapes: the same shape is a drawn row of alpha 0, and a target',
  );
  const plain = await importSvg(svg(R('fill="red"')));
  ok(!plain.hitOnly && plain.numShapes === 1, 'a document with nothing hit-only has no table');
  // identical draw rows with and without the transparent shapes' side table
  const mixed = await importSvg(
    svg(
      R('fill="red"') +
        '<rect x="60" y="60" width="20" height="20" fill="transparent"/><rect x="5" y="5" width="2" height="2" visibility="hidden" pointer-events="all"/>',
    ),
    { keepInvisibleShapes: false },
  );
  const bare = await importSvg(
    svg(R('fill="red"') + '<rect x="60" y="60" width="20" height="20" display="none"/>'),
    { keepInvisibleShapes: false },
  );
  const same = (k) => Buffer.compare(Buffer.from(mixed[k]), Buffer.from(bare[k])) === 0;
  ok(
    mixed.hitOnly &&
      mixed.hitOnly.rows.length >= 2 &&
      mixed.numShapes === bare.numShapes &&
      ['meta', 'curves', 'bands', 'curveGeom'].every(same),
    'hit-only shapes change no draw byte: meta, curves, bands and cover geometry equal the document without them',
  );
  // the coverage mode is the opt-in rendered one: it does not see what draws nothing, and does not read pointer-events
  ok(
    fillHitShape(only, 30, 30, 'coverage') === -1 && fillHitShape(only, 30, 30, 'outline') === -1,
    'HitMode.Coverage / Outline: a transparent fill is not rendered, so not hit',
  );
  const pn = await importSvg(svg(R('fill="red" pointer-events="none"')));
  ok(
    fillHitShape(pn, 30, 30) === -1 && fillHitShape(pn, 30, 30, 'coverage') === 0,
    'pointer-events:none removes the target in the default mode; coverage mode draws it so hits it',
  );
  // document order of a hit-only region among drawn ones
  const ord = await importSvg(
    svg(
      '<rect id="below" x="0" y="0" width="60" height="60" fill="red"/><rect id="ghost" x="20" y="20" width="60" height="60" fill="transparent"/><rect id="above" x="40" y="40" width="30" height="30" fill="blue"/>',
    ),
  );
  ok(
    fillHitId(ord, 50, 50) === 'above' &&
      fillHitId(ord, 30, 30) === 'ghost' &&
      fillHitId(ord, 5, 5) === 'below',
    'a transparent shape is a target between the shapes drawn below and above it',
  );
  ok(
    fillHits(ord, 50, 50)
      .map((i) => (i < ord.numShapes ? ord.shapeIds[i] : 'ghost'))
      .join() === 'above,ghost,below',
    'fillHits lists them front to back, hit-only included',
  );
  const anchored = await importSvg(
    svg(
      '<a href="https://example.com/x"><rect x="10" y="10" width="30" height="30" fill="transparent"/></a><rect x="60" y="60" width="30" height="30" fill="red"/>',
    ),
  );
  ok(
    fillHitHref(anchored, 20, 20) === 'https://example.com/x' &&
      fillHitHref(anchored, 70, 70) === '' &&
      fillHitHref(anchored, 1, 1) === null,
    'fillHitHref answers a hit-only region its anchor',
  );
  // markup that hides a leaf in several ways, through <use>
  const used = await importSvg(
    svg(
      '<defs><rect id="r" x="10" y="10" width="30" height="30" fill="red" visibility="hidden" pointer-events="all"/></defs><use href="#r"/><use href="#r" x="50"/>',
    ),
  );
  ok(
    fillHitShape(used, 20, 20) >= 0 &&
      fillHitShape(used, 70, 20) >= 0 &&
      fillHitShape(used, 45, 20) === -1,
    'two <use> instances of a hidden pointer-events:all leaf are two targets',
  );
}

console.log('(e) pointer-events is an inherited property; clip-path cuts the target');
{
  const hit = async (body, ...pts) => {
    const b = await importSvg(svg(body));
    return pts.map(([x, y]) => fillHitShape(b, x, y) >= 0).join();
  };
  const R = (a, x = 10) =>
    `<rect x="${x}" y="10" width="30" height="30" ${/fill=/.test(a) ? '' : 'fill="red"'} ${a}/>`;
  ok(
    (await hit(
      `<g pointer-events="none">${R('')}${R('pointer-events="visiblePainted"', 50)}</g>`,
      [20, 20],
      [60, 20],
    )) === 'false,true',
    'pointer-events:none on a group removes its subtree unless a child overrides it',
  );
  ok(
    (await hit(
      `<g pointer-events="none"><g>${R('pointer-events="inherit"')}</g></g>`,
      [20, 20],
    )) === 'false',
    'inherit takes the parent value',
  );
  ok(
    (await hit(`<g pointer-events="none">${R('pointer-events="bogus"')}</g>`, [20, 20])) ===
      'false',
    'an invalid value is ignored (the inherited none applies)',
  );
  ok(
    (await hit(
      `<style>.n{pointer-events:none}#x{pointer-events:all}</style><g class="n">${R('')}${R('id="x"', 50)}</g>`,
      [20, 20],
      [60, 20],
    )) === 'false,true',
    'a stylesheet rule sets it, an id rule beats the class',
  );
  ok(
    (await hit(`${R('style="pointer-events:none"')}`, [20, 20])) === 'false',
    'style="pointer-events:none"',
  );
  ok(
    (await hit(
      `<defs><rect id="r" x="10" y="10" width="30" height="30" fill="red"/></defs><use href="#r" pointer-events="none"/><use href="#r" x="50"/>`,
      [20, 20],
      [60, 20],
    )) === 'false,true',
    'a <use> passes its pointer-events to the instance',
  );
  ok(
    (await hit(
      `<defs><marker id="m" markerWidth="40" markerHeight="40" refX="20" refY="20" markerUnits="userSpaceOnUse"><circle cx="20" cy="20" r="20" fill="red"/></marker></defs>` +
        `<path d="M20 20H40" stroke="blue" stroke-width="2" marker-end="url(#m)" fill="none"/>`,
      [58, 20],
      [30, 20],
    )) === 'false,true',
    "a marker's content is not a target; the path's own stroke is",
  );
  // clip-path
  const clip =
    '<defs><clipPath id="c"><circle cx="30" cy="30" r="12"/></clipPath><clipPath id="o" clipPathUnits="objectBoundingBox"><rect x="0" y="0" width="0.5" height="1"/></clipPath>' +
    '<clipPath id="e"><path clip-rule="evenodd" d="M0 0H100V100H0Z M20 20H60V60H20Z"/></clipPath></defs>';
  ok(
    (await hit(clip + R('clip-path="url(#c)"'), [30, 30], [14, 14], [14, 38])) ===
      'true,false,false',
    'clip-path: the clipped-out area of a shape is not a target',
  );
  ok(
    (await hit(clip + R('fill="transparent" clip-path="url(#c)"'), [30, 30], [14, 14])) ===
      'true,false',
    'a transparent shape is clipped like a drawn one',
  );
  ok(
    (await hit(clip + `<g clip-path="url(#c)">${R('')}</g>`, [30, 30], [14, 14])) === 'true,false',
    'a group clip cuts its children',
  );
  ok(
    (await hit(clip + R('clip-path="url(#o)"'), [20, 20], [35, 20])) === 'true,false',
    'clipPathUnits="objectBoundingBox"',
  );
  ok(
    (await hit(
      clip + '<rect x="0" y="0" width="100" height="100" fill="red" clip-path="url(#e)"/>',
      [10, 10],
      [40, 40],
    )) === 'true,false',
    'clip-rule="evenodd" leaves a hole that is not a target',
  );
  ok(
    (await hit(
      clip + R('pointer-events="all" visibility="hidden" clip-path="url(#c)"'),
      [30, 30],
      [14, 14],
    )) === 'true,false',
    'a hidden pointer-events:all shape is clipped too',
  );
  ok(
    (await hit(
      clip +
        '<rect x="10" y="10" width="30" height="30" fill="none" stroke="blue" stroke-width="10" clip-path="url(#o)"/>',
      [12, 30],
      [38, 30],
    )) === 'true,false',
    'a stroke is clipped too',
  );
  // The group's objectBoundingBox clip is bound to the GROUP's box (x < 50 of 0..100), not to the box of the clip it meets: the inner rect keeps x 40..80
  // and the two intersect in 40..50 (Chrome draws the same; this expected the outer clip bound to the inner circle's box, x < 30).
  const nested =
    clip +
    '<defs><clipPath id="c2"><rect x="40" y="0" width="40" height="100"/></clipPath></defs><g clip-path="url(#o)"><rect x="0" y="0" width="100" height="100" fill="red" clip-path="url(#c2)"/></g>';
  ok(
    (await hit(nested, [45, 30], [30, 30], [60, 30])) === 'true,false,false',
    'nested clip-paths intersect',
  );
}

console.log('(f) overrides, morph poses, empty-draw bundles, scale');
{
  const b = await importSvg(
    svg(
      '<rect id="m" x="10" y="10" width="20" height="20" fill="red"/><rect id="g" x="50" y="10" width="20" height="20" fill="transparent"/>',
    ),
    { keepInvisibleShapes: false },
  );
  const n = b.numShapes;
  const packed = new Float32Array(n * 24);
  for (let i = 0; i < n; i++) packed.set([1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1], i * 24);
  packed[4] = 30;
  ok(
    fillHitShape(b, 45, 20, { overrides: packed }) === 0 &&
      fillHitShape(b, 20, 20, { overrides: packed }) === -1,
    'an override that moves a drawn shape moves its target',
  );
  packed[6] = 0;
  ok(
    fillHitShape(b, 45, 20, { overrides: packed }) === -1,
    'an override hiding a shape removes its target',
  );
  packed[6] = 1;
  packed[11] = 0;
  packed[7] = 0;
  ok(
    fillHitShape(b, 45, 20, { overrides: packed }) === 0,
    "an override's tint alpha 0 does not (alpha is paint)",
  );
  ok(fillHitShape(b, 60, 20) === 1, 'a hit-only shape is static and found at its authored place');

  // a morph of two bundles: matched shapes follow the pose, the hit-only table is the source's, then the destination's
  const F = createFakeGl({ width: 64, height: 64 });
  const gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), {});
  if (R.ready) await R.ready;
  R.setViewport(64, 64);
  const mk = async (x, gx) =>
    createBundle(
      gl,
      await importSvg(
        svg(
          `<rect id="s" x="${x}" y="10" width="20" height="20" fill="red"/><rect id="ghost" x="${gx}" y="60" width="20" height="20" fill="transparent"/>`,
        ),
        { keepInvisibleShapes: false },
      ),
    );
  const A = await mk(10, 10),
    B = await mk(60, 60);
  const m = createShapeMorph(gl, A, B);
  m.setT(0);
  ok(
    fillHitShape(m, 20, 20) >= 0 &&
      fillHitShape(m, 70, 20) === -1 &&
      fillHitShape(m, 20, 70) >= 0 &&
      fillHitShape(m, 70, 70) === -1,
    'morph t=0: the pose and the source hit-only region',
  );
  m.setT(1);
  ok(
    fillHitShape(m, 70, 20) >= 0 &&
      fillHitShape(m, 20, 20) === -1 &&
      fillHitShape(m, 70, 70) >= 0 &&
      fillHitShape(m, 20, 70) === -1,
    'morph t=1: the pose and the destination hit-only region',
  );
  m.setT(0.5);
  ok(fillHitShape(m, 45, 20) >= 0, 'morph t=0.5: the matched shape is at the middle of its path');

  // an empty-draw bundle (only hit-only shapes) draws, sizes and prices without error
  const E = createBundle(
    gl,
    await importSvg(svg('<rect x="10" y="10" width="40" height="40" fill="transparent"/>'), {
      keepInvisibleShapes: false,
    }),
  );
  let threw = null;
  try {
    R.drawBundle(E);
    R.estimateRouteBytes([E]);
    R.prepareBundle(E);
    R.render && R.render();
  } catch (e) {
    threw = e.message;
  }
  ok(
    threw === null && E.numShapes === 0 && fillHitShape(E, 20, 20) === 0,
    `a bundle with only hit-only shapes draws, prices and answers${threw ? ' -- ' + threw : ''}`,
  );
  R.dispose();

  // scale: the answers are the same at every power of two, with and without a worldMatrix
  for (const e of [-20, -12, 0, 12, 20]) {
    const k = 2 ** e;
    const s = await importSvg(
      svg(
        `<rect x="${10 * k}" y="${10 * k}" width="${40 * k}" height="${40 * k}" fill="transparent" stroke="blue" stroke-opacity="0" stroke-width="${6 * k}"/>`,
        `0 0 ${100 * k} ${100 * k}`,
      ),
    );
    const hits = [
      [30, 30],
      [8, 30],
      [6, 30],
      [52.9, 30],
      [53.1, 30],
    ].map(([x, y]) => fillHitShape(s, x * k, y * k) >= 0);
    const w = [
      [30, 30],
      [8, 30],
      [6, 30],
      [52.9, 30],
      [53.1, 30],
    ].map(
      ([x, y]) => fillHitShape(s, x, y, { worldMatrix: [1 / k, 0, 0, 0, 1 / k, 0, 0, 0, 1] }) >= 0,
    );
    ok(
      hits.join() === 'true,true,false,true,false' && w.join() === hits.join(),
      `scale 2^${e}: fill and stroke of a transparent shape; a worldMatrix changes nothing`,
    );
  }
}

console.log(fail ? `\nHIT-SPEC-MODEL FAIL (${fail})` : '\nHIT-SPEC-MODEL PASS');
process.exit(fail ? 1 : 0);

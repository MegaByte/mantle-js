// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// incrementalStrokeArcStartSmoke — an arc appended to incrementalStroke starts where it says it starts.
//
// WHY. An arc states its own start (center, radii, angles), which need not be the current point. Written JOINED to the
// previous segment anyway (freeStart 0, the previous arc's end direction as its inTan, the previous segment's end cap
// cleared), the join wedge (_strokeMath.glsl outWedge) makes the region past the plane a butt-end SDF while inside the
// wedge the join's disc stands, so where no neighbor tube overlaps, coverage steps 1 -> 0.5 across the wedge's ray. A
// pathD that writes `A...` from the previous point makes finalize() / svgSource re-host a different arc than the one
// drawn; a full turn written as one `A` has endpoints that coincide, which SVG omits; and an arc with no current point
// must not become a dot at its END.
//
// SO canvas's arc() semantics: a line from the current point to the arc's start (none when the start is the current
// point, a relative test: 64 float32 ulps of the coordinates), and with no current point the arc starts the path.
// pathD emits the same, and a sweep over half a turn goes out as equal pieces of at most half a turn.
//
// The handle is driven with no GL (appendSegments writes the prim texels on the CPU); coverage is the split-stroke
// pass's shipped text in float32 (test/_glslEmu.mjs buildSplitStrokeEmu) over the texels the handle wrote, MAX-unioned
// as the pass blends:
// (a) arcs that each start 3 em outward of the last one's end on the same ray (the bench's inc_arcs): each gap gets a
//     line, every joint is joined, and against the exact round-capped round-joined shape (the points within halfW of
//     the path) no pixel a pixel inside reads under 1 and none a pixel outside reads over 0;
// (b) an arc on the current point (computed in float32 or double) is joined with no line; an arc with no current point
//     starts the path at its own start;
// (c) pathD re-hosts what was drawn: parsed back (svg/path.js), the path and the drawn segments lie within 1e-6 of the
//     drawing's size of each other both ways (the polylines they are sampled into sag 4e-6 em at most) -- inc_arcs, a
//     full turn, and one and a half turns back on a rotated ellipse.
import path from 'path';
import { fileURLToPath } from 'url';
import { attachIncrementalStroke } from '../src/renderer/incrementalStroke.js';
import { parsePathD } from '../src/svg/path.js';
import * as EMU from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SEG_TEXELS = [3, 4, 4, 5];

function handle(opts = {}) {
  const R = { gl: {} };
  attachIncrementalStroke(R);
  return R.createIncrementalStroke({ width: 2, bbox: [-25, -25, 50, 50], ...opts });
}
const segsOf = (h) => {
  const out = [];
  for (let i = 0; i < h.segCount; i++) {
    const b = h.segBase[i] * 4,
      ty = h.prim[b] | 0,
      j = (h.segBase[i] + SEG_TEXELS[ty] - 1) * 4;
    out.push({
      ty,
      base: h.segBase[i],
      freeS: h.prim[b + 1],
      freeE: h.prim[b + 2],
      tan: Array.from(h.prim.subarray(j, j + 4)),
      pts: h.segsMeta[i]?.pts,
    });
  }
  return out;
};
const polar = (r, th) => [r * Math.cos(th), r * Math.sin(th)];
/// inc_arcs: arc k has radius 10 + 3k over [0.3 + 1.2k, 0.3 + 1.2(k + 1)], so arc k + 1 starts 3 em outward of arc k's end.
const INC_ARCS = [0, 1, 2, 3].map((k) => ({
  type: 'arc',
  center: [0, 0],
  radii: [10 + 3 * k, 10 + 3 * k],
  theta: [0.3 + 1.2 * k, 0.3 + 1.2 * (k + 1)],
}));

/// Points along a drawn segment (native points, as segsMeta holds them) or a parsed one, `n` of them.
function sample(sg, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (sg.kind === 'arc') {
      const th = sg.t0 + (sg.t1 - sg.t0) * t,
        cp = Math.cos(sg.phi),
        sp = Math.sin(sg.phi);
      pts.push([
        sg.cx + cp * sg.rx * Math.cos(th) - sp * sg.ry * Math.sin(th),
        sg.cy + sp * sg.rx * Math.cos(th) + cp * sg.ry * Math.sin(th),
      ]);
    } else pts.push([sg.a[0] + (sg.b[0] - sg.a[0]) * t, sg.a[1] + (sg.b[1] - sg.a[1]) * t]);
  }
  return pts;
}
const drawnGeo = (h) =>
  h.segsMeta.map(({ ty, pts }) =>
    ty === 3
      ? {
          kind: 'arc',
          cx: pts[0][0],
          cy: pts[0][1],
          rx: pts[1][0],
          ry: pts[1][1],
          t0: pts[2][0],
          t1: pts[2][1],
          phi: pts[3][0],
        }
      : { kind: 'line', a: pts[0], b: pts[pts.length - 1] },
  );
const parsedGeo = (d) =>
  parsePathD(d)
    .filter((s) => s.type === 0 || s.type === 3)
    .map((s) =>
      s.type === 3
        ? {
            kind: 'arc',
            cx: s.cx,
            cy: s.cy,
            rx: s.rx,
            ry: s.ry,
            t0: s.theta_start,
            t1: s.theta_end,
            phi: s.phi,
          }
        : { kind: 'line', a: s.p1, b: s.p2 },
    );
const segDist = (p, a, b) => {
  const d = [b[0] - a[0], b[1] - a[1]],
    dd = d[0] * d[0] + d[1] * d[1];
  const t =
    dd > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / dd)) : 0;
  return Math.hypot(p[0] - a[0] - d[0] * t, p[1] - a[1] - d[1] * t);
};
/// The larger of the two one-way distances between the paths (each sampled densely, measured to the other's polyline).
function hausdorff(A, B) {
  const pa = A.map((s) => sample(s, 5000)),
    pb = B.map((s) => sample(s, 5000));
  const one = (P, Q) => {
    let w = 0;
    for (const poly of P)
      for (let i = 0; i < poly.length; i += 25) {
        let m = Infinity;
        for (const q of Q)
          for (let j = 1; j < q.length; j++) m = Math.min(m, segDist(poly[i], q[j - 1], q[j]));
        w = Math.max(w, m);
      }
    return w;
  };
  return Math.max(one(pa, pb), one(pb, pa));
}

// ---- (a) inc_arcs: structure, then coverage against the exact shape --------------------------------------------------
{
  const h = handle();
  h.appendPoints([polar(10, 0.3)]);
  h.appendSegments(INC_ARCS);
  const S = segsOf(h);
  const types = S.map((s) => s.ty).join('');
  ok(
    types === '3030303',
    `(a) inc_arcs is written arc, line, arc, line, arc, line, arc (${types})`,
  );
  const joined = S.every(
    (s, i) =>
      (i === 0 ? s.freeS === 1 : s.freeS === 0) &&
      (i === S.length - 1 ? s.freeE === 1 : s.freeE === 0) &&
      (i === 0 || Math.hypot(s.tan[0], s.tan[1]) > 0.99) &&
      (i === S.length - 1 || Math.hypot(s.tan[2], s.tan[3]) > 0.99),
  );
  ok(
    joined,
    '(a) ...every interior joint joined with a unit tangent on both sides, the two ends free',
  );
  const gapsClosed = [1, 3, 5].every((i) => {
    const [a, b] = S[i].pts,
      k = (i + 1) / 2;
    const e = polar(10 + 3 * (k - 1), 0.3 + 1.2 * k),
      s0 = polar(10 + 3 * k, 0.3 + 1.2 * k);
    return (
      Math.hypot(a[0] - e[0], a[1] - e[1]) < 1e-12 && Math.hypot(b[0] - s0[0], b[1] - s0[1]) < 1e-12
    );
  });
  ok(gapsClosed, "(a) ...each line runs from the last arc's end to the next arc's start");

  if (!EMU.hasCxx()) console.log('  SKIPPED (a) coverage: no C++ compiler');
  else {
    const emu = EMU.buildSplitStrokeEmu(ROOT);
    const prim = new Float32Array(h.prim.subarray(0, h.texelCount * 4));
    const geo = drawnGeo(h),
      halfW = 1,
      px = 0.1;
    const dist = (p) => {
      let m = Infinity;
      for (const g of geo) {
        if (g.kind === 'line') m = Math.min(m, segDist(p, g.a, g.b));
        else {
          let th = Math.atan2(p[1] - g.cy, p[0] - g.cx);
          while (th < g.t0) th += 2 * Math.PI;
          while (th > g.t0 + 2 * Math.PI) th -= 2 * Math.PI;
          const on = th <= g.t1 ? Math.abs(Math.hypot(p[0] - g.cx, p[1] - g.cy) - g.rx) : Infinity;
          const e0 = sample(g, 1)[0],
            e1 = sample(g, 1)[1];
          m = Math.min(
            m,
            on,
            Math.hypot(p[0] - e0[0], p[1] - e0[1]),
            Math.hypot(p[0] - e1[0], p[1] - e1[1]),
          );
        }
      }
      return m;
    };
    const pts = [];
    for (let y = -21; y < 21; y += 0.117)
      for (let x = -21; x < 21; x += 0.117) {
        const d = dist([x, y]);
        if (d < halfW + 3 * px) pts.push({ c: [Math.fround(x), Math.fround(y)], d });
      }
    const cov = new Float32Array(pts.length);
    for (const s of S) {
      const r = emu.run(
        prim,
        pts.map((p) => ({ base: s.base, c: p.c, ePx: [px, px], halfW, cap: 1, join: 1 })),
      );
      for (let i = 0; i < r.length; i++) cov[i] = Math.max(cov[i], r[i]);
    }
    let under = 0,
      over = 0,
      first = '';
    pts.forEach((p, i) => {
      if (p.d <= halfW - px && cov[i] < 1) {
        under++;
        if (!first)
          first = ` -- first (${p.c.map((v) => v.toFixed(2))}) ${cov[i].toFixed(3)} a pixel inside`;
      }
      if (p.d >= halfW + px && cov[i] > 0) over++;
    });
    ok(
      pts.length > 10000 && under === 0 && over === 0,
      `(a) coverage over ${pts.length} points near the path: ${under} a pixel inside read under 1, ${over} a pixel outside read over 0${first}`,
    );
  }
}

// ---- (b) on the current point, and with none ------------------------------------------------------------------------
{
  const f = Math.fround;
  for (const [tag, start] of [
    ['double', polar(10, 0.3)],
    ['float32', polar(10, 0.3).map(f)],
  ]) {
    const h = handle();
    h.appendPoints([start]);
    h.appendSegments([INC_ARCS[0]]);
    const S = segsOf(h);
    ok(
      S.length === 1 && S[0].ty === 3,
      `(b) an arc on the current point (start computed in ${tag}) is appended with no line (${S.map((s) => s.ty).join('')})`,
    );
  }
  const h = handle();
  h.appendSegments([INC_ARCS[1]]);
  const S = segsOf(h),
    s0 = polar(13, 1.5);
  ok(
    S.length === 1 &&
      S[0].ty === 3 &&
      S[0].freeS === 1 &&
      Math.hypot(h.pts[0] - s0[0], h.pts[1] - s0[1]) < 1e-12 &&
      h.pathD.startsWith(`M${s0[0]} ${s0[1]}A`),
    `(b) an arc with no current point starts the path at its own start (${S.map((s) => s.ty).join('')}, ${h.pathD.slice(0, 40)}...)`,
  );
}

// ---- (c) pathD re-hosts what was drawn --------------------------------------------------------------------------------
{
  const cases = [
    [
      'inc_arcs',
      (h) => {
        h.appendPoints([polar(10, 0.3)]);
        h.appendSegments(INC_ARCS);
      },
    ],
    [
      'a full turn',
      (h) => {
        h.appendPoints([polar(8, 0.2)]);
        h.appendSegments([
          { type: 'arc', center: [0, 0], radii: [8, 8], theta: [0.2, 0.2 + 2 * Math.PI] },
        ]);
      },
    ],
    [
      'one and a half turns back, elliptical and rotated',
      (h) => {
        h.appendSegments([
          { type: 'line', to: [3, 4] },
          { type: 'arc', center: [1, 1], radii: [9, 5], theta: [0.7, 0.7 - 3 * Math.PI], phi: 0.4 },
        ]);
      },
    ],
  ];
  for (const [name, build] of cases) {
    const h = handle();
    build(h);
    const d = h.pathD,
      H = hausdorff(drawnGeo(h), parsedGeo(d));
    ok(
      H <= 1e-6 * 50,
      `(c) ${name}: the re-hosted path and the drawn one are ${H.toExponential(2)} em apart (bar ${1e-6 * 50}) -- ${d.length > 90 ? d.slice(0, 90) + '...' : d}`,
    );
  }
}
console.log(
  fail ? `INCREMENTAL-STROKE-ARC-START FAIL (${fail})` : 'INCREMENTAL-STROKE-ARC-START PASS',
);
process.exit(fail ? 1 : 0);

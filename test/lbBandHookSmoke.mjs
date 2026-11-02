// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBandHookSmoke -- Loop-Blinn's curve band on rational quads, scored against an independent exact-area oracle, on the whole
// unified-fill pipeline run on the CPU (test/_lbPipeEmu.mjs: the generated vertex and fragment texts, a rasterizer, real 2x2
// derivatives), so it needs no GPU. Two rules of one family, each pinned by a case that fails without it:
//
//  (1) HOOKS. A rational quad whose end tangents turn more than 90 degrees (an elongated ellipse's arc near its tip: 80:1 turns
//      about 160 degrees in a fraction of its length) loses the antialiasing of single-pixel fringe columns along the arc's
//      flank if the band cuts a pixel behind an end's normal line: the pixels whose nearest arc point lies in the piece are the
//      ones between its two end normal lines only while it turns less than a right angle, and past that the arc itself crosses
//      the normal line at its start. So the tests apply on their own side of the normal line at the arc point whose normal
//      bisects the end normals (closed form, scale free). The shape is a 6-arc 80:1 ellipse sliver, at 512 and 2048 px.
//  (2) THE HULL TURF OF A RATIONAL PIECE. A band fragment inside the piece's control triangle is the hull's (kind 5), which
//      paints there. The band's test for it must read rational pieces too, not only integral ones (R == 1): a rational piece's
//      vertex push leaves R where it stands, so otherwise the hull and the band both paint the pixels whose center is outside
//      the arc within the triangle, and a partial pixel reads its own coverage twice (an elliptical arc, up to 0.40 over).
//
// The oracle never touches Loop-Blinn: the path's arcs are converted from endpoint to center form and flattened to 4096 segments
// each, and a pixel's coverage is the share of its 16 x 16 sample grid inside the nonzero fill.
// SKIPs (exit 77) without a C++ compiler and clang.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasLbPipeEmu } from './_lbPipeEmu.mjs';
import { lbScene, renderScene, compositeAlpha } from './_lbPipeScene.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasLbPipeEmu()) {
  console.log('SKIP lbBandHookSmoke: needs a C++17 compiler and clang');
  process.exit(77);
}
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};
const VT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
const FT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');

/// Flatten a path of M / L / A / Z (absolute) into closed polygons: [[x, y], ...] each.
function flatten(cmds) {
  const polys = [];
  let cur = null,
    x = 0,
    y = 0,
    sx = 0,
    sy = 0;
  for (const c of cmds) {
    if (c[0] === 'M') {
      cur = [[c[1], c[2]]];
      polys.push(cur);
      x = sx = c[1];
      y = sy = c[2];
    } else if (c[0] === 'L') {
      cur.push([c[1], c[2]]);
      x = c[1];
      y = c[2];
    } else if (c[0] === 'Z') {
      x = sx;
      y = sy;
    } else if (c[0] === 'A') {
      let [, rx, ry, rot, large, sweep, ex, ey] = c;
      const phi = (rot * Math.PI) / 180,
        cp = Math.cos(phi),
        sp = Math.sin(phi);
      const dx = (x - ex) / 2,
        dy = (y - ey) / 2,
        x1 = cp * dx + sp * dy,
        y1 = -sp * dx + cp * dy;
      const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
      if (lam > 1) {
        const s = Math.sqrt(lam);
        rx *= s;
        ry *= s;
      }
      const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1,
        den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
      const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
      const cxp = (co * rx * y1) / ry,
        cyp = (-co * ry * x1) / rx;
      const cx = cp * cxp - sp * cyp + (x + ex) / 2,
        cy = sp * cxp + cp * cyp + (y + ey) / 2;
      const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
      let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
      if (!sweep && dt > 0) dt -= 2 * Math.PI;
      else if (sweep && dt < 0) dt += 2 * Math.PI;
      const K = 4096;
      for (let k = 1; k <= K; k++) {
        const t = t1 + (dt * k) / K,
          ex2 = rx * Math.cos(t),
          ey2 = ry * Math.sin(t);
        cur.push([cp * ex2 - sp * ey2 + cx, sp * ex2 + cp * ey2 + cy]);
      }
      x = ex;
      y = ey;
    }
  }
  return polys;
}

/// Coverage of each pixel of an N x N canvas by the nonzero fill of `polys`, 16 x 16 samples a pixel. `map(x, y)` -> pixel units.
function oracle(polys, N, map) {
  const S = 16,
    rows = N * S,
    edges = [];
  for (const P of polys)
    for (let i = 0; i < P.length; i++) {
      const a = map(...P[i]),
        b = map(...P[(i + 1) % P.length]);
      if (a[1] !== b[1])
        edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1], 1] : [b[0], b[1], a[0], a[1], -1]);
    }
  const byRow = new Map();
  for (const e of edges) {
    const r0 = Math.max(0, Math.ceil(e[1] * S - 0.5)),
      r1 = Math.min(rows - 1, Math.ceil(e[3] * S - 0.5) - 1);
    for (let r = r0; r <= r1; r++) {
      const yc = (r + 0.5) / S,
        x = e[0] + ((yc - e[1]) / (e[3] - e[1])) * (e[2] - e[0]);
      (byRow.get(r) || byRow.set(r, []).get(r)).push([x, e[4]]);
    }
  }
  const cov = new Float64Array(N * N);
  for (const [r, xs] of byRow) {
    xs.sort((p, q) => p[0] - q[0]);
    let wind = 0;
    for (let k = 0; k + 1 < xs.length; k++) {
      wind += xs[k][1];
      if (wind === 0) continue;
      const c0 = Math.max(0, Math.ceil(xs[k][0] * S - 0.5)),
        c1 = Math.min(N * S - 1, Math.ceil(xs[k + 1][0] * S - 0.5) - 1);
      for (let c = c0; c <= c1; c++) cov[Math.floor(r / S) * N + Math.floor(c / S)] += 1 / (S * S);
    }
  }
  return cov;
}

/// Render `svg` through the emulated Loop-Blinn pipeline at N px and score it against the oracle of `cmds`.
async function score(svg, cmds, N) {
  const sc = await lbScene(svg, { N, importOpts: { preserveViewport: true } });
  const r = renderScene(sc, VT, FT, [], { coarse: false });
  const cov = compositeAlpha(r.recs, N);
  const [gx, gy, gw, gh] = sc.gbb,
    s = N / Math.max(gw, gh),
    ox = (N - gw * s) / 2,
    oy = (N - gh * s) / 2;
  const orc = oracle(flatten(cmds), N, (x, y) => [(x - gx) * s + ox, (y - gy) * s + oy]);
  let holes = 0,
    over = 0,
    maxHole = 0,
    maxOver = 0,
    sum = 0;
  for (let k = 0; k < N * N; k++) {
    const d = cov[k] - orc[k];
    sum += Math.abs(d);
    if (d < -64 / 255) holes++;
    if (d > 64 / 255) over++;
    if (-d > maxHole) maxHole = -d;
    if (d > maxOver) maxOver = d;
  }
  return { holes, over, maxHole, maxOver, sum };
}

// ── (1) the 80:1 sliver, a pinned-Loop-Blinn drawing of the locomotive cylinder cap ────────────────────────────────────────────
const sliverCmds = (rx, ry, k = 1) =>
  [
    ['M', 1.137, -1.723],
    ['A', rx, ry, 270, 0, 1, 1.146, -1.323],
    ['A', rx, ry, 270, 0, 1, 1.146, -0.523],
    ['A', rx, ry, 270, 0, 1, 1.137, -0.123],
    ['A', rx, ry, 270, 0, 1, 1.128, -0.523],
    ['A', rx, ry, 270, 0, 1, 1.128, -1.323],
    ['A', rx, ry, 270, 0, 1, 1.137, -1.723],
    ['L', 1.137, -1.723],
    ['Z'],
  ].map((c) =>
    c[0] === 'A'
      ? ['A', c[1] * k, c[2] * k, c[3], c[4], c[5], c[6] * k, c[7] * k]
      : c[0] === 'Z'
        ? c
        : [c[0], c[1] * k, c[2] * k],
  );
const num = (v) => (+v).toPrecision(12);
const sliverSvg = (cmds, k = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[-3.2031329774563906, -5.273327324521942, 9.613519001801487, 8.567706403873396].map((v) => num(v * k)).join(' ')}"><path d="${cmds
    .map((c) =>
      c[0] === 'A'
        ? `A${num(c[1])} ${num(c[2])} ${c[3]} ${c[4]} ${c[5]} ${num(c[6])} ${num(c[7])}`
        : c[0] === 'Z'
          ? 'Z'
          : `${c[0]}${num(c[1])} ${num(c[2])}`,
    )
    .join('')}" fill="#000"/></svg>`;
// The remainders at the tips (the two ellipses' tips overlap by 7e-4 and the pixels there compose twice) and at the sliver's thin
// interior are other defects: only the lost antialiasing (a pixel more than 64/255 too light) is this one's. Scaled by 2^-20 and
// 2^20 the answer is the same (no absolute epsilon).
for (const [k, N] of [
  [1, 512],
  [1, 2048],
  [2 ** -20, 512],
  [2 ** 20, 512],
]) {
  const cmds = sliverCmds(0.8, 0.01, k),
    t = await score(sliverSvg(cmds, k), cmds, N);
  ok(
    t.holes === 0,
    `the 80:1 sliver${k === 1 ? '' : ' scaled by 2^' + Math.log2(k)} at ${N} px: no pixel more than 64/255 too light (${t.holes}, worst ${(t.maxHole * 255).toFixed(1)}/255)`,
  );
}

// ── (2) a plain elliptical arc: a rational quad band over its hull ───────────────────────────────────────────────────────────
const BUMP = [
  ['M', 10, 60],
  ['L', 20, 60],
  ['A', 30, 25, 20, 0, 1, 70, 55],
  ['L', 90, 60],
  ['L', 90, 90],
  ['L', 10, 90],
  ['Z'],
];
const bumpSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M 10 60 L 20 60 A 30 25 20 0 1 70 55 L 90 60 L 90 90 L 10 90 Z" fill="#000"/></svg>';
{
  const t = await score(bumpSvg, BUMP, 256);
  ok(
    t.over === 0,
    `an elliptical arc at 256 px: no pixel more than 64/255 too dark (${t.over}; worst ${(t.maxOver * 255).toFixed(1)}/255)`,
  );
}

console.warn = warn;
console.log(fail ? `lbBandHookSmoke FAIL (${fail})` : 'lbBandHookSmoke: all checks passed');
process.exit(fail ? 1 : 0);

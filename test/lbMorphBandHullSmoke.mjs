// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbMorphBandHullSmoke -- the Loop-Blinn MORPH's curve band on a rational quad, scored against an exact-area oracle of the lerped
// conic, on the whole unified-fill pipeline run on the CPU (test/_lbPipeEmu.mjs), so it needs no GPU.
//
// A morph pair holds one weight across both poses (lbPartitionPair bails on a different one), so every lerped frame is a
// rational frame whose (U, V, R) are affine in the plane and keep R = 1 + 2(1 - w)(U - V). The static band pushes R with U
// and V and tests the hull's turf in (U/R, V/R), and the morph band takes the same exact test. A test for R == 1 only, with
// R left where the vertex stands, would let the hull and the band of a rational piece both paint the pixels whose center is
// outside the arc inside the control triangle, and a partial pixel would read its own coverage twice.
//
// The oracle never touches Loop-Blinn: the lerped ellipse c(t) + M(t) (cos, sin), M = R(rot) diag(rx, ry) lerped as a matrix
// (an affine image of the circular arc, so lerping the control points of corresponding pieces is lerping (c, M)).
// SKIPs (exit 77) without a C++ compiler and clang.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasLbPipeEmu } from './_lbPipeEmu.mjs';
import { lbScene, renderScene, compositeAlpha } from './_lbPipeScene.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasLbPipeEmu()) {
  console.log('SKIP lbMorphBandHullSmoke: needs a C++17 compiler and clang');
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

/// Coverage of each pixel by the polygons' signed area (font-rs accumulation): exact for a simple outline, and
/// min(1, |area|) where outlines overlap.
function exactCoverage(polys, N) {
  const acc = new Float64Array(N * N + 2);
  const line = (px0, py0, px1, py1) => {
    if (py0 === py1) return;
    let dir = 1;
    if (py0 > py1) {
      dir = -1;
      [px0, py0, px1, py1] = [px1, py1, px0, py0];
    }
    const dxdy = (px1 - px0) / (py1 - py0);
    let x = px0;
    if (py0 < 0) x -= py0 * dxdy;
    for (let y = Math.max(0, Math.floor(py0)); y < Math.min(N, Math.ceil(py1)); y++) {
      const ls = y * N,
        dy = Math.min(y + 1, py1) - Math.max(y, py0),
        xn = x + dxdy * dy,
        d = dy * dir;
      const x0 = Math.min(x, xn),
        x1 = Math.max(x, xn),
        x0f = Math.floor(x0),
        x1c = Math.ceil(x1);
      if (x1c <= x0f + 1) {
        const xmf = 0.5 * (x + xn) - x0f;
        acc[ls + x0f] += d - d * xmf;
        acc[ls + x0f + 1] += d * xmf;
      } else {
        const s = 1 / (x1 - x0),
          a = x0 - x0f,
          a0 = 0.5 * s * (1 - a) * (1 - a),
          b = x1 - x1c + 1,
          am = 0.5 * s * b * b;
        acc[ls + x0f] += d * a0;
        if (x1c === x0f + 2) acc[ls + x0f + 1] += d * (1 - a0 - am);
        else {
          const a1 = s * (1.5 - a);
          acc[ls + x0f + 1] += d * (a1 - a0);
          for (let xi = x0f + 2; xi < x1c - 1; xi++) acc[ls + xi] += d * s;
          acc[ls + x1c - 1] += d * (1 - (a1 + (x1c - x0f - 3) * s) - am);
        }
        acc[ls + x1c] += d * am;
      }
      x = xn;
    }
  };
  for (const P of polys)
    for (let k = 0; k < P.length - 1; k++) line(P[k][0], P[k][1], P[k + 1][0], P[k + 1][1]);
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    let s = 0;
    for (let x = 0; x < N; x++) {
      s += acc[y * N + x];
      out[y * N + x] = Math.min(1, Math.abs(s));
    }
  }
  return out;
}

const d2r = Math.PI / 180;
// Two flat elliptical caps over a base line, the same parametric sweep (so the same weight), different radii, tilt and place.
let A = { c: [50, 80], rx: 38, ry: 7, rot: 5, a0: -170, a1: -10, x0: 10, x1: 90 };
let B = { c: [50, 82], rx: 34, ry: 11, rot: -4, a0: -170, a1: -10, x0: 14, x1: 86 };
const pt = (s, th) => {
  const p = s.rot * d2r,
    x = s.rx * Math.cos(th),
    y = s.ry * Math.sin(th);
  return [s.c[0] + x * Math.cos(p) - y * Math.sin(p), s.c[1] + x * Math.sin(p) + y * Math.cos(p)];
};
const svgOf = (s) => {
  const P = pt(s, s.a0 * d2r),
    Q = pt(s, s.a1 * d2r),
    g = (v) => v.toFixed(4);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M${g(s.x0)} 90 L${g(P[0])} ${g(P[1])} A${g(s.rx)} ${g(s.ry)} ${s.rot} 0 1 ${g(Q[0])} ${g(Q[1])} L${g(s.x1)} 90 Z" fill="#000"/></svg>`;
};
const mat = (s) => {
  const p = s.rot * d2r,
    c = Math.cos(p),
    sn = Math.sin(p);
  return [c * s.rx, -sn * s.ry, sn * s.rx, c * s.ry];
};
function oracleAt(t, N) {
  const MA = mat(A),
    MB = mat(B),
    M = MA.map((v, i) => v + (MB[i] - v) * t),
    c = [0, 1].map((i) => A.c[i] + (B.c[i] - A.c[i]) * t);
  const th0 = A.a0 * d2r,
    th1 = A.a1 * d2r,
    K = 20000,
    x0 = A.x0 + (B.x0 - A.x0) * t,
    x1 = A.x1 + (B.x1 - A.x1) * t,
    poly = [[x0, 90]];
  for (let k = 0; k <= K; k++) {
    const th = th0 + ((th1 - th0) * k) / K,
      u = Math.cos(th),
      v = Math.sin(th);
    poly.push([c[0] + M[0] * u + M[1] * v, c[1] + M[2] * u + M[3] * v]);
  }
  poly.push([x1, 90], [x0, 90]);
  return exactCoverage([poly.map(([x, y]) => [(x * N) / 100, (y * N) / 100])], N);
}
// Pixels more than 6/255 too dark: a partial pixel read twice is up to a quarter too dark, a few bytes at the flat cap's ends.
for (const [t, N, max] of [
  [0, 512, 4],
  [0.5, 512, 3],
]) {
  const sc = await lbScene(svgOf(A), {
    N,
    importOpts: { preserveViewport: true },
    morph: { svg: svgOf(B), t },
  });
  const cov = compositeAlpha(renderScene(sc, VT, FT, [], { coarse: false }).recs, N),
    orc = oracleAt(t, N);
  let dark = 0,
    worst = 0;
  for (let i = 0; i < N * N; i++) {
    const d = cov[i] - orc[i];
    if (d > 6 / 255) dark++;
    if (d > worst) worst = d;
  }
  ok(
    dark <= max,
    `a morph of two flat elliptical caps at t = ${t}, ${N} px: at most ${max} pixels more than 6/255 too dark (${dark}, worst ${(worst * 255).toFixed(0)}/255)`,
  );
}

// The hook block on lerped frames: a thin cap's tip arcs turn more than 90 degrees (rx 40 : ry 1.2 turns about 170 degrees), and every
// lerped frame's end normals are lerped with it. No pixel may lose its antialiasing outright (more than 64/255 too light).
A = { c: [50, 70], rx: 40, ry: 1.2, rot: 3, a0: -175, a1: -5, x0: 10, x1: 90 };
B = { c: [50, 72], rx: 36, ry: 2.4, rot: -3, a0: -175, a1: -5, x0: 14, x1: 86 };
for (const t of [0.25, 0.5, 0.75]) {
  const N = 512,
    sc = await lbScene(svgOf(A), {
      N,
      importOpts: { preserveViewport: true },
      morph: { svg: svgOf(B), t },
    });
  const cov = compositeAlpha(renderScene(sc, VT, FT, [], { coarse: false }).recs, N),
    orc = oracleAt(t, N);
  let light = 0,
    worst = 0;
  for (let i = 0; i < N * N; i++) {
    const d = orc[i] - cov[i];
    if (d > 64 / 255) light++;
    if (d > worst) worst = d;
  }
  ok(
    light === 0,
    `a morph of two thin caps (hook arcs) at t = ${t}, ${N} px: no pixel more than 64/255 too light (${light}, worst ${(worst * 255).toFixed(0)}/255)`,
  );
}
console.warn = warn;
console.log(
  fail ? `lbMorphBandHullSmoke FAIL (${fail})` : 'lbMorphBandHullSmoke: all checks passed',
);
process.exit(fail ? 1 : 0);

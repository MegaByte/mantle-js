// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// curveCovChordSmoke — a RECOGNIZED circle takes its curvature offset over the chord the pixel
// actually cuts, and a Bézier band does not.
//
// THE TRAP. `curveCov` (src/shaders/_lbCoverage.glsl) takes the exact box area of the tangent
// half-plane and offsets it by κ/24. That is the arc's mean deviation from its tangent over a chord
// of length ONE CENTERED ON THE FOOT of the perpendicular — a horizontal edge cutting straight
// across a pixel. Neither half is generally true: at 45° the line runs √2 across the cell, and near
// a corner it clips a short chord far off to one side. The SDF primitives — the route a recognized
// circle, ellipse or annulus takes instead of any decomposition — would be shaded through it,
// leaving the circle ~4.5x less accurate than AAC.
//
// THE ANSWER IS THE exact MOMENT, and it applies only where κ is CONSTANT along the level set.
// exactBoxCov integrates {n·p ≤ d} over the unit box; parameterize that line as d·n + x·perp(n),
// clip x against the two slabs, and the mean deviation over [x1, x2] is κ(x1² + x1x2 + x2²)/6 —
// because dA/dd IS the chord length, in both of exactBoxCov's branches, so that moment is the
// offset reproducing the area. Centered and unit-long it is 1/24, which is the shipped form. The
// moment weights the chord's ENDS by x², so it is only right if κ holds out there: a circle's does,
// a Bézier band's does not. So `arcCov` carries it and the circle/annulus branch calls it, while
// `curveCov` and every Loop-Blinn curve band are untouched.
//
// THE REFERENCE IS THE AREA, with no renderer in it: the exact area of a disc inside a unit pixel
// box, and of a parabola's epigraph inside one. The kernel side is the SHIPPED shader text compiled
// to float32 C++ (test/_glslEmu.mjs), not a port.
//
//   (a) circles of 3 to 96 pixel radius, through the DISC branch's own gradient and rank-1 Hessian:
//       mean coverage error falls 4.8x to 40x, and the worst single pixel 0.0120 -> 0.0019;
//   (b) the centered form κL²/24 — scaling by the chord's LENGTH but keeping it centered — gets only
//       4-6x, so the MOMENT is what buys the rest, and κ/24 restored is caught;
//   (c) on a parabola, whose κ varies along the chord, the moment is WORSE than κ/24 above a tenth
//       of a curvature per pixel. That is the measurement that keeps arcCov off the curve bands,
//       and it fails if someone routes them through it.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_CURVE_COV, K_ARC_COV } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP curveCovChordSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const SHIPPED = '  return exactBoxCov(n, d - kPx * mom);';
ok(GLSL.includes(SHIPPED), 'arcCov and its chord moment are in the shipped shader text');
// κ/24 put back, and the centered chord-LENGTH form, both as edits to arcCov alone.
const OLD = GLSL.replace(SHIPPED, '  return exactBoxCov(n, d - kPx / 24.0);');
const CENTERED = GLSL.replace(
  SHIPPED,
  [
    '  float aM = max(abs(n.x), abs(n.y)), bM = min(abs(n.x), abs(n.y));',
    '  float sS = 0.5 * (aM + bM), tT = 0.5 * (aM - bM), ad = abs(d);',
    '  float Lc = (ad >= sS) ? 0.0 : ((ad <= tT) ? 1.0 / aM : (sS - ad) / max(aM * bM, 1e-9));',
    '  return exactBoxCov(n, d - kPx * Lc * Lc / 24.0);',
  ].join('\n'),
);
ok(OLD !== GLSL && CENTERED !== GLSL, 'both mutations apply');
const emu = {
  now: buildGlslEmu(ROOT, { curveCov: true }),
  old: buildGlslEmu(ROOT, { curveCov: true, glsl: OLD }),
  centered: buildGlslEmu(ROOT, { curveCov: true, glsl: CENTERED }),
};
const EMPTY = new Float32Array(4);
const q = (kind, a) => ({
  k: kind,
  GD: [0, 0, 0, 0],
  bb: [a[0], a[1], a[2], a[3]],
  eo: false,
  c: [a[4], a[5]],
  ePx: [1, 1],
});
const score = (arm, qs, truth) => {
  const cov = emu[arm].run(EMPTY, EMPTY, qs);
  let abs = 0,
    max = 0;
  for (let i = 0; i < truth.length; i++) {
    const e = Math.abs(cov[i] - truth[i]);
    abs += e;
    if (e > max) max = e;
  }
  return { mean: abs / truth.length, max };
};
function simpson(h, a, b, n) {
  const dt = (b - a) / n;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const t0 = a + i * dt,
      t1 = t0 + dt;
    s += (dt / 6) * (h(t0) + 4 * h(0.5 * (t0 + t1)) + h(t1));
  }
  return s;
}

// ---- (a) and (b): the disc, through arcCov ------------------------------------------------------------------------
/// Exact area of the disc of radius R centered at (cx, cy) inside [x0, x0+1] x [y0, y0+1].
function discBoxArea(cx, cy, R, x0, y0) {
  const quad = (X, Y) => {
    if (X <= -R || Y <= -R) return 0;
    const xa = Math.max(-R, Math.min(R, X)),
      ya = Math.max(-R, Math.min(R, Y));
    return simpson(
      (t) => {
        const s = Math.sqrt(Math.max(0, R * R - t * t));
        return Math.max(0, Math.min(ya, s) + s);
      },
      -R,
      xa,
      20000,
    );
  };
  const X0 = x0 - cx,
    X1 = x0 + 1 - cx,
    Y0 = y0 - cy,
    Y1 = y0 + 1 - cy;
  return quad(X1, Y1) - quad(X0, Y1) - quad(X1, Y0) + quad(X0, Y0);
}
/// The DISC branch's own arguments: f = |p − C| − r, gradient = the unit radial, Hessian = the
/// rank-1 w·W⊗W with w = 1/|p − C| and W the tangent — exactly as _lbCoverage.glsl builds them.
function discArgs(dx, dy, r) {
  const L = Math.max(Math.hypot(dx, dy), 1e-9),
    hx = dx / L,
    hy = dy / L,
    w = 1 / L;
  return [L - r, hx, hy, w * hy * hy, w * hx * hx, -w * hx * hy];
}
{
  const res = [];
  for (const R of [3, 6, 12, 24, 48, 96]) {
    const cx = R + 3.37,
      cy = R + 2.13,
      qs = [],
      truth = [];
    for (let j = 0; j < Math.ceil(2 * R + 8); j++)
      for (let i = 0; i < Math.ceil(2 * R + 8); i++) {
        if (Math.abs(Math.hypot(i + 0.5 - cx, j + 0.5 - cy) - R) > 1.5) continue;
        qs.push(q(K_ARC_COV, discArgs(i + 0.5 - cx, j + 0.5 - cy, R)));
        truth.push(discBoxArea(cx, cy, R, i, j));
      }
    res.push({
      R,
      n: truth.length,
      now: score('now', qs, truth),
      old: score('old', qs, truth),
      centered: score('centered', qs, truth),
    });
  }
  const gain = res.map((r) => r.old.mean / r.now.mean);
  ok(
    Math.min(...gain) >= 4,
    `(a) ${res.length} radii, ${res.reduce((t, r) => t + r.n, 0)} edge pixels: better at EVERY radius, by ` +
      gain.map((v) => v.toFixed(1) + 'x').join(', '),
  );
  const r3 = res[0];
  ok(
    r3.now.mean < 4e-4 && r3.now.max < 3e-3,
    `(a) r = 3 px: mean ${r3.old.mean.toFixed(6)} -> ${r3.now.mean.toFixed(6)}, worst pixel ${r3.old.max.toFixed(5)} -> ${r3.now.max.toFixed(5)}`,
  );
  ok(
    res.every((r) => r.centered.mean > r.now.mean),
    `(b) the CENTRED chord-length form is worse at every radius (r = 3: ${res[0].centered.mean.toFixed(6)} against ${res[0].now.mean.toFixed(6)}; ` +
      `r = 48: ${res[4].centered.mean.toFixed(6)} against ${res[4].now.mean.toFixed(6)}) — the moment is what buys the rest`,
  );
}

// ---- (c) the parabola, which is why curveCov keeps κ/24 ------------------------------------------------------------
{
  // f(u, v) = a(u + X0)² − (v + Y0), pixel-local: the fill is the epigraph, κ = 2a/|∇f|³.
  const para = (a, X0, Y0) => [a * X0 * X0 - Y0, 2 * a * X0, -1, 2 * a, 0, 0];
  const areaOf = (a, X0, Y0) =>
    simpson(
      (u) => 0.5 - Math.max(-0.5, Math.min(0.5, a * (u + X0) * (u + X0) - Y0)),
      -0.5,
      0.5,
      4000,
    );
  const rows = [];
  for (const a of [0.02, 0.05, 0.1, 0.25]) {
    const arc = [],
      curve = [],
      truth = [];
    for (const X0 of [-2.3, -1.4, -0.7, 0, 0.55, 1.2, 1.9])
      for (let k = -6; k <= 6; k++) {
        const Y0 = a * X0 * X0 + k * 0.17;
        arc.push(q(K_ARC_COV, para(a, X0, Y0)));
        curve.push(q(K_CURVE_COV, para(a, X0, Y0)));
        truth.push(areaOf(a, X0, Y0));
      }
    rows.push({ a, arc: score('now', arc, truth), curve: score('now', curve, truth) });
  }
  ok(
    rows.filter((r) => r.a >= 0.05).every((r) => r.curve.mean < r.arc.mean),
    "(c) on a parabola from a curvature of 0.1 per pixel up, curveCov's κ/24 beats the moment: " +
      rows
        .map(
          (r) => `κ=${(2 * r.a).toFixed(2)} ${r.curve.mean.toFixed(6)} vs ${r.arc.mean.toFixed(6)}`,
        )
        .join(', '),
  );
  ok(
    rows.every((r) => r.curve.mean < 0.01),
    '(c) ...and curveCov itself is unchanged, so no Loop-Blinn curve band moves',
  );
}

console.log(fail ? `curveCovChordSmoke FAIL (${fail})` : 'curveCovChordSmoke PASS');
process.exit(fail ? 1 : 0);

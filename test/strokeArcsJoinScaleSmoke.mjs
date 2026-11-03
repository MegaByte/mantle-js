// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeArcsJoinScaleSmoke — the arcs join's edge distance is the distance to the edge's osculating circle at every
// curvature and every coordinate scale (_strokeMath.glsl perpDistToArc, and its hit-test port in
// src/hitTest/curveGeom.js).
//
// THE HAZARD. A perpDistToArc that returns the distance to the TANGENT LINE whenever |kappa| < 1e-6, and otherwise
// | |q - R L| - |R| | with R = 1/kappa, is scale-dependent: kappa is a curvature PER EM, so 1e-6 is a statement about the
// drawing's units -- at 2^20 a unit-radius edge has kappa 9.5e-7 and takes the straight branch, so on large-coordinate
// art an arcs join draws as miter-clip. And the circle form subtracts two radii to get a distance of size |q|, which
// float32 loses once kappa |q| is small -- ~2^-24 |R| of error, several percent of |q| just past the cut even at scale 1.
// The form used:
//   d = |kappa |q|^2 - 2 q.L| / (|kappa q - L| + 1)
// the same distance multiplied through by |kappa|: no threshold, no cancellation, continuous through kappa = 0.
//
// The kernel side is the SHIPPED shader text run in float32 on the CPU (test/_glslEmu.mjs, `stroke: true`); the
// reference is the circle form in float64, which is well conditioned over the sampled range.
//
// (a) seeded (q, tangent, kappa) with kappa |q| from 1e-6 to 10 and either sign, at 2^-20, 1 and 2^20 (q scaled by S,
//     kappa by 1/S): the shader is within 1e-5 |q| of the reference at every scale;
// (b) kappa == 0 is bit-identical to |q . L|, the miter-clip branch's perpendicular distance;
// (c) the hit-test port agrees with the same reference to 1e-7 |q| at every scale (float64 arithmetic on the same
//     float32 tangent, which is unit only to ~6e-8);
// (d) mutation: the absolute |kappa| < 1e-6 restored is caught by (a).
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_PERP_ARC, emuContractDefault, fmaf32 } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SCALES = [2 ** -20, 1, 2 ** 20];
const lg = (S) => `2^${Math.round(Math.log2(S))}`;
const f = Math.fround;

// ---- the cases ------------------------------------------------------------------------------------------------------------
let seed = 0xa2c5;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const CASES = [];
for (let i = 0; i < 400; i++) {
  const a = rnd() * 2 * Math.PI,
    tan = [f(Math.cos(a)), f(Math.sin(a))];
  const qa = rnd() * 2 * Math.PI,
    qr = 0.2 + rnd() * 3; // |q| up to a few half-widths, as a join queries it
  const q = [qr * Math.cos(qa), qr * Math.sin(qa)];
  const kq = 10 ** (-6 + rnd() * 7); // kappa |q| from 1e-6 to 10
  CASES.push({ q, tan, kappa: ((rnd() < 0.5 ? -1 : 1) * kq) / qr, qr });
}
/// | |q - R L| - |R| | in float64: R = 1 / kappa, L the UNIT left normal. Well conditioned here: kappa |q| >= 1e-6
/// costs at most 1e-16 |R| <= 1e-10 |q|. The tangent is normalized in float64 first: the float32 tangent the shader is
/// handed is unit only to ~6e-8, and a circle of radius |R| centered R L misses the vertex by that much of R -- 0.15 at
/// R = 2.5e6. The osculating circle passes THROUGH the vertex; the shader's form assumes exactly that.
const ref = (q, tan, kappa) => {
  const n = Math.hypot(tan[0], tan[1]),
    R = 1 / kappa,
    Lx = -tan[1] / n,
    Ly = tan[0] / n;
  return Math.abs(Math.hypot(q[0] - R * Lx, q[1] - R * Ly) - Math.abs(R));
};
const at = (S) =>
  CASES.map((c) => ({
    q: [f(c.q[0] * S), f(c.q[1] * S)],
    tan: c.tan,
    kappa: f(c.kappa / S),
    qr: c.qr * S,
  }));

// ---- (a) the shader ----------------------------------------------------------------------------------------------------------
function shaderWorst(emu) {
  const out = new Map();
  for (const S of SCALES) {
    const cs = at(S);
    const got = emu.run(
      new Float32Array(4),
      new Float32Array(4),
      cs.map((c) => ({ k: K_PERP_ARC, bb: [c.q[0], c.q[1], c.tan[0], c.tan[1]], c: [c.kappa, 0] })),
    );
    let w = 0;
    cs.forEach((c, i) => {
      w = Math.max(w, Math.abs(got[i] - ref(c.q, c.tan, c.kappa)) / c.qr);
    });
    out.set(S, w);
  }
  return out;
}
if (!hasCxx()) {
  console.log(
    '  SKIPPED (a), (b), (d): no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation',
  );
} else {
  const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const emu = buildGlslEmu(ROOT, { stroke: true });
  const w = shaderWorst(emu);
  ok(
    [...w.values()].every((v) => v <= 1e-5),
    `(a) ${CASES.length} cases, kappa |q| 1e-6..10: the shader is within ${[...w].map(([S, v]) => `${v.toExponential(1)} at ${lg(S)}`).join(', ')} of |q| of the osculating-circle distance (bar 1e-5)`,
  );

  // ---- (b) kappa == 0 ----------------------------------------------------------------------------------------------------------
  const zs = CASES.map((c) => ({
    k: K_PERP_ARC,
    bb: [f(c.q[0]), f(c.q[1]), c.tan[0], c.tan[1]],
    c: [0, 0],
  }));
  const got = emu.run(new Float32Array(4), new Float32Array(4), zs);
  // |q . L| as the emulator rounds it: two products and a sum, or the fused twin's fma for the second term (T15)
  const qL = (z) =>
    emuContractDefault()
      ? fmaf32(z.bb[1], z.bb[2], f(z.bb[0] * f(-z.bb[3])))
      : f(f(z.bb[0] * f(-z.bb[3])) + f(z.bb[1] * z.bb[2]));
  const bad = zs.filter((z, i) => got[i] !== Math.abs(qL(z))).length;
  ok(
    bad === 0,
    `(b) at kappa == 0 the distance is |q . L| bit for bit, the miter-clip branch's (${bad} of ${zs.length} differ)`,
  );

  // ---- (d) mutation ------------------------------------------------------------------------------------------------------------
  const EXACT = 'if (kappa == 0.0) return abs(dot(q, L));';
  ok(
    GLSL.split(EXACT).length === 2,
    '(d) the exact-zero branch is in the shipped text once (the mutation hinge)',
  );
  const mut = shaderWorst(
    buildGlslEmu(ROOT, {
      stroke: true,
      glsl: GLSL.replace(EXACT, 'if (abs(kappa) < 1e-6) return abs(dot(q, L));'),
    }),
  );
  ok(
    mut.get(2 ** 20) > 1e-2,
    `(d) the absolute |kappa| < 1e-6 restored is caught: ${mut.get(2 ** 20).toExponential(1)} of |q| off at 2^20`,
  );
}

// ---- (c) the hit-test port -------------------------------------------------------------------------------------------------
{
  const hitPerp = (await import('../src/hitTest/curveGeom.js')).perpDistToArc;
  ok(typeof hitPerp === 'function', '(c) curveGeom.js exports its perpDistToArc');
  let w = Infinity;
  if (hitPerp) {
    w = 0;
    for (const S of SCALES)
      for (const c of at(S))
        w = Math.max(
          w,
          Math.abs(
            hitPerp(c.q[0], c.q[1], c.tan[0], c.tan[1], c.kappa) - ref(c.q, c.tan, c.kappa),
          ) / c.qr,
        );
  }
  ok(
    w <= 1e-7,
    `(c) the hit-test port agrees with the reference at every scale (worst ${w.toExponential(1)} of |q|, the float32 tangent's own precision)`,
  );
}

console.log(fail ? `STROKE-ARCS-JOIN-SCALE FAIL (${fail})` : 'STROKE-ARCS-JOIN-SCALE PASS');
process.exit(fail ? 1 : 0);

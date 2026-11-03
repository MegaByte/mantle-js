// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchTexelDegree — is a CPatch morph's coefficient stream a POLYNOMIAL in t?
//
// A CPatch morph costs what it costs because every frame rebuilds the packed coefficients on the
// CPU and uploads them. Loop-Blinn does not pay that: its mesh is static and the vertex shader
// lerps control points. CPatch cannot lerp its COEFFICIENTS — the implicit of a curve is a
// resultant determinant, not a linear function of the control points — but it does not have to.
// Under a linear control-point morph P(t) = (1-t)A + tB every Bezout entry is degree <= 2 in t,
// so the 3x3 determinant is degree <= 6, and a degree-D polynomial is reconstructed exactly from
// D+1 static samples. If that holds, the shader evaluates a fixed Bernstein blend of planes that
// were uploaded once, and the per-frame CPU re-pose and upload both go away.
//
// This measures the minimal exact degree: interpolate each texel through D+1 equispaced poses of
// a segment, then compare against poses the interpolant never saw.
import { convertContour, framePatch } from '../src/renderer/cpatchConvert.js';
import {
  planMorph,
  layoutAt,
  applyLayout,
  splitForMorph,
} from '../src/renderer/cpatchMorphCert.js';
import { packCPatchMorphFrame, planCPatchMorphSegment } from '../src/renderer/cpatchPack.js';

const K = 6;
const blob = (t, phase, kind) => {
  const R = 40 + 22 * t,
    cx = 100,
    cy = 100;
  const at = (j) => [
    cx + R * Math.cos((2 * Math.PI * j) / K + phase * t),
    cy + R * Math.sin((2 * Math.PI * j) / K + phase * t),
  ];
  const out = [];
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1),
      bow = 0.3 + 0.14 * t;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    if (kind === 'cubic')
      out.push({
        t: 'cubic',
        P: [
          A,
          [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
          [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
          B,
        ],
      });
    else if (kind === 'rquad') out.push({ t: 'rquad', P: [A, [mx, my], B], w: 0.75 + 0.1 * t });
    else out.push({ t: 'quad', P: [A, [mx, my], B] });
  }
  return out;
};
const convert = (cs) => {
  try {
    return convertContour(cs, {
      maxCurves: 8,
      tolPx: 0.05,
      noCurveCuts: true,
      forceBezout: true,
      leakMargin: 0,
    });
  } catch {
    return null;
  }
};
const poseAt = (A, B, t) =>
  A.map((c, i) => ({
    t: c.t,
    cut: c.cut,
    w: c.w,
    _bez: c._bez,
    P: c.P.map((q, m) => [q[0] + (B[i].P[m][0] - q[0]) * t, q[1] + (B[i].P[m][1] - q[1]) * t]),
  }));

// Barycentric Lagrange through equispaced nodes — D <= 8 here, so conditioning is a non-issue.
function interpAt(ys, u) {
  const D = ys.length - 1;
  if (D === 0) return ys[0];
  let num = 0,
    den = 0;
  for (let j = 0; j <= D; j++) {
    const xj = j / D;
    if (Math.abs(u - xj) < 1e-14) return ys[j];
    let w = 1;
    for (let m = 0; m <= D; m++) if (m !== j) w /= xj - m / D;
    const c = w / (u - xj);
    num += c * ys[j];
    den += c;
  }
  return num / den;
}

console.log('\nIs a CPatch morph frame polynomial in t?  (minimal exact interpolation degree)\n');
console.log('  kind   rot  seg  texels |  D=1 (lerp)      D=2         D=4         D=6         D=8');
let worstNeeded = 0;
const offenders = [];
const tally = {};
const slotDeg = [];
for (const kind of ['quad', 'rquad', 'cubic']) {
  for (const phase of [0, 1.0, 2.0]) {
    const [A, B] = splitForMorph(blob(0, phase, kind), blob(1, phase, kind));
    const plan = planMorph(A, B, convert, { tolPx: 0.05 });
    if (!plan) {
      console.log(`  ${kind.padEnd(6)} ${String(phase).padEnd(4)} no plan`);
      continue;
    }
    for (let si = 0; si < plan.length; si++) {
      const seg = plan[si],
        lay = seg.layout;
      const frameAt = (t) => {
        const ls = applyLayout(lay, poseAt(A, B, t));
        if (!ls) return null;
        const ps = [];
        for (const l of ls) {
          const f = framePatch(l);
          if (!f) return null;
          ps.push(f);
        }
        return ps;
      };
      const a2 = frameAt(seg.t0),
        b2 = frameAt(seg.t1);
      const segPlan = a2 && b2 ? planCPatchMorphSegment(a2, b2, 0, {}) : null;
      if (!segPlan) {
        console.log(`  ${kind.padEnd(6)} ${String(phase).padEnd(4)} ${si}  no segment plan`);
        continue;
      }
      // u is the SEGMENT-LOCAL parameter; it is affine in t, so it cannot change the degree.
      const tOf = (u) => seg.t0 + (seg.t1 - seg.t0) * u;
      const texAt = (u) => {
        const ps = frameAt(tOf(u));
        if (!ps) return null;
        const pk = packCPatchMorphFrame(ps, segPlan, null);
        return pk ? Float64Array.from(pk.texels) : null;
      };
      // Probe poses the interpolant never sees. Irrational offsets so they cannot coincide with
      // a node at any degree tried.
      const TEST = [0.137, 0.2718, 0.4142, 0.618, 0.7071, 0.9163];
      const truth = TEST.map(texAt);
      // THE SLOTS MUST NOT MOVE. kind (slot 3) and sg (slot 7) are fixed for a segment by
      // construction, so if they differ between poses the pack is not writing the same curve
      // into the same block and every comparison below is meaningless.
      if (truth.every((x) => x)) {
        let shifted = 0;
        for (const r of truth)
          for (let i = 0; i < r.length; i += 16)
            if (r[i + 3] !== truth[0][i + 3] || r[i + 7] !== truth[0][i + 7]) shifted++;
        if (shifted) {
          console.log(
            `  ${kind.padEnd(6)} ${String(phase).padEnd(4)} ${si}  SLOTS MOVE across t (${shifted} blocks) — not comparable`,
          );
          continue;
        }
      }
      if (truth.some((x) => !x)) {
        console.log(`  ${kind.padEnd(6)} ${String(phase).padEnd(4)} ${si}  pack failed`);
        continue;
      }
      const n = truth[0].length;
      let scale = 0;
      for (const r of truth) for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(r[i]));
      const cells = [];
      let needed = Infinity;
      const errs = [];
      for (const D of [1, 2, 4, 6, 8]) {
        const nodes = [];
        let bad = false;
        for (let j = 0; j <= D; j++) {
          const x = texAt(j / D);
          if (!x) {
            bad = true;
            break;
          }
          nodes.push(x);
        }
        if (bad) {
          cells.push('   pack fail');
          continue;
        }
        let err = 0;
        for (let k = 0; k < TEST.length; k++)
          for (let i = 0; i < n; i++)
            err = Math.max(
              err,
              Math.abs(
                interpAt(
                  nodes.map((r) => r[i]),
                  TEST[k],
                ) - truth[k][i],
              ),
            );
        const rel = err / Math.max(scale, 1e-30);
        cells.push(rel.toExponential(1).padStart(11));
        errs.push(rel);
        // The texels are float32, so ~1e-7 relative IS exact — a stricter floor would call
        // storage roundoff a modelling error.
        if (rel < 3e-7 && needed === Infinity) needed = D;
      }
      if (needed !== Infinity) worstNeeded = Math.max(worstNeeded, needed);
      // PER-SLOT DEGREE. A block is 16 floats: rows a[0..3] as (x, y, z) plus kind, sg, c0, c1.
      // The derivation says x and y come from Xm/Ym, which are LINEAR in the control points and
      // so linear in t once the conditioning is frozen, while z carries a cross product and is
      // quadratic. If that holds, a block's t-evolution does not need three full poses.
      {
        const deg = new Array(16).fill(Infinity);
        for (const D of [0, 1, 2]) {
          const nodes = [];
          let bad2 = false;
          for (let j = 0; j <= D; j++) {
            const x = texAt(D === 0 ? 0.5 : j / D);
            if (!x) {
              bad2 = true;
              break;
            }
            nodes.push(x);
          }
          if (bad2) continue;
          for (let sl = 0; sl < 16; sl++) {
            if (deg[sl] !== Infinity) continue;
            let e = 0;
            for (let i = sl; i < n; i += 16)
              for (let k = 0; k < TEST.length; k++)
                e = Math.max(
                  e,
                  Math.abs(
                    interpAt(
                      nodes.map((r) => r[i]),
                      TEST[k],
                    ) - truth[k][i],
                  ),
                );
            if (e / Math.max(scale, 1e-30) < 3e-7) deg[sl] = D;
          }
        }
        slotDeg.push(deg);
      }
      // WHICH TEXELS refuse. A block is 16 floats, so the slot (index mod 16) names the
      // quantity, and that says what in the stream is not a polynomial in t.
      {
        const D = 6,
          nodes = [];
        let bad2 = false;
        for (let j = 0; j <= D; j++) {
          const x = texAt(j / D);
          if (!x) {
            bad2 = true;
            break;
          }
          nodes.push(x);
        }
        if (!bad2) {
          const slotBad = new Array(16).fill(0),
            slotN = new Array(16).fill(0);
          const byKind = new Map(),
            blkBad = new Set(),
            blkAll = new Set();
          let nbad = 0;
          for (let i = 0; i < n; i++) {
            blkAll.add(i >> 4);
            let e = 0;
            for (let k = 0; k < TEST.length; k++)
              e = Math.max(
                e,
                Math.abs(
                  interpAt(
                    nodes.map((r) => r[i]),
                    TEST[k],
                  ) - truth[k][i],
                ),
              );
            slotN[i % 16]++;
            if (e / Math.max(scale, 1e-30) > 1e-6) {
              slotBad[i % 16]++;
              nbad++;
              blkBad.add(i >> 4);
              const kd = truth[0][(i >> 4) * 16 + 3]; // slot 3 is the kind, constant in t
              byKind.set(kd, (byKind.get(kd) || 0) + 1);
            }
          }
          if (nbad)
            offenders.push({
              kind,
              phase,
              si,
              nbad,
              n,
              blk: blkBad.size,
              blkAll: blkAll.size,
              kinds: [...byKind.entries()]
                .sort((x, y) => y[1] - x[1])
                .map(([k2, c2]) => 'kind' + k2 + ':' + c2)
                .join(' '),
              slots: slotBad
                .map((b, i) => (b ? i + ':' + b : ''))
                .filter(Boolean)
                .join(' '),
            });
        }
      }
      // WHICH failure it is decides the fix. Still improving by the last step means an analytic
      // but non-polynomial function — a RATIONAL one, which a numerator/denominator pair of
      // static planes still reconstructs exactly. Flat means a switch: some curve changes
      // derivation branch mid-segment, and no degree can cross a discontinuity. That one wants
      // the segment split at the switch, which the plan already knows how to do.
      const verdict =
        needed !== Infinity
          ? 'EXACT at D=' + needed
          : errs[errs.length - 1] < errs[errs.length - 2] * 0.5
            ? 'rational (still converging)'
            : 'SWITCH (plateaued)';
      console.log(
        `  ${kind.padEnd(6)} ${String(phase).padEnd(4)} ${si}  ${String(n).padStart(6)} |${cells.join('')}   -> ${verdict}`,
      );
      tally[verdict.split(' ')[0]] = (tally[verdict.split(' ')[0]] | 0) + 1;
    }
  }
}
if (offenders.length) {
  console.log('\n  WHICH texels refuse a degree-6 fit (slot within the 16-float block : count):');
  for (const o of offenders)
    console.log(
      `    ${o.kind.padEnd(6)} rot ${String(o.phase).padEnd(4)} seg ${o.si}  blocks ${String(o.blk).padStart(4)}/${String(o.blkAll).padStart(4)}   ${o.kinds}`,
    );
}
console.log(
  `\n  relative error vs the largest coefficient in the frame; < 1e-9 is exact to double roundoff.`,
);
{
  const names = [
    'a0.x',
    'a0.y',
    'a0.z',
    'kind',
    'a1.x',
    'a1.y',
    'a1.z',
    'sg',
    'a2.x',
    'a2.y',
    'a2.z',
    'c0',
    'a3.x',
    'a3.y',
    'a3.z',
    'c1',
  ];
  const worst = new Array(16).fill(0);
  for (const d of slotDeg)
    for (let i = 0; i < 16; i++) worst[i] = Math.max(worst[i], d[i] === Infinity ? 9 : d[i]);
  console.log(
    '\n  MINIMAL EXACT DEGREE PER SLOT, worst over every segment (9 = needs more than 2):',
  );
  for (let r = 0; r < 4; r++)
    console.log(
      '    ' +
        [0, 1, 2, 3]
          .map((c) => {
            const i = r * 4 + c;
            return names[i].padStart(5) + ' deg ' + worst[i];
          })
          .join('   '),
    );
  const f2 = worst.filter((d) => d === 2).length,
    f1 = worst.filter((d) => d <= 1).length;
  console.log(`\n  ${f1} of 16 slots are degree <= 1, ${f2} are degree 2.`);
  console.log(
    '  Three full poses store 3 values for all 16. Splitting by degree stores ' +
      (f1 * 2 + f2 * 3) +
      ' instead of 48 floats per block.',
  );
}
console.log(
  '  segments: ' +
    Object.entries(tally)
      .map(([k, v]) => k + ' ' + v)
      .join(', '),
);
console.log(
  `\n  ${tally.EXACT | 0} segment(s) need nothing but ${worstNeeded + 1} static planes and a Bernstein blend.`,
);
console.log(
  `  ${tally.rational | 0} are rational in t — exact from a numerator/denominator pair, or from the`,
);
console.log(
  '    UNNORMALIZED implicit alone, since the patch test is a SIGN and a positive scale cannot change it.',
);
console.log(
  `  ${tally.SWITCH | 0} plateau: a derivation branch changes mid-segment, and no degree crosses a`,
);
console.log('    discontinuity. Those want the segment split at the switch.');

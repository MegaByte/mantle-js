// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbChainSide — which SIDE of the packed chain does the fill actually lie on?
//
// A chain quad-seam defect can survive an exact quadratic-implicit side test with the DERIVED
// sign, and only half-fix with the sign inverted. Inverting a sign to make a number drop is not a fix, so pin the
// convention down first, on the ground rather than in the shader:
//
//   chainBoxCov defines fill = LEFT of the directed chain P0->P1->...
//   For a convex quad ellipse the fill is the INTERIOR, so for every packed chain
//   the ellipse CENTER must be to the left of every consecutive pair.
//
// Node-side on purpose: the LB build runs in a worker in the browser, so page
// globals never reach it and there is nothing to read back. buildLbBundle is the
// same entry the worker calls.
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');

const N = +(process.env.N || 8),
  CX = 20,
  CY = 20,
  RX = 17,
  RY = 11;
function quadEllipse(n) {
  const pt = (a) => [CX + RX * Math.cos(a), CY + RY * Math.sin(a)];
  const tan = (a) => [-RX * Math.sin(a), RY * Math.cos(a)];
  let d = '';
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n,
      a1 = (2 * Math.PI * (i + 1)) / n;
    const p0 = pt(a0),
      p1 = pt(a1),
      t0 = tan(a0),
      t1 = tan(a1);
    const det = t0[0] * -t1[1] - t0[1] * -t1[0];
    const s = ((p1[0] - p0[0]) * -t1[1] - (p1[1] - p0[1]) * -t1[0]) / det;
    d +=
      (i === 0 ? `M${p0[0]} ${p0[1]}` : '') +
      `Q${p0[0] + s * t0[0]} ${p0[1] + s * t0[1]} ${p1[0]} ${p1[1]}`;
  }
  return d + 'Z';
}
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">` +
  `<path fill="#000" d="${quadEllipse(N)}"/></svg>`;

const b = await importSvg(svg);
const out = buildLbBundle({
  // bundle.meta carries a 32-BYTE HEADER; wrapping it whole shifts every meta row by 8 floats and sends most
  // shapes down the CDT partition, so a build measured that way is 20x the real one. Strip it, as the tests do.
  curveFloats: new Float32Array(b.curves),
  metaFloats: b.meta ? new Float32Array(b.meta, 32) : null,
  metaFloatsPerShape: b.metaFloatsPerShape,
  ranges: b.curveRangesByShape,
  numShapes: b.numShapes,
});

// Read the chains PRE-pack, straight off the mesh record: interiorChainA holds
// P0,P1 per interior vertex, B holds P2,P3, C holds P4 and the SENTINEL.
// (Post-pack they are scattered across aC3/aC0/aTC; the same numbers, more slots
// to get wrong.)
let chains = 0,
  wrong = 0,
  degenerate = 0,
  straight = 0,
  conic = 0;
const rows = [];
for (const m of out.raw || []) {
  const A = m.interiorChainA,
    B = m.interiorChainB,
    C = m.interiorChainC;
  if (!A || !m.interior) continue;
  for (let v = 0; v * 4 + 3 < A.length; v += 3) {
    // one chain per TRIANGLE
    const o = v * 4;
    const P = [
      [A[o], A[o + 1]],
      [A[o + 2], A[o + 3]],
      [B[o], B[o + 1]],
      [B[o + 2], B[o + 3]],
      [C[o], C[o + 1]],
    ];
    const sent = C[o + 2];
    if (!isFinite(sent) || sent < 1.5) continue; // no chain on this face
    sent > 3.5 ? conic++ : straight++;
    // A CONIC chain reads P0,P1,P2 and P2,P3,P4 as two quadratics (P1/P3 are the
    // CONTROL points). Its on-curve points — the ones the left-of convention
    // orders — are P0,P2,P4. A straight chain is on-curve at all five.
    const on = sent > 2.5 ? [P[0], P[2], P[4]] : P;
    chains++;
    for (let k = 0; k + 1 < on.length; k++) {
      const a = on[k],
        c = on[k + 1];
      const dx = c[0] - a[0],
        dy = c[1] - a[1];
      if (dx * dx + dy * dy < 1e-14) {
        degenerate++;
        continue;
      }
      // left of a->c  <=>  cross(c-a, center-a) > 0 in a y-UP frame.
      const cr = dx * (CY - a[1]) - dy * (CX - a[0]);
      if (cr < 0) {
        wrong++;
        rows.push({ sent: +sent.toFixed(1), k, a, c, cr: +cr.toFixed(3) });
      }
    }
  }
}
console.log(`  chain sentinels: straight ${straight}, cubic ${conic}`);
// Does each face's chain actually SPAN that face? The chain kernels extend the
// chain along its terminal tangent past the ends, so a face whose box reaches
// beyond the chain's on-curve span is served by an extension, not by the curve.
for (const m of out.raw || []) {
  const A = m.interiorChainA,
    B = m.interiorChainB,
    C = m.interiorChainC,
    I = m.interior;
  if (!A || !I) continue;
  console.log('\n  per-face chain span vs face extent (em):');
  for (let v = 0; v * 4 + 3 < A.length; v += 3) {
    const o = v * 4;
    const sent = C[o + 2];
    if (!isFinite(sent) || sent < 1.5) continue;
    const on = [
      [A[o], A[o + 1]],
      [B[o], B[o + 1]],
      [C[o], C[o + 1]],
    ];
    const ctrl = [
      [A[o + 2], A[o + 3]],
      [B[o + 2], B[o + 3]],
    ];
    // ellipse residual of the on-curve points: ((x-cx)/rx)^2+((y-cy)/ry)^2 - 1
    const res = on.map((p) => +(((p[0] - CX) / RX) ** 2 + ((p[1] - CY) / RY) ** 2 - 1).toFixed(4));
    const ctrlDev = ctrl.map((c, k) => {
      const a = on[k],
        b = on[k + 1];
      return +Math.hypot(c[0] - (a[0] + b[0]) / 2, c[1] - (a[1] + b[1]) / 2).toFixed(3);
    });
    // how far does the FACE reach past the chain's on-curve span?
    let worst = 0;
    for (let t = v * 2; t < v * 2 + 6; t += 2) {
      const q = [I[t], I[t + 1]];
      let d = Infinity;
      for (let k = 0; k + 1 < on.length; k++) {
        const a = on[k],
          b = on[k + 1];
        const dx = b[0] - a[0],
          dy = b[1] - a[1],
          L2 = dx * dx + dy * dy || 1e-30;
        const s = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2));
        d = Math.min(d, Math.hypot(a[0] + s * dx - q[0], a[1] + s * dy - q[1]));
      }
      worst = Math.max(worst, d);
    }
    console.log(
      `    sent=${sent.toFixed(1)} onCurveResidual=[${res}] ctrlDev=[${ctrlDev}] faceReachPastChain=${worst.toFixed(3)}`,
    );
  }
}

console.log(`\n  quad ellipse N=${N}`);
console.log(`  kind-0 chains: ${chains}   degenerate pairs: ${degenerate}`);
console.log(`  pairs with the CENTER on the RIGHT (fill should be LEFT): ${wrong}`);
for (const r of rows.slice(0, 12))
  console.log(
    `    sent=${r.sent} seg${r.k}  [${r.a.map((v) => v.toFixed(2))}] -> [${r.c.map((v) => v.toFixed(2))}]  cross=${r.cr}`,
  );
if (!chains) {
  console.error('  [FATAL] no kind-0 chains — nothing was measured');
  process.exitCode = 1;
}

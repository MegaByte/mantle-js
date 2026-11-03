// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzImplEval — one curve's implicit evaluated along another, at two exactly-related sizes.
// The implicit's VALUE is the thing every prune and every depth is computed from; if it is not
// the same function of the same geometry at two sizes, nothing above it can be.
import { readFileSync } from 'fs';
import { segImplicit, implAlongSeg, segPt, segImplicitPacked } from '../src/geom/cpatchImplicit.js';
const J = JSON.parse(readFileSync(process.env.IN, 'utf8'));
const base = J.a.map((sg) => ({
  t: sg.t,
  P: sg.P.map((p) => [p[0] / J.Sa, p[1] / J.Sa]),
  ...(sg.cut ? { cut: true } : {}),
}));
const sc = (S) =>
  base.map((sg) => ({
    t: sg.t,
    P: sg.P.map((p) => [p[0] * S, p[1] * S]),
    ...(sg.cut ? { cut: true } : {}),
  }));
const I = Number(process.env.I || 0),
  Jx = Number(process.env.J || 2);
const rows = {};
for (const k of (process.env.KS || '0,6').split(',').map(Number)) {
  const L = sc(2 ** k);
  const impl = segImplicit(L[I]);
  const pk = segImplicitPacked(L[I]);
  rows[k] = {
    kind: pk && pk.kind,
    B: impl ? implAlongSeg(impl, L[Jx]) : null,
    at: [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const p = segPt(L[Jx], t);
      return implEvalAt(impl, p);
    }),
  };
}
function implEvalAt(impl, p) {
  if (!impl) return NaN;
  let sum = 0;
  for (const term of impl.terms) {
    let v = term.c;
    for (const f of term.fs) v *= f[0] * p[0] + f[1] * p[1] + f[2];
    sum += v;
  }
  return sum;
}
const [ka, kb] = Object.keys(rows);
const A = rows[ka],
  B = rows[kb];
console.log(`curve ${I} implicit kind ${A.kind}/${B.kind}, composed along curve ${Jx}`);
console.log(`  B coeffs (${A.B.length}):`);
for (let i = 0; i < A.B.length; i++) {
  const r =
    A.B[i] === 0 && B.B[i] === 0
      ? 0
      : Math.abs(A.B[i] - B.B[i]) / Math.max(Math.abs(A.B[i]), 1e-300);
  console.log(
    `    #${i}  ${A.B[i].toExponential(10)}   ${B.B[i].toExponential(10)}   rel ${r.toExponential(2)}`,
  );
}
console.log(
  `  values along j: ${A.at.map((v) => v.toExponential(6))}\n                 ${B.at.map((v) => v.toExponential(6))}`,
);

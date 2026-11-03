// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzValidateOne — validatePatch on ONE extracted loop at several sizes: the full violation list,
// so a pair that is reported at one size and not another is named rather than inferred.
import { readFileSync } from 'fs';
import { framePatch, validatePatch } from '../src/renderer/cpatchConvert.js';
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
const rows = {};
for (const k of (process.env.KS || '0,6').split(',').map(Number)) {
  const S = 2 ** k;
  globalThis.__CP_PRUNE_TRACE = [];
  globalThis.__CP_BOX_TRACE = [];
  const f = framePatch(sc(S));
  const v = f ? validatePatch(f) : null;
  rows[k] = v
    ? {
        ok: v.ok,
        worst:
          v.worst &&
          `${v.worst.kind} i${v.worst.i}j${v.worst.j} dep/S=${(v.worst.depth / S).toExponential(8)}`,
        viol: (v.viol || []).map((e) => `${e.dep / S}`).sort(),
        prune: globalThis.__CP_PRUNE_TRACE.map((e) => `i${e.i}j${e.j}:${e.why}`),
        box: globalThis.__CP_BOX_TRACE.map(
          (e) =>
            `i${e.i} kind${e.kind} s=${e.s} min=${e.min} bb=${e.bb.map((v) => (v / S).toFixed(9)).join(',')}`,
        ),
      }
    : null;
}
const [ka, kb] = Object.keys(rows);
const A = rows[ka],
  B = rows[kb];
console.log(`loop n=${base.length}`);
console.log(`  2^${ka}: ok=${A.ok} worst=${A.worst}  viol=${A.viol.length}`);
console.log(`  2^${kb}: ok=${B.ok} worst=${B.worst}  viol=${B.viol.length}`);
const setA = new Set(A.viol),
  setB = new Set(B.viol);
const onlyA = A.viol.filter((x) => !setB.has(x)),
  onlyB = B.viol.filter((x) => !setA.has(x));
if (onlyA.length || onlyB.length)
  console.log(
    `  depths only in 2^${ka}: ${onlyA.slice(0, 6)}\n  depths only in 2^${kb}: ${onlyB.slice(0, 6)}`,
  );
const pa = new Set(A.prune),
  pb = new Set(B.prune);
console.log(`  pruned ${A.prune.length} vs ${B.prune.length}`);
console.log(`  pruned only at 2^${ka}: ${A.prune.filter((x) => !pb.has(x)).slice(0, 8)}`);
console.log(`  pruned only at 2^${kb}: ${B.prune.filter((x) => !pa.has(x)).slice(0, 8)}`);
console.log(`  box calls ${A.box.length} vs ${B.box.length}`);
for (let i = 0; i < Math.min(A.box.length, B.box.length); i++)
  if (A.box[i] !== B.box[i]) {
    console.log(`  box #${i}:\n    ${A.box[i]}\n    ${B.box[i]}`);
    break;
  }

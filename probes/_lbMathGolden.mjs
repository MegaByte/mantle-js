// _lbMathGolden.mjs — cubic/hull math parity goldens for the C# port.
import { writeFileSync } from 'fs';
import {
  bezoutCubicImplicit, evalBezout, cubicKLMN, cubicSignKLMN, cubicSign,
  cubicInflections, cubicLoop, cubicPt, cubicSlice, partitionCubicSplitTs, uvInHull,
} from '../src/renderer/lbCubicMath.js';

// battery of cubics exercising serpentine / convex / concave / loop / fat-turn
const cubics = {
  serpentine: [[0, 0], [3, 8], [7, -8], [10, 0]],
  convex:     [[0, 0], [3, 6], [7, 6], [10, 0]],
  concave:    [[0, 0], [3, -4], [7, -4], [10, 0]],
  loop:       [[0, 0], [12, 8], [-2, 8], [10, 0]],
  fatturn:    [[0, 0], [10, 0], [10, 10], [0, 10]],
  inflect:    [[0, 0], [4, 6], [6, -6], [10, 0]],
  nearline:   [[0, 0], [3, 0.05], [7, -0.05], [10, 0]],
};

const sampleAt = (P) => {
  const c = cubicPt(P, 0.5), m = [(P[1][0] + P[2][0]) / 2, (P[1][1] + P[2][1]) / 2];
  return [[c[0], c[1]], [m[0], m[1]], [P[0][0] + 1, P[0][1] + 1], [5, 3], [2, -2]];
};

const cubicOut = {};
for (const [name, P] of Object.entries(cubics)) {
  const F = bezoutCubicImplicit(P);
  const klmn = cubicKLMN(P);
  const pts = sampleAt(P);
  const split = partitionCubicSplitTs(P);
  cubicOut[name] = {
    P,
    bezoutEval: pts.map(([x, y]) => evalBezout(F, x, y)),
    klmn: klmn ? { k: klmn.k, l: klmn.l, m: klmn.m } : null,
    signKLMN: klmn ? [cubicSignKLMN(P, klmn, false), cubicSignKLMN(P, klmn, true)] : null,
    signBezout: [cubicSign(P, F, false), cubicSign(P, F, true)],
    inflections: cubicInflections(P),
    loop: cubicLoop(P),
    pt: [cubicPt(P, 0.25), cubicPt(P, 0.5), cubicPt(P, 0.75)],
    slice: cubicSlice(P, 0.3, 0.7),
    splitTs: split.ts,
    fatTs: [...split.fatTs].sort((a, b) => a - b),
  };
}

// uvInHull cases — integral (w=1) and rational (w≠1)
const hulls = {
  integral: { a: [0, 0], c: [5, 0], b: [10, 10], w: 1 },
  rational: { a: [0, 0], c: [5, 1], b: [10, 10], w: 0.7071067811865476 },
  degenerate: { a: [0, 0], c: [5, 0], b: [10, 0], w: 1 },   // collinear → null
};
const uvOut = {};
for (const [name, h] of Object.entries(hulls)) {
  const pts = [[3, 2], [5, 5], [1, 0.5], [7, 8]];
  uvOut[name] = { h, uv: pts.map(([x, y]) => uvInHull(h, x, y)) };
}

writeFileSync(new URL('../../csharp_tests/lb-parity/goldens/math.json', import.meta.url),
  JSON.stringify({ version: 1, cubics: cubicOut, hulls: uvOut }));
console.log('emitted math goldens:', Object.keys(cubicOut).length, 'cubics,', Object.keys(uvOut).length, 'hulls');

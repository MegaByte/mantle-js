// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbBoundDecidedSmoke — a ring's half-plane bound is DECIDED before it is computed.
//
// The kernel bounds every curve band fragment by the pixel box's share of the half-planes its arc lies in (a quad band's two
// end tangents, a klm ring's support), and every Bezout crescent by its keep plane. Computing those shares in full
// for every fragment -- two normalizations and, for a convex quad band, the two-plane clip -- is mostly waste: on
// most fragments the box lies wholly inside the planes and the share is exactly 1, and the bound is a large share of
// a curve band fragment's float operations. So the helpers read g against the box's reach, (|d.x| + |d.y|) / 2 em,
// first: wholly inside is 1, wholly outside 0, one plane cutting is its one-plane share, and the clip runs only where
// both planes cut the box.
//
// Checked on the shader text, through the whole-pipeline emulator: the shipped text against the same text with the
// helpers computing every share in full, fragment for fragment (the answers agree), and the float operations the curve band
// and the Bezout crescent spend (the decided form spends fewer).
import { readFileSync } from 'fs';

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const P = await import('./_lbPipeEmu.mjs');
if (!P.hasLbPipeEmu()) {
  console.log('lbBoundDecidedSmoke: SKIP (no C++ compiler / clang for the pipeline emulator)');
  process.exit(0);
}
const { lbScene, renderScene } = await import('./_lbPipeScene.mjs');

const ROOT = new URL('..', import.meta.url);
const vt = readFileSync(new URL('src/shaders/generated/mantle.vert.glsl', ROOT), 'utf8');
const ft = readFileSync(new URL('src/shaders/generated/mantle.frag.glsl', ROOT), 'utf8');

// The undecided helpers: every share computed in full.
const FULL = `float lbHalfPlaneBoxCov(vec2 n, float c, vec2 emx, vec2 emy) {
  vec2 d = vec2(dot(n, emx), dot(n, emy));
  float L = length(d), g = dot(n, vEm) - c;
  return L > 0.0 ? exactBoxCov(d / L, -g / L) : (g <= 0.0 ? 1.0 : 0.0);
}
float lbHalfPlanesBoxCov2(vec2 n1, float c1, vec2 n2, float c2, vec2 emx, vec2 emy) {
  vec2 d1 = vec2(dot(n1, emx), dot(n1, emy)), d2 = vec2(dot(n2, emx), dot(n2, emy));
  float L1 = length(d1), L2 = length(d2);
  if (!(L1 > 0.0) || !(L2 > 0.0)) return min(lbHalfPlaneBoxCov(n1, c1, emx, emy), lbHalfPlaneBoxCov(n2, c2, emx, emy));
  return exactBoxCov2(d1 / L1, -(dot(n1, vEm) - c1) / L1, d2 / L2, -(dot(n2, vEm) - c2) / L2);
}
`;
const a = ft.indexOf('float lbHalfPlaneBoxCov('),
  b = ft.indexOf('float lbHalfPlanesBoxCov2('),
  e = b < 0 ? -1 : ft.indexOf('\n}\n', b);
const decided =
  a >= 0 &&
  e > 0 &&
  /if \(g <= -s\) return 1\.0;/.test(ft.slice(a, b)) &&
  /bool in1 = g1 <= -s1, in2 = g2 <= -s2;/.test(ft.slice(b, e));
ok(
  decided,
  'lbHalfPlaneBoxCov and lbHalfPlanesBoxCov2 decide a box wholly inside or outside before they normalize',
);
if (!decided) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
const ftFull = ft.slice(0, a) + FULL + ft.slice(e + 3);

// Quadratic arcs (curve bands with end-tangent bounds) and cubics (klm rings, Bezout crescents), filled.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><path fill="#000" d="M20 80 Q40 20 80 22 Q128 26 140 78 Q126 138 80 140 Q30 136 20 80 Z M60 80 Q80 60 100 80 Q80 100 60 80 Z"/><path fill="#000" d="M10 150 C40 110 70 170 100 130 S150 120 150 150 Z"/></svg>`;
const sc = await lbScene(SVG, { N: 160 });
const A = renderScene(sc, vt, ft, [], { alu: true }),
  B = renderScene(sc, vt, ftFull, [], { alu: true });
const n = A.recs.length / 9;
ok(n === B.recs.length / 9 && n > 3000, `the two texts rasterize the same ${n} fragments`);
const kOut = A.vert.outOff[A.vert.io.outs.findIndex((o) => o.name === 'vKind')];
let worst = 0,
  discDiff = 0;
const cost = { 4: [0, 0, 0], 12: [0, 0, 0] };
for (let q = 0; q < n; q++) {
  const dA = A.recs[q * 9 + 7] === 1,
    dB = B.recs[q * 9 + 7] === 1;
  if (dA !== dB) discDiff++;
  else if (!dA) worst = Math.max(worst, Math.abs(A.recs[q * 9 + 6] - B.recs[q * 9 + 6]));
  const t = A.recs[q * 9] | 0,
    k = Math.round(A.vOut[(t * 3 + 2) * A.vert.outN + kOut]);
  if (cost[k]) {
    const eq = (f) => (f % 65536) + 4 * Math.floor(f / 65536);
    cost[k][0]++;
    cost[k][1] += eq(A.recs[q * 9 + 8]);
    cost[k][2] += eq(B.recs[q * 9 + 8]);
  }
}
ok(
  discDiff === 0 && worst * 255 <= 1,
  `every fragment answers as it did: ${discDiff} discard differently, worst ${(worst * 255).toFixed(3)}/255`,
);
for (const [k, name] of [
  [12, 'curve band'],
  [4, 'Bezout crescent'],
]) {
  const [m, eA, eB] = cost[k];
  ok(
    m > 100 && eA < 0.95 * eB,
    `${name}: ${m} fragments, ${(eB / m).toFixed(1)} -> ${(eA / m).toFixed(1)} float operations each (alu + 4 transcendental)`,
  );
}
console.log(fail ? `\n${fail} FAILED` : '\nlbBoundDecidedSmoke: all passed');
process.exit(fail ? 1 : 0);

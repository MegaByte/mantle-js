// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// vertexReachScaleSmoke — two vertex stages size their geometry the same at any scale.
//
// THE HAZARD: absolute em epsilons in code that sizes the geometry a fragment may draw in.
// (1) A split-stroke quad (_strokeVertexSetup.glsl) that sizes a miter join's reach from the segment's end HANDLE, and
//     calls it no direction -- the worst-case reach -- under an absolute 1e-6 em (or floors strokeNrm at 1e-9 em), gives
//     every segment under about a unit the worst case at 2^-20 (a 0.8-unit cubic's quad 4.4x its scale-1 area); at 2^20
//     a handle a hair of its span, which the fragment stage replaces by the chord (strokeQuadAccum's 1e-9 of the span),
//     sizes a sharp miter from its own direction, and painted fragments fall outside the quad.
// (2) An emPerPxFor (_emPerPx.glsl, the LB and CPatch vertex stages' em per device pixel along a direction) that calls a
//     direction under an absolute 1e-9 em none, and floors the world matrix's stretch at 1e-4, gives a small shape's
//     offsets the conformal answer under an anisotropic matrix at 2^-20, and dilates a world zoom-out past 1e-4 by up to
//     250x too little.
// The vertex stage takes the fragment stage's end directions (the handle, else the next, else the chord, each over
// 1e-9 of the span; an arc's velocity, a zero-radius arc's chord), and emPerPxFor tests for zero and floors against a
// singular matrix only.
//
// (a) the split-stroke pass, both stages from their shipped text (test/_glslEmu.mjs buildSplitStrokeEmu): a joined
//     line, short line, quad, quad with a hair of a start handle, cubic and short cubic, a sharp miter at the start, at
//     2^-20, 1 and 2^20: no painted fragment outside the quad, and the quad the same at every scale (corners over S);
// (b) emPerPxFor from the shipped mantle.vert.glsl, compiled to float32: the drawing scaled by S (direction and em per
//     plane pixel) answers S times the scale-1 answer, and the world matrix scaled by S answers 1/S times -- conformal,
//     anisotropic and skewed, directions from 1 to 1e-5, S from 2^-20 to 2^20;
// (c) each absolute epsilon restored is caught.
import path from 'path';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { encodeSeg, makeTexelBuffer } from '../src/svg/textures.js';
import { mkLine, mkQuad, mkCubic } from '../src/svg/segment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler');
  process.exit(0);
}
const f = Math.fround;
const VERT = readFileSync(path.join(ROOT, 'src/shaders/generated/splitStroke.vert.glsl'), 'utf8');
const MVERT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');

// ---- (a) the split-stroke quad ----------------------------------------------------------------------------------------
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const inQuad = (Q, p, tol) => {
  const s = [0, 1, 2, 3].map(
    (i) =>
      cross(Q[i], Q[(i + 1) & 3], p) /
      Math.hypot(Q[(i + 1) & 3][0] - Q[i][0], Q[(i + 1) & 3][1] - Q[i][1]),
  );
  return s.every((v) => v >= -tol) || s.every((v) => v <= tol);
};
const IN = (() => {
  const t = [-0.7778, 0.6285],
    l = Math.hypot(...t);
  return [t[0] / l, t[1] / l];
})(); // a sharp miter, 3 half-widths
const CASES = [
  ['line', (S) => mkLine([0, 0], [10 * S, 0])],
  ['line 0.5 long', (S) => mkLine([0, 0], [0.5 * S, 0])],
  ['quad', (S) => mkQuad([0, 0], [3 * S, 2 * S], [10 * S, 0])],
  ['quad, start handle 1e-9 of its span', (S) => mkQuad([0, 0], [0, 1e-8 * S], [10 * S, 0])],
  ['cubic', (S) => mkCubic([0, 0], [3 * S, 2 * S], [7 * S, -2 * S], [10 * S, 0])],
  [
    'cubic 0.8 long',
    (S) => mkCubic([0, 0], [0.2 * S, 0.15 * S], [0.6 * S, -0.1 * S], [0.8 * S, 0]),
  ],
];
function quadScan(vert) {
  const emu = EMU.buildSplitStrokeEmu(ROOT, { vert });
  const res = [];
  for (const [name, mk] of CASES) {
    const per = [];
    for (const S of [2 ** -20, 1, 2 ** 20]) {
      const buf = makeTexelBuffer(),
        base = encodeSeg(mk(S), buf, false, true, IN, [0, 0], 0);
      const prim = new Float32Array(buf.floats.subarray(0, buf.count * 4));
      const view = {
        bbox: [-20 * S, -20 * S, 40 * S, 40 * S],
        canvasAR: [1, 1],
        viewport: [400, 400],
        worldM: null,
      };
      const st = { halfW: S, cap: 0, join: 0, miterLimit: 4 };
      const cq = [];
      for (let m = 1; m <= 8; m++)
        cq.push({ base, c: [0, 0], ePx: [0.1 * S, 0.1 * S], ...st, corner: m });
      const o = emu.run(prim, cq, view),
        Q = [
          [o[0], o[1]],
          [o[2], o[3]],
          [o[4], o[5]],
          [o[6], o[7]],
        ];
      const qs = [];
      for (let y = -6; y < 6; y += 0.05)
        for (let x = -6; x < 14; x += 0.05)
          qs.push({
            base,
            c: [f((x + 0.013) * S), f((y + 0.017) * S)],
            ePx: [0.1 * S, 0.1 * S],
            ...st,
          });
      const cov = emu.run(prim, qs, view);
      let n = 0,
        out = 0;
      cov.forEach((v, i) => {
        if (v > 0) {
          n++;
          if (!inQuad(Q, qs[i].c, 1e-3 * S)) out++;
        }
      });
      per.push({ S, n, out, Q: Q.map((p) => p.map((v) => v / S)) });
    }
    const q1 = per[1].Q,
      spread = Math.max(
        ...per.flatMap((r) => r.Q.flatMap((p, i) => p.map((v, j) => Math.abs(v - q1[i][j])))),
      );
    res.push({
      name,
      out: per.reduce((a, r) => a + r.out, 0),
      n: per.reduce((a, r) => a + r.n, 0),
      spread,
      outAt: per.filter((r) => r.out).map((r) => `2^${Math.log2(r.S)}`),
    });
  }
  return res;
}
for (const r of quadScan(VERT))
  ok(
    r.out === 0 && r.n > 3000 && r.spread <= 1e-4,
    `(a) ${r.name}, sharp miter: ${r.out} of ${r.n} painted fragments outside the quad at 2^-20, 1, 2^20; its corners over S differ by ${r.spread.toExponential(1)} across the scales`,
  );

// ---- (b) emPerPxFor ---------------------------------------------------------------------------------------------------
const CACHE = path.join(ROOT, 'node_modules/.cache/glslEmu');
function eppEmu(text) {
  const body = EMU.glslToCpp(
    text.replace(/^uniform mat3 uWorldM;$/m, '').replace(/^uniform int uHasWorldM;$/m, ''),
    ['emPerPxFor'],
  );
  const src = `#define MANTLE_LB_FILL 1
${EMU.vecHeader()}
#include <cstdio>
namespace glsl {
struct mat3 { vec3 c[3]; vec3& operator[](int i) { return c[i]; } const vec3& operator[](int i) const { return c[i]; } };
mat3 uWorldM; int uHasWorldM = 0;
${body}
}
using namespace glsl;
int main() { float q[8]; while (fread(q, 4, 8, stdin) == 8) { uHasWorldM = 1;
  uWorldM.c[0] = vec3(q[3], q[4], 0.0f); uWorldM.c[1] = vec3(q[5], q[6], 0.0f); uWorldM.c[2] = vec3(0.0f, 0.0f, 1.0f);
  float r = emPerPxFor(vec2(q[0], q[1]), q[2]); fwrite(&r, 4, 1, stdout); } return 0; }
`;
  mkdirSync(CACHE, { recursive: true });
  const exe = path.join(CACHE, `epp_${process.pid}_${Math.random().toString(36).slice(2)}`);
  writeFileSync(exe + '.cpp', src);
  const c = spawnSync(
    EMU.cxx(),
    ['-std=c++17', '-O1', '-ffp-contract=off', '-w', '-o', exe, exe + '.cpp'],
    { encoding: 'utf8' },
  );
  rmSync(exe + '.cpp', { force: true });
  if (c.status)
    throw new Error(
      'vertexReachScaleSmoke: emPerPxFor did not compile\n' + c.stderr.slice(0, 1500),
    );
  return {
    run(qs) {
      const b = new Float32Array(qs.length * 8);
      qs.forEach((q, i) => b.set(q, i * 8));
      const r = spawnSync(exe, [], { input: Buffer.from(b.buffer) });
      return new Float32Array(
        r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + qs.length * 4),
      );
    },
    done() {
      rmSync(exe, { force: true });
    },
  };
}
function eppScan(text) {
  const E = eppEmu(text);
  const Ms = {
    conformal: [0.8, 0.6, -0.6, 0.8],
    anisotropic: [2, 0, 0.5, 0.25],
    skewed: [1, 0.4, 0, 1],
  };
  let n = 0,
    bad = 0,
    worst = 0;
  const where = new Set();
  for (const [mn, M] of Object.entries(Ms))
    for (const d of [
      [1, 0],
      [0.3, 0.7],
      [1e-3, 2e-3],
      [0, 1e-5],
      [-2e-4, 1e-4],
    ]) {
      const base = 0.05,
        ref = E.run([[d[0], d[1], base, ...M]])[0];
      for (const e of [-20, -10, 10, 20]) {
        const S = 2 ** e;
        const a = E.run([[f(d[0] * S), f(d[1] * S), f(base * S), ...M]])[0] / S; // the drawing by S
        const b = E.run([[d[0], d[1], base, ...M.map((v) => f(v * S))]])[0] * S; // the world matrix by S
        for (const [k, v] of [
          ['drawing', a],
          ['world', b],
        ]) {
          n++;
          const rel = Math.abs(v - ref) / ref;
          if (!(rel < 1e-5)) {
            bad++;
            worst = Math.max(worst, rel);
            where.add(`${k} ${mn}`);
          }
        }
      }
    }
  E.done();
  return { n, bad, worst, where: [...where] };
}
{
  const r = eppScan(MVERT);
  ok(
    r.bad === 0 && r.n === 120,
    `(b) emPerPxFor: ${r.bad} of ${r.n} answers not the scale-1 answer scaled${r.bad ? ` (worst ${r.worst.toPrecision(3)}: ${r.where.join(', ')})` : ''}`,
  );
}

// ---- (c) mutations ----------------------------------------------------------------------------------------------------
{
  const hinge = (text, from, to, label) => {
    if (text.split(from).length !== 2) {
      ok(false, `(c) ${label}: the hinge is not in the shipped text exactly once`);
      return null;
    }
    return text.replace(from, to);
  };
  const v1 = hinge(
    VERT,
    'if (!(length(dS) > dirMin)) mS = worst;',
    'if (length(dS) < 1e-6) mS = worst;',
    "the start direction's absolute 1e-6",
  );
  const v2a =
    v1 &&
    hinge(
      v1,
      'if (!(length(dS) > dirMin)) dS = P2 - P1;',
      'if (false) dS = P2 - P1;',
      "the start direction's fallback",
    );
  const v2 =
    v2a &&
    hinge(
      v2a,
      'if (!(length(dS) > dirMin)) dS = P3 - P0;',
      'if (false) dS = P3 - P0;',
      "the start direction's chord",
    );
  if (v2) {
    const r = quadScan(v2),
      moved = r
        .filter((x) => x.out > 0 || x.spread > 1e-4)
        .map((x) => `${x.name}${x.out ? ` (${x.out} outside at ${x.outAt.join(' ')})` : ''}`);
    ok(
      moved.length >= 3 && r.some((x) => x.out > 0),
      `(c) the split-stroke reach's old start rule restored is caught: ${moved.join('; ')}`,
    );
  }
  for (const [label, from, to] of [
    ["emPerPxFor's absolute 1e-9 on a direction", 'if (!(dm > 0.0) ||', 'if (dm < 1e-9 ||'],
    [
      "emPerPxFor's 1e-4 floor on the stretch",
      'return basePx / max(l0, 1e-30);',
      'return basePx / max(l0, 1e-4);',
    ],
  ]) {
    const t = hinge(MVERT, from, to, label);
    if (!t) continue;
    const r = eppScan(t);
    ok(
      r.bad > 0,
      `(c) ${label} restored is caught: ${r.bad} of ${r.n} answers move (${r.where.join(', ')})`,
    );
  }
}
console.log(fail ? `VERTEX-REACH-SCALE FAIL (${fail})` : 'VERTEX-REACH-SCALE PASS');
process.exit(fail ? 1 : 0);

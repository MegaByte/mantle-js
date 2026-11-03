// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Compile the actual generated vertex helper, rather than a JS copy of it.
// An equivalent homogeneous projection must dilate the same cover at every
// document scale. Exact zero/canceled projections must stay finite.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildVert, runVert } from './_lbPipeEmu.mjs';

const vertex = readFileSync(
  new URL('../src/shaders/generated/mantle.vert.glsl', import.meta.url),
  'utf8',
);
const begin = vertex.indexOf('vec2 coverQuadDilate(');
assert(begin >= 0);
const brace = vertex.indexOf('{', begin);
let end = brace + 1,
  depth = 1;
while (depth && end < vertex.length) {
  if (vertex[end] === '{') depth++;
  if (vertex[end] === '}') depth--;
  end++;
}
assert.equal(depth, 0);
const helper = vertex.slice(begin, end);
const wrap = (text) => `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec2 aNormal;
uniform vec4 uRow0;
uniform vec4 uRow1;
uniform vec4 uRow3;
uniform vec2 uViewport;
uniform int uCoverAaReach;
${text}
void main() {
  gl_Position = vec4(coverQuadDilate(aPosition, aNormal,
      uRow0, uRow1, uRow3, uViewport), 0.0, 1.0);
}`;
const attr = new Float32Array(64);
const invoke = (program, rows, p, n, reach, homogeneous = 1) => {
  attr.set(p, 0);
  attr.set(n, 4);
  const uniforms = new Map([
    ['uRow0', rows[0].map((x) => x * homogeneous)],
    ['uRow1', rows[1].map((x) => x * homogeneous)],
    ['uRow3', rows[2].map((x) => x * homogeneous)],
    ['uViewport', [64, 64]],
    ['uCoverAaReach', reach],
  ]);
  return Array.from(runVert(program, [], uniforms, attr, 1).slice(0, 2));
};
const close = (actual, expected, label) => {
  actual.forEach((x, i) => {
    assert(Number.isFinite(x), `${label}: non-finite displacement`);
    assert(
      Math.abs(x - expected[i]) <= 4e-6 * Math.max(1, Math.abs(expected[i])),
      `${label}: ${actual} versus ${expected}`,
    );
  });
};
let cases = 0;
for (const contract of [false, true]) {
  const program = buildVert(wrap(helper), [], { contract });
  for (const reach of [0, 1]) {
    for (const scale of [2 ** -20, 1, 2 ** 20]) {
      const rows = [
        [2 / (128 * scale), 0, 0, -1],
        [0, -2 / (128 * scale), 0, 1],
        [0, 0, 0, 1],
      ];
      const p = [32.25 * scale, 27.375 * scale];
      const d = invoke(program, rows, p, [1, -1], reach);
      close(
        d.map((x) => x / (2 * scale)),
        [0.5, -0.5],
        `affine ${scale}, fma=${contract}`,
      );
      cases++;
    }
    for (const p of [
      [0, 0],
      [0.4, -0.3],
      [-0.7, 0.8],
    ]) {
      for (const n of [
        [1, 0],
        [1, 1],
        [-1, 1],
      ]) {
        const rows = [
          [0.014, -0.003, 0, -0.8],
          [0.002, -0.013, 0, 0.9],
          [0.02, -0.015, 0, 1],
        ];
        const reference = invoke(program, rows, p, n, reach);
        assert(
          reference.some((x) => Math.abs(x) > 0.01),
          'non-vacuous projective displacement',
        );
        for (const h of [2 ** -20, 2 ** 20]) {
          close(
            invoke(program, rows, p, n, reach, h),
            reference,
            `projective homogeneous ${h}, fma=${contract}`,
          );
          cases++;
        }
      }
    }
    for (const rows of [
      [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 1],
      ],
      [
        [1 / 64, 0, 0, 0],
        [0, 0, 0, 0],
        [1, 0, 0, 1],
      ],
    ]) {
      for (const h of [2 ** -20, 1, 2 ** 20]) {
        close(
          invoke(program, rows, [0, 0], [1, 0], reach, h),
          [0, 0],
          `singular ${h}, fma=${contract}`,
        );
        cases++;
      }
    }
  }
  // Negative control from the absolute-guard defect: a valid affine projection
  // cannot lose its AA cover merely because its document units are large.
  const old = helper.replace(
    /if \(abs\(denom\) <= [^;]+;/,
    'if (abs(denom) < 1e-12) return vec2(0.0);',
  );
  assert.notEqual(old, helper);
  const oldProgram = buildVert(wrap(old), [], { contract });
  const scale = 2 ** 20;
  const rows = [
    [2 / (128 * scale), 0, 0, -1],
    [0, -2 / (128 * scale), 0, 1],
    [0, 0, 0, 1],
  ];
  assert.deepEqual(invoke(oldProgram, rows, [32.25 * scale, 27.375 * scale], [1, -1], 0), [0, 0]);
}
console.log(
  `coverProjectionScaleSmoke PASS (${cases} actual vertex cases, fused/unfused, historical negative control)`,
);

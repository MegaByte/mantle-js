// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeEdgeCovScaleSmoke — the band-walk stroke's edge coverage is the same at every drawing size, and at scale 1 it
// is exactly the floored inline coverage it replaces.
//
// THE HAZARD. The coverage every band-walk stroke takes -- mantle.frag.glsl's main pass, its pattern and mask
// children, and maskBake.frag.glsl -- divided by max(pxSize, 1e-6) floors the pixel at an em length. Art whose pixel
// is under 1e-6 em (2^-20 art at a few pixels to the unit) would have every RAMP widened to 1e-6 em, so a cap or join
// edge, and every edge of a child or a mask stroke, would come out nearly flat, while the unfloored exact-area edge (a
// body with a normal) stays right beside it.
//
// The coverage is one function, _coverage.glsl strokeEdgeCov, which the four sites call, and its guard is for a
// zero derivative only (1e-30, mantle.frag.glsl's invPx guard). It is the SHIPPED text in float32 here
// (test/_glslEmu.mjs K_STROKE_EDGE).
//
// (a) THE PROPERTY: scaling the distance, the half-width and the pixel by 2^k is exact in float32 and the coverage is
//     dimensionless, so with no length in a constant it is BIT FOR BIT the same at 2^-20 and 2^20 as at scale 1 --
//     over hairlines to wide strokes, isotropic and anisotropic pixels, the ramp and the exact-area edge;
// (b) THE FUNCTION CHANGES nothing AT SCALE 1: the floored inline statements, quoted below (the main pass's; the
//     children's are the same ramp with the exact-area arm off), compiled in place of the function body, give
//     bit-identical coverage at scale 1 on every input -- and fail (a) at 2^-20.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const f = Math.fround;
const lg = (S) => `2^${Math.round(Math.log2(S))}`;
if (!EMU.hasCxx() || EMU.K_STROKE_EDGE === undefined) {
  console.log(
    EMU.K_STROKE_EDGE === undefined
      ? '  FAIL: test/_glslEmu.mjs has no K_STROKE_EDGE'
      : '  SKIPPED: no C++ compiler',
  );
  process.exit(EMU.K_STROKE_EDGE === undefined ? 1 : 0);
}

// The floored inline stroke coverage of the main pass, verbatim but for its names:
// strokeGrad -> grad, uStrokeExactAa != 0 -> exactAa, and a return.
const PRE_FIX_BODY = `{
    float pxSize = 0.5 * (ePx.x + ePx.y);
    float halfWMin = 0.5 * pxSize;
    float halfWVis = max(halfW, halfWMin);
    float weightFade = halfW / halfWVis;
    float distFromEdge = minD - halfWVis;
    float strokeCov = 0.0;
    if (exactAa && dot(grad, grad) > 0.5
        && distFromEdge <= 0.75 * pxSize) {
      vec2 nUn = grad * ePx;
      float il = inversesqrt(max(dot(nUn, nUn), 1e-30));
      strokeCov = exactBoxCov(nUn * il, -distFromEdge * il) * weightFade;
    } else
    if (distFromEdge <= 0.5 * pxSize) {
      strokeCov = clamp(0.5 - distFromEdge / max(pxSize, 1e-6), 0.0, 1.0) * weightFade;
    }
    return strokeCov;
}`;
/// The shipped text with strokeEdgeCov's body replaced.
function withBody(glsl, body) {
  const at = glsl.indexOf('float strokeEdgeCov(');
  if (at < 0) throw new Error('strokeEdgeCov is not in the shipped text');
  const open = glsl.indexOf('{', at);
  let d = 0,
    close = -1;
  for (let k = open; k < glsl.length; k++) {
    if (glsl[k] === '{') d++;
    else if (glsl[k] === '}' && --d === 0) {
      close = k;
      break;
    }
  }
  return glsl.slice(0, open) + body + glsl.slice(close + 1);
}

/// The input sweep at scale 1, every value a float32: pixel p = 2^-6 em (so 2^-26 at 2^-20, under the 1e-6 floor).
function sweep(S) {
  const p = 2 ** -6,
    qs = [];
  for (const hwPx of [0.1, 0.3, 0.5, 0.75, 1, 3, 10])
    for (let k = -24; k <= 24; k++)
      for (const [ax, ay] of [
        [1, 1],
        [1, 0.7],
        [0.6, 1.3],
      ])
        for (const g of [
          [0, 0],
          [1, 0],
          [0.6, 0.8],
          [-0.28, 0.96],
        ])
          for (const aa of [0, 1]) {
            const halfW = f(hwPx * p),
              minD = f(Math.max(0, hwPx + k * 0.1) * p);
            qs.push({
              k: EMU.K_STROKE_EDGE,
              bb: [minD * S, halfW * S, f(g[0]), f(g[1])],
              ePx: [f(ax * p) * S, f(ay * p) * S],
              GD: [aa, 0, 0, 0],
            });
          }
  return qs;
}
function compare(emu, S) {
  const one = emu.run(new Float32Array(4), new Float32Array(4), sweep(1)),
    at = emu.run(new Float32Array(4), new Float32Array(4), sweep(S));
  let bad = 0,
    first = '';
  for (let i = 0; i < one.length; i++)
    if (at[i] !== one[i]) {
      bad++;
      if (!first) first = `${at[i].toFixed(4)} for ${one[i].toFixed(4)}`;
    }
  return { n: one.length, bad, first };
}

const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const emu = EMU.buildGlslEmu(ROOT, { stroke: true });
for (const S of [2 ** -20, 2 ** 20]) {
  const r = compare(emu, S);
  ok(
    r.bad === 0,
    `(a) at ${lg(S)}: ${r.bad} of ${r.n} coverages differ from scale 1's${r.first ? ' -- first ' + r.first : ''}`,
  );
}
{
  const pre = EMU.buildGlslEmu(ROOT, { stroke: true, glsl: withBody(GLSL, PRE_FIX_BODY) });
  const a = pre.run(new Float32Array(4), new Float32Array(4), sweep(1)),
    b = emu.run(new Float32Array(4), new Float32Array(4), sweep(1));
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  ok(
    same === a.length,
    `(b) at scale 1 the function and the floored inline statements agree bit for bit on ${same} of ${a.length} inputs`,
  );
  const r = compare(pre, 2 ** -20);
  ok(
    r.bad > 0,
    `(b) and the floored statements fail (a) at 2^-20: ${r.bad} of ${r.n} coverages move${r.first ? ' -- first ' + r.first : ''}`,
  );
}
// every site calls it: no ramp is computed inline. The INVARIANT is the absence of an inline ramp; the number of call
// sites is incidental and only has a floor (mantle.frag had four: three, and the records-off alternative of the stroke's coverage
// line, `#else` of MANTLE_STROKE_EXACT; the pattern-child walk added a fifth, and a new caller is fine as long as it calls).
for (const file of ['mantle.frag.glsl', 'maskBake.frag.glsl']) {
  const src = readFileSync(path.join(ROOT, 'src/shaders', file), 'utf8').replace(/\/\/[^\n]*/g, '');
  const calls = (src.match(/strokeEdgeCov\(/g) || []).length,
    inline = /max\(pxSize, 1e-6\)/.test(src);
  ok(
    !inline && calls >= (file === 'mantle.frag.glsl' ? 4 : 1),
    `(c) ${file}: ${calls} strokeEdgeCov call(s), ${inline ? 'an inline 1e-6 ramp left' : 'no inline ramp'}`,
  );
}

console.log(fail ? `STROKE-EDGE-COV-SCALE FAIL (${fail})` : 'STROKE-EDGE-COV-SCALE PASS');
process.exit(fail ? 1 : 0);

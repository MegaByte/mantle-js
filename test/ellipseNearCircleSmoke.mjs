// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// ellipseNearCircleSmoke — _arcMath.glsl distToEllipse is float32-accurate for every pair of radii, a circle, radii one
// ulp apart and every anisotropy between.
//
// THE TRAP. Taking a circle only when l = b^2 - a^2 is under a relative 1e-9 -- below float32's resolution, so in
// effect only when the radii are equal -- and otherwise running Inigo Quilez's closed-form quartic, which divides by l
// and cubes the quotient, loses ~(ulp / (1 - a/b))^2 of the radius in float32: 2.2e-5 r for radii 1e-4 apart, 9.6e-2 r
// at 1e-6, 0.98 r and NaN at one ulp. Radii that close are what a circle becomes under any rounding -- a stroke-space
// frame's image of a circle, an arc rebuilt by a transform, a near-circle drawn on purpose.
//
// THE RULE: a circle when the squared radii are the same float; radii within 2^-6 of each other take the near-circle foot
// (Eberly's robust method: a monotone function of one variable, its root isolated by construction and bisected to
// adjacent floats), where no step divides by l; the closed form only from 2^-6 apart, where it is float32-accurate
// (it loses 222 ulps just outside the curve at 2^-9). Two more: a zero coordinate takes +, not sign()'s 0, which would
// put the foot of a circle's exact CENTER on the center (distance 0), and the circle's foot is normalized in its own
// units. A stroke-space frame needs no snap of its singular values for this (test/strokeLocalFrameSmoke.mjs).
//
// (a) radii apart by 0, 1, 2 and 8 ulps and 1e-6 .. 0.3 of the radius, at radius scales 2^-20, 1, 37.3 and 2^20, 64
//     directions and nine radial distances (the center to 10 r), plus points exactly ON either axis: the distance is
//     within 8 * 2^-24 * (r + |p|) of the float64 truth, the foot is on the ellipse, and no answer is NaN;
// (b) against the unguarded function (the 1e-9 circle test, else the closed form), quoted verbatim: it fails (a) at every
//     gap below 2^-6 and at a circle's center;
//     from 2^-6 apart the answers are bit-identical wherever the point has no zero coordinate, and on a circle they
//     move by at most two float32 roundings.
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
if (!EMU.hasCxx() || EMU.K_ELLIPSE_DIST === undefined) {
  console.log(
    EMU.K_ELLIPSE_DIST === undefined
      ? '  FAIL: test/_glslEmu.mjs has no K_ELLIPSE_DIST'
      : '  SKIPPED: no C++ compiler',
  );
  process.exit(EMU.K_ELLIPSE_DIST === undefined ? 1 : 0);
}

/// The float64 truth: the global minimum of |E(t) - p| over a dense sweep, polished by Newton on the angle.
function exact(a, b, px, py) {
  let best = Infinity,
    bt = 0;
  for (let i = 0; i < 4096; i++) {
    const t = (2 * Math.PI * i) / 4096;
    const d = Math.hypot(a * Math.cos(t) - px, b * Math.sin(t) - py);
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  let t = bt;
  for (let k = 0; k < 60; k++) {
    const c = Math.cos(t),
      s = Math.sin(t),
      x = a * c - px,
      y = b * s - py;
    const g = -x * a * s + y * b * c,
      h = a * a * s * s + b * b * c * c - x * a * c - y * b * s;
    if (!(h > 0)) break;
    const tn = t - g / h;
    if (tn === t) break;
    t = tn;
  }
  return Math.min(best, Math.hypot(a * Math.cos(t) - px, b * Math.sin(t) - py));
}
const ULP = 2 ** -23;
const EDGE = 2 ** -6; // where the near-circle foot hands over to the closed form
const GAPS = [
  ['circle', 0],
  ['1 ulp', 1 * ULP],
  ['2 ulps', 2 * ULP],
  ['8 ulps', 8 * ULP],
  ['1e-6', 1e-6],
  ['1e-5', 1e-5],
  ['1e-4', 1e-4],
  ['1e-3', 1e-3],
  ['2^-9', 2 ** -9],
  ['2^-6 - 1e-4', EDGE - 1e-4],
  ['2^-6 + 1e-4', EDGE + 1e-4],
  ['0.1', 0.1],
  ['0.3', 0.3],
];
function cases(gap) {
  const qs = [],
    ref = [];
  for (const r of [2 ** -20, 1, 37.3, 2 ** 20])
    for (const flip of [false, true]) {
      const a = f(r),
        b = gap === 0 ? a : f(r * (1 + gap));
      const [rx, ry] = flip ? [b, a] : [a, b];
      const pts = [];
      for (let i = 0; i < 64; i++)
        for (const s of [0, 1e-3, 0.3, 0.97, 0.999, 1.001, 1.03, 3, 10]) {
          const t = (2 * Math.PI * (i + 0.37)) / 64;
          pts.push([f(s * r * Math.cos(t)), f(s * r * Math.sin(t))]);
        }
      for (const s of [0, 1e-3, 0.5, 1, 2])
        pts.push([f(s * r), 0], [0, f(s * r)], [f(-s * r), 0], [0, f(-s * r)]);
      for (const [px, py] of pts) {
        for (const which of [0, 1, 2])
          qs.push({ k: EMU.K_ELLIPSE_DIST, bb: [rx, ry, px, py], GD: [which, 0, 0, 0] });
        ref.push({
          d: exact(rx, ry, px, py),
          rx,
          ry,
          px,
          py,
          tol: 8 * 2 ** -24 * (r + Math.hypot(px, py)),
        });
      }
    }
  return { qs, ref };
}
function score(emu, gap) {
  const { qs, ref } = cases(gap);
  const out = emu.run(new Float32Array(4), new Float32Array(4), qs);
  let bad = 0,
    nan = 0,
    offEllipse = 0,
    worst = 0,
    first = '';
  for (let i = 0; i < ref.length; i++) {
    const d = out[3 * i],
      fx = out[3 * i + 1],
      fy = out[3 * i + 2],
      R = ref[i];
    if (!Number.isFinite(d) || !Number.isFinite(fx) || !Number.isFinite(fy)) {
      nan++;
      bad++;
      continue;
    }
    const e = Math.abs(d - R.d);
    worst = Math.max(worst, e / (R.tol / 8));
    if (e > R.tol) {
      bad++;
      if (!first) first = `r ${R.rx}/${R.ry} at (${R.px}, ${R.py}): ${d} for ${R.d}`;
    }
    if (Math.abs((fx / R.rx) ** 2 + (fy / R.ry) ** 2 - 1) > 1e-6) offEllipse++;
  }
  return { n: ref.length, bad, nan, offEllipse, worst, first, out };
}

const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const emu = EMU.buildGlslEmu(ROOT, { stroke: true });
const now = new Map();
for (const [name, gap] of GAPS) {
  const s = score(emu, gap);
  now.set(name, s);
  ok(
    s.bad === 0 && s.offEllipse === 0,
    `(a) radii ${name} apart: ${s.bad} of ${s.n} distances off the float64 truth by more than 8 * 2^-24 (r + |p|) (${s.nan} NaN; worst ${s.worst.toFixed(2)} * 2^-24 (r + |p|)), ${s.offEllipse} feet off the ellipse${s.first ? ' -- first ' + s.first : ''}`,
  );
}
// (b) the unguarded function, verbatim (as assembled)
const PRE_FIX = `float distToEllipse(vec2 ab, vec2 pIn, out vec2 foot) {
  vec2 sgn = sign(pIn);
  vec2 p = abs(pIn);
  bool swap = p.x > p.y;
  if (swap) { p = p.yx; ab = ab.yx; }
  float l = ab.y * ab.y - ab.x * ab.x;
  if (abs(l) < 1e-9 * max(ab.x * ab.x, ab.y * ab.y)) {
    vec2 fq = ab.x * normalize(p + vec2(1e-20));
    vec2 fo = swap ? fq.yx : fq.xy;
    foot = sgn * fo;
    return length(pIn - foot);
  }
  float m = ab.x * p.x / l; float m2 = m * m;
  float n = ab.y * p.y / l; float n2 = n * n;
  float c = (m2 + n2 - 1.0) / 3.0; float c3 = c * c * c;
  float q = c3 + m2 * n2 * 2.0;
  float d = c3 + m2 * n2;
  float g = m + m * n2;
  float co;
  if (d < 0.0) {
    float h = acos(clamp(q / c3, -1.0, 1.0)) / 3.0;
    float s = cos(h);
    float t = sin(h) * sqrt(3.0);
    float rx = sqrt(max(-c * (s + t + 2.0) + m2, 0.0));
    float ry = sqrt(max(-c * (s - t + 2.0) + m2, 0.0));
    co = (ry + sign(l) * rx + abs(g) / (rx * ry + 1e-20) - m) / 2.0;
  } else {
    float h = 2.0 * m * n * sqrt(d);
    float s = sign(q + h) * pow(abs(q + h), 1.0 / 3.0);
    float u = sign(q - h) * pow(abs(q - h), 1.0 / 3.0);
    float rx = -s - u - c * 4.0 + 2.0 * m2;
    float ry = (s - u) * sqrt(3.0);
    float rm = sqrt(rx * rx + ry * ry);
    co = (ry / sqrt(max(rm - rx, 1e-20)) + 2.0 * g / (rm + 1e-20) - m) / 2.0;
  }
  co = clamp(co, 0.0, 1.0);
  vec2 fq = vec2(ab.x * co, ab.y * sqrt(max(1.0 - co * co, 0.0)));
  vec2 fo = swap ? fq.yx : fq.xy;
  foot = sgn * fo;
  return length(pIn - foot);
}`;
function withFn(glsl, name, text) {
  const at = glsl.indexOf(`float ${name}(`);
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
  return glsl.slice(0, at) + text + glsl.slice(close + 1);
}
{
  const pre = EMU.buildGlslEmu(ROOT, {
    stroke: true,
    glsl: withFn(GLSL, 'distToEllipse', PRE_FIX),
  });
  const between = GAPS.filter(([, g]) => g > 0 && g < EDGE);
  // THE UNGUARDED FUNCTION'S own NaNs are not compared: built with fused multiply-adds (MANTLE_EMU_FMA=1)
  // its circle path returns NaN at a few points, which is that text's fault -- the shipped function answers every
  // one of them ((a): 0 NaN, fused or not). They are counted and named instead.
  let preFails = 0,
    closedUlps = 0,
    circleUlps = 0,
    centerWas = null,
    preNaN = 0;
  for (const [name, gap] of GAPS) {
    const s = score(pre, gap),
      a = now.get(name).out,
      { ref } = cases(gap);
    if (gap > 0 && gap < EDGE) {
      if (s.bad > 0) preFails++;
      continue;
    }
    for (let i = 0; i < ref.length; i++) {
      const zeroCoord = ref[i].px === 0 || ref[i].py === 0;
      if (zeroCoord) {
        if (gap === 0 && ref[i].px === 0 && ref[i].py === 0 && centerWas === null)
          centerWas = s.out[3 * i];
        continue;
      }
      if (!Number.isFinite(s.out[3 * i])) {
        preNaN++;
        continue;
      }
      if (gap === 0)
        circleUlps = Math.max(
          circleUlps,
          Math.abs(a[3 * i] - s.out[3 * i]) /
            (2 ** -24 * (ref[i].rx + Math.hypot(ref[i].px, ref[i].py))),
        );
      else
        closedUlps = Math.max(
          closedUlps,
          Math.abs(a[3 * i] - s.out[3 * i]) /
            (2 ** -24 * (ref[i].rx + Math.hypot(ref[i].px, ref[i].py))),
        );
    }
  }
  ok(
    preFails === between.length,
    `(b) the unguarded function fails (a) at ${preFails} of the ${between.length} gaps between a circle and 2^-6`,
  );
  ok(
    centerWas === 0,
    `(b) ...and at a circle's exact center it answered distance ${centerWas} (sign(0) puts the foot on the center); the shipped one answers the radius`,
  );
  // The closed form itself is shared: its statements, from the first one past the circle test to the end, are the
  // unguarded text verbatim. (A bitwise comparison of the two emulator builds cannot say so: the C++ compiler fuses the
  // closed form's cos(h) and sin(h) into one sincos in one build and not the other, a last-ulp difference that is the
  // emulator's, not the shader's.)
  const tail = (t) => {
    const a = t.indexOf('float m = ab.x * p.x / l;');
    return t.slice(a, t.indexOf('return length(pIn - foot);', a)).replace(/\s+/g, ' ');
  };
  const shipped = GLSL.slice(GLSL.indexOf('float distToEllipse('));
  ok(
    tail(shipped) === tail(PRE_FIX),
    '(b) from 2^-6 apart the closed form runs, and its statements are the unguarded ones verbatim',
  );
  ok(
    closedUlps <= 4 && circleUlps <= 4,
    `(b) ...its answers within ${closedUlps.toFixed(2)} * 2^-24 (r + |p|) of the unguarded build's off the axes; on a circle, within ${circleUlps.toFixed(2)} (the foot is normalized in its own units)${preNaN ? `; the unguarded build returned no number at ${preNaN} of them` : ''}`,
  );
}
console.log(fail ? `ELLIPSE-NEAR-CIRCLE FAIL (${fail})` : 'ELLIPSE-NEAR-CIRCLE PASS');
process.exit(fail ? 1 : 0);

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbKind12FloorScaleSmoke -- a curve band (kind 12) covers the same pixels whatever the drawing's size.
//
// The band's neighbor blocks (_lbCoverage.glsl, the `12` section) may carry no absolute floor, as the edge kernels carry
// none: a signed distance dpx12 and an own-arc curvature divided by max(length(grad), 1e-6) (and cubed), or a neighbor
// curvature radius floored at 1e-6 of a 1/em, which binds at 2^20 the way the gradient's binds at 2^-20. They are
// 1e-30 on the gradient (curvature from the unit normal) and no floor on the neighbor's curvature before it
// is turned into pixels (the 1e-6 per pixel left on it is a pixel count, not a length: a radius of half a million).
//
// THE CHECK is the whole-LB-pipeline emulator (vertex stage, raster, fragment), on the shipped shader text: a quadratic
// path drawn with its coordinates and viewBox multiplied by 2^-20, 1 and 2^20 must composite the same alpha, pixel for
// pixel, and the same text with absolute floors put back must NOT at the exponent that makes them bind.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasLbPipeEmu } from './_lbPipeEmu.mjs';
import { lbScene, renderScene, compositeAlpha } from './_lbPipeScene.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasLbPipeEmu()) {
  console.log('SKIP lbKind12FloorScaleSmoke: needs a C++17 compiler and clang');
  process.exit(77);
}
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};
const VT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
const FT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const OLD = FT.replace(
  'max(length(vec2(fx12, fy12)), 1e-30)',
  'max(length(vec2(fx12, fy12)), 1e-6)',
)
  .replace(
    'max(max(abs(kA12) * vEmPerPx, 1e-6), kOwnPx)',
    'max(max(abs(kA12), 1e-6) * vEmPerPx, max(kOwnPx, 1e-6))',
  )
  .replace(
    'max(max(abs(kB12) * vEmPerPx, 1e-6), kOwnPx)',
    'max(max(abs(kB12), 1e-6) * vEmPerPx, max(kOwnPx, 1e-6))',
  );
ok(OLD !== FT, 'absolute floors can be put back into the shipped text (the mutation exists)');

const N = 48;
// A quadratic blob: bands on every side, a corner (a cusp-free kink) and a thin lobe, in a 100-unit box.
const D = 'M 12 50 Q 12 12 50 12 Q 88 12 88 50 Q 88 88 50 88 Q 30 88 24 70 Q 12 80 12 50 Z';
// every number of the path and the viewBox is multiplied by the scale, so the pixel geometry is the same
const scaled = (s) => {
  const nums = D.split(' ')
    .map((t) => (/^-?[\d.]+$/.test(t) ? String(+t * s) : t))
    .join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${100 * s} ${100 * s}"><path d="${nums}" fill="#000"/></svg>`;
};
const alphaOf = async (s, FTX) => {
  const sc = await lbScene(scaled(s), { N });
  const r = renderScene(sc, VT, FTX, [], {});
  return compositeAlpha(r.recs, N);
};
const diff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const E = [-20, 0, 20];
const A = {};
for (const e of E) A[e] = await alphaOf(2 ** e, FT);
let ink = 0;
for (const v of A[0]) ink += v;
ok(ink > 500 && ink < N * N, `the drawing paints (${ink.toFixed(0)} px of ink in ${N * N})`);
for (const e of [-20, 20]) {
  const d = diff(A[0], A[e]);
  ok(
    d <= 2 / 255,
    `2^${e} composites the alpha of 2^0 to ${(d * 255).toFixed(3)}/255 (worst pixel)`,
  );
}
let worstOld = 0;
for (const e of E) {
  const o = await alphaOf(2 ** e, OLD);
  worstOld = Math.max(worstOld, diff(A[0], o));
}
ok(
  worstOld > 0.25 / 255,
  `with absolute floors put back some exponent moves a pixel by ${(worstOld * 255).toFixed(2)}/255 -- the assertion can fail`,
);
console.warn = warn;
console.log(
  fail ? `lbKind12FloorScaleSmoke FAIL (${fail})` : 'lbKind12FloorScaleSmoke: all checks passed',
);
process.exit(fail ? 1 : 0);

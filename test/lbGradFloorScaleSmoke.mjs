// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbGradFloorScaleSmoke -- the Loop-Blinn edge kernels (slugCov, curveCov, arcCov) have no absolute floor in the gradient
//.
//
// A divide by max(length(grad), 1e-6) guards a zero gradient, but with an absolute floor, and the gradient it guards
// is in em per pixel -- ~6e-7 where a drawing is scaled by 2^-20. There such a floor binds, rescaling the edge's
// distance (-f/g) and normal (grad/g) by the floor's size over the real one: a half-covered pixel reads nothing. The
// floor is 1e-30, the curvature comes from the unit normal ((Hess n.n)/|grad|, no |grad|^3 to underflow), and
// the same (f, grad, Hess) scaled by s is the same coverage -- the pixel's own geometry, whatever the drawing's size.
//
// THE CHECK is the shipped shader text in float32 (test/_glslEmu.mjs, not a second reading of it): random edges at unit
// scale, each again with f, grad and Hess multiplied by 2^-20 and 2^20 (a gradient of ~0.7 em per pixel becomes 6.7e-7
// and 7.3e5), against (1) the exact box area of the half-plane (slugCov) or the twin's kernel at unit scale, and (2) the
// same shader text with a 1e-6 floor put back, which must FAIL at 2^-20 for the two curvature kernels -- an assertion
// that cannot fail is not one. (A 1e-6 floor is benign in slugCov: it scales normal and distance alike, the same plane.)
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_SLUG_COV, K_CURVE_COV, K_ARC_COV } from './_glslEmu.mjs';
import { exactBoxCov } from '../probes/lbAccuracy/_lbBoxCov.mjs';
import { curveCov as twinCurve, arcCov as twinArc } from '../probes/lbAccuracy/_lbKernel.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

// Deterministic edge cases at unit scale: normal angle, signed distance in px, curvature per px.
let _s = 0x1badf00d;
const rnd = () => {
  _s ^= _s << 13;
  _s ^= _s >>> 17;
  _s ^= _s << 5;
  return (_s >>> 0) / 4294967296;
};
const G0 = 0.7;
const CASES = [];
for (let i = 0; i < 600; i++) {
  const th = rnd() * Math.PI * 2,
    d = (rnd() - 0.5) * 1.4,
    k = (rnd() - 0.5) * 3;
  CASES.push({ n: [Math.cos(th), Math.sin(th)], d, k });
}
// (f, fx, fy, fxx, fyy, fxy) of case c at scale s: |grad| = G0 s, f = -d |grad|, Hess = k |grad| I
const terms = (c, s) => {
  const g = G0 * s;
  return [-c.d * g, c.n[0] * g, c.n[1] * g, c.k * g, c.k * g, 0];
};

if (!hasCxx()) {
  console.log('  SKIP no C++ compiler ($CXX, clang++, g++, c++)');
} else {
  const text = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const oldText = text.replace(/max\(length\(grad\), 1e-30\)/g, 'max(length(grad), 1e-6)');
  ok(
    oldText !== text,
    'the shipped text carries the 1e-30 floor in all three kernels (' +
      (text.match(/max\(length\(grad\), 1e-30\)/g) || []).length +
      ')',
  );
  const mk = (glsl) => buildGlslEmu(ROOT, { curveCov: true, glsl });
  const NEW = mk(text),
    OLD = mk(oldText),
    EMPTY = new Float32Array(4);
  const SCALES = [2 ** -20, 1, 2 ** 20];
  const qs = [];
  for (const kind of [K_SLUG_COV, K_CURVE_COV, K_ARC_COV])
    for (const s of SCALES)
      for (const c of CASES) {
        const t = terms(c, s);
        qs.push({
          k: kind,
          GD: [0, 0, 0, 0],
          bb: [t[0], t[1], t[2], t[3]],
          eo: false,
          c: [t[4], t[5]],
          ePx: [1, 1],
        });
      }
  const gotN = NEW.run(EMPTY, EMPTY, qs),
    gotO = OLD.run(EMPTY, EMPTY, qs);
  const per = CASES.length;
  for (const [ki, name] of [
    [0, 'slugCov'],
    [1, 'curveCov'],
    [2, 'arcCov'],
  ]) {
    // the reference: exact box area (slugCov) / the twin at unit scale (curve, arc)
    const ref = CASES.map((c) => {
      const t = terms(c, 1);
      return ki === 0
        ? exactBoxCov(c.n, c.d)
        : (ki === 1 ? twinCurve : twinArc)(t[0], t[1], t[2], t[3], t[4], t[5]);
    });
    const worst = (arr, si) => {
      let w = 0;
      for (let j = 0; j < per; j++)
        w = Math.max(w, Math.abs(arr[(ki * 3 + si) * per + j] - ref[j]));
      return w;
    };
    for (let si = 0; si < 3; si++) {
      const w = worst(gotN, si);
      ok(
        w <= 3e-5,
        `${name} at scale 2^${Math.round(Math.log2(SCALES[si]))}: worst ${(w * 255).toFixed(4)}/255 from the reference over ${per} edges`,
      );
    }
    const wOld = worst(gotO, 0);
    // slugCov's floor scales its normal AND its distance by the same factor (grad/g and -f/g), which is the same half-plane:
    // a 1e-6 floor is benign there, so there is nothing for the mutation to move. The two curvature kernels are not: the
    // curvature term divides by g (cubed) and the bias is then in the wrong units.
    if (ki === 0)
      console.log(
        `  note slugCov with a 1e-6 floor, at 2^-20: worst ${(wOld * 255).toFixed(2)}/255 (benign: normal and distance scale together)`,
      );
    else
      ok(
        wOld > 8 / 255,
        `${name} with a 1e-6 floor, at 2^-20: worst ${(wOld * 255).toFixed(1)}/255 -- the assertion can fail`,
      );
    ok(
      worst(gotO, 1) <= 3e-5 && worst(gotO, 2) <= 3e-5,
      `...and a 1e-6 floor never binds at 1 or 2^20, so those two scales do not move`,
    );
  }
}
console.log(fail ? `LB-GRAD-FLOOR-SCALE FAIL (${fail})` : 'LB-GRAD-FLOOR-SCALE OK');
process.exit(fail ? 1 : 0);

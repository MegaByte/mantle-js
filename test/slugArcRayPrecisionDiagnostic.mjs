// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Development diagnostic: float32 arc reconstruction and translated GLSL expressions.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
import { arcRayUlp } from '../src/hitTest/bandWinding.js';

// ---- (c) the factor against the disagreement it has to cover -----------------------------
// The shader builds the endpoint's y in float32 as `cy + (sp·rx)·cosθ + (cp·ry)·sinθ`. Emulate
// that -- every product, sum and trig call rounded to float32 -- and measure how far it lands
// from the same expression in double, as a fraction of each candidate normalizer. This assumes
// correctly-rounded trig, which is what Math.fround can model; a driver whose sin/cos are
// looser moves both sides of a relative bound and neither side of an absolute one, which is
// the second reason this is not a fixed distance.
{
  const f = Math.fround;
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let worstSum = 0,
    worstLocal = 0,
    n = 0;
  for (const S of [1e-6, 1, 1e3, 1e6]) {
    for (const off of [0, 1e3, 1e5]) {
      for (let i = 0; i < 40000; i++, n++) {
        const rx = f((0.05 + rnd() * 2) * S),
          ry = f((0.05 + rnd() * 2) * S);
        const cy = f(off * S + (rnd() - 0.5) * 4 * S);
        const phi = f((rnd() - 0.5) * Math.PI),
          th = f((rnd() - 0.5) * 4 * Math.PI);
        const sp32 = f(Math.sin(phi)),
          cp32 = f(Math.cos(phi)),
          ct = f(Math.cos(th)),
          st = f(Math.sin(th));
        const ay = f(sp32 * rx),
          by = f(cp32 * ry);
        const got = f(cy + f(f(ay * ct) + f(by * st)));
        const want = cy + Math.sin(phi) * rx * Math.cos(th) + Math.cos(phi) * ry * Math.sin(th);
        const err = Math.abs(got - want);
        worstSum = Math.max(worstSum, err / (Math.abs(cy) + rx + ry));
        worstLocal = Math.max(worstLocal, err / (rx + ry));
      }
    }
  }
  const factor = arcRayUlp(1, 1, 1) / 3; // the bare fraction, normalizer stripped
  ok(
    worstSum < factor,
    `(c) the factor ${factor.toExponential(2)} covers the measured float32 disagreement ${worstSum.toExponential(2)} of |cy|+rx+ry (${n} arcs over 4 scales x 3 origin offsets)`,
  );
  ok(
    factor < 2 * worstSum,
    `(c) ...and is ONE ulp of it (${(factor / worstSum).toFixed(2)}x), a resolution rather than a window with headroom`,
  );
  ok(
    worstSum < 1e-6,
    `(c) and that disagreement is flat in scale and offset (${worstSum.toExponential(2)}, ~${(worstSum / 1.1920929e-7).toFixed(1)} float32 eps)`,
  );
  ok(
    worstLocal > 1e-3,
    `(c) rx+ry alone is NOT a bound on it — ${worstLocal.toExponential(2)} for art far from the origin, where |cy| sets the error`,
  );
}

// ---- (d) the GLSL twins ------------------------------------------------------------------
{
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  const code = gl.replace(/\/\/[^\n]*/g, ''); // the CODE; comments may still name the window
  const twin = (fn, axis) => {
    const decl = code.match(new RegExp(`float ${fn}\\(vec4 d1\\) \\{ return ([^;]+); \\}`));
    ok(!!decl, `(d) _coverage.glsl declares ${fn}`);
    if (!decl) return;
    // evaluate the GLSL body with d1 = (cx, cy, rx, ry) to compare it with the JS port
    const body = decl[1]
      .replace(/\babs\b/g, 'Math.abs')
      .replace(/d1\.x/g, 'cx')
      .replace(/d1\.y/g, 'cy')
      .replace(/d1\.z/g, 'rx')
      .replace(/d1\.w/g, 'ry');
    const glUlp = Function('cx', 'cy', 'rx', 'ry', `return (${body});`);
    let same = true;
    for (const [cx, cy, rx, ry] of [
      [7, 50, 30, 30],
      [91234, -3.5, 0.002, 91234],
      [0, 0, 1, 1],
    ]) {
      if (glUlp(cx, cy, rx, ry) !== arcRayUlp(axis === 'H' ? cy : cx, rx, ry)) same = false;
    }
    ok(
      same,
      `(d) ${fn} and the JS port are the same function, of |c${axis === 'H' ? 'y' : 'x'}| + |rx| + |ry| (the ${axis} ray's crossing axis)`,
    );
  };
  twin('arcRayUlpV', 'V');
  // ONE caller, one rule: band-hard's hardCrossArc counts through arcRayCrossings, with no tolerance, from the stored
  // ends. renderFill is the exact box coverage (AAC's walk, which counts no crossings), so it has no arc sub-loop:
  // a second walker that counts through anything else is a defect.
  const calls = code.match(/= arcRayCrossings\([^;]*;/g) || [];
  ok(
    calls.length === 1,
    `(d) the arc walker that counts crossings does it through arcRayCrossings (${calls.length} call sites)`,
  );
  ok(
    calls.every((c) => !/arcRayUlp/.test(c)) &&
      !/float arcRayUlp\(/.test(code) &&
      (code.match(/arcEndsLoHi\(/g) || []).length === 2,
    '(d) ...it passes no endpoint tolerance, and reads the stored ends (arcEndsLoHi)',
  );
  ok(!/arcOnRayTol/.test(code), '(d) nothing named arcOnRayTol is left in the shader code');
  ok(
    !/abs\(y[SE]9?\) *< *1e-3/.test(code),
    '(d) no absolute endpoint-on-ray test is left in the shader',
  );
}

if (fail) process.exit(1);
console.log('SLUG-ARC-RAY-PRECISION PASS');

// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchKernelTwinFidelitySmoke — the CPU twin of the CPatch kernel IS the kernel.
//
// WHY this EXISTS. `src/renderer/cpatchCov.js` is the model every CPatch measurement in this tree
// is taken through: probes/cpatchGate/_rowGateAaRef, _rowGateSpill, probes/_zzAaAudit,
// probes/_cpatchShapeQuality, probes/morphScale/_morphCov and the smokes that wrap them all
// compose `patchCoverage`. Its own header says what that is worth -- "it must match
// _cpatchCoverage.glsl term for term or it is worse than nothing". A shader-only change to the
// kernel's SUB-PIXEL composition (exactBoxCov2 for two outline constraints inside one pixel,
// exactBoxCov3 for a relaxed seam's own piece) would leave the twin modelling a min()-combined
// kernel the shader does not have; a twin missing `arcCov`, or a harness fitting the wrong box,
// fails the same way from the other side.
//
// So: the box-coverage family is checked against the SHIPPED SHADER TEXT compiled to float32 C++
// (`_glslEmu.mjs`), not against a second reading of it; the composition is checked on a shape
// whose answer is known in closed form; and a STRUCTURAL GUARD comes last -- every coverage
// function `_cpatchCoverage.glsl` calls must be called by the twin. That last check catches the
// drift on the day the shader changes, and it costs nothing to keep.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
  hasCxx,
  buildGlslEmu,
  K_BOXCOV,
  K_BOXCOV2,
  K_BOXCOV3,
  K_CPATCH_BOX23,
} from './_glslEmu.mjs';
// NAMESPACE IMPORT, deliberately: a missing named export is an ESM LINK error, which would make
// this smoke crash instead of reporting — and a crashed smoke prints no FAIL. A twin with neither
// exactBoxCov2 nor exactBoxCov3 must read as failed assertions, not as a stack trace.
import * as TWIN from '../src/renderer/cpatchCov.js';

const { exactBoxCov, exactBoxCov2, exactBoxCov3, cpExactBoxCov23, patchCoverage } = TWIN;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

// ── 0. the twin has the kernel's box-coverage family at all ──────────────────────────────────
const has2 = typeof exactBoxCov2 === 'function',
  has3 = typeof exactBoxCov3 === 'function';
ok(has2, "the twin exports exactBoxCov2 (the kernel's two-half-plane area)");
ok(has3, "the twin exports exactBoxCov3 (the relaxed seam's own piece)");

// ── 1. they agree with the SHIPPED shader text, in float32 ───────────────────────────────────
// Unit normals over a full angle sweep and offsets across the whole band a pixel box can see, which
// is where every one of these terms is spent: past +/-0.7072 the area saturates and any
// implementation agrees by construction.
const dirs = [];
for (let i = 0; i < 24; i++) {
  const a = (i / 24) * Math.PI * 2;
  dirs.push([Math.cos(a), Math.sin(a)]);
}
const offs = [];
for (let i = -9; i <= 9; i++) offs.push(i / 12);
if (!hasCxx()) {
  console.log('  SKIP the shipped-shader comparison: no C++ compiler ($CXX, clang++, g++, c++)');
} else if (!has2 || !has3) {
  ok(false, "the shipped-shader comparison needs the twin's exactBoxCov2/3, which are absent");
} else {
  const emu = buildGlslEmu(ROOT, { boxCov: true });
  const EMPTY = new Float32Array(4);
  const qs = [],
    want = [];
  for (let i = 0; i < dirs.length; i++) {
    const n1 = dirs[i];
    for (const d1 of offs) {
      qs.push({ k: K_BOXCOV, bb: [n1[0], n1[1], d1, 0] });
      want.push(exactBoxCov(n1[0], n1[1], d1));
      // ...and every second direction against every other, which is the pair a stem or a corner
      // hands the kernel: two bounds of the same patch, so the interesting pairs are the opposed
      // ones (a narrow stem) and the near-perpendicular ones (a corner).
      for (let j = 0; j < dirs.length; j += 5) {
        const n2 = dirs[j],
          d2 = offs[(i + j) % offs.length];
        qs.push({ k: K_BOXCOV2, bb: [n1[0], n1[1], d1, 0], ex: [n2[0], n2[1], d2] });
        want.push(exactBoxCov2(n1[0], n1[1], d1, n2[0], n2[1], d2));
        const n3 = dirs[(i + j + 7) % dirs.length],
          d3 = offs[(i + 2 * j) % offs.length];
        qs.push({
          k: K_BOXCOV3,
          bb: [n1[0], n1[1], d1, 0],
          ex: [n2[0], n2[1], d2, n3[0], n3[1], d3],
        });
        want.push(exactBoxCov3(n1[0], n1[1], d1, n2[0], n2[1], d2, n3[0], n3[1], d3));
      }
    }
  }
  const got = emu.run(EMPTY, EMPTY, qs);
  const worst = { [K_BOXCOV]: 0, [K_BOXCOV2]: 0, [K_BOXCOV3]: 0 };
  const count = { [K_BOXCOV]: 0, [K_BOXCOV2]: 0, [K_BOXCOV3]: 0 };
  for (let i = 0; i < qs.length; i++) {
    const d = Math.abs(got[i] - want[i]);
    worst[qs[i].k] = Math.max(worst[qs[i].k], d);
    count[qs[i].k]++;
  }
  // float64 twin against float32 shader: the two differ only by rounding, and a Sutherland-Hodgman
  // area over a unit box is continuous in (n, d), so a clip that lands differently in the last ulp
  // moves the area by that ulp and not by a vertex. 2e-6 is ~0.0005/255, the same bar the
  // Loop-Blinn twin's smoke holds.
  ok(
    worst[K_BOXCOV] <= 2e-6,
    `the twin's exactBoxCov matches the shipped one (max ${(worst[K_BOXCOV] * 255).toExponential(2)}/255 over ${count[K_BOXCOV]} cases)`,
  );
  ok(
    worst[K_BOXCOV2] <= 2e-6,
    `...and exactBoxCov2 (max ${(worst[K_BOXCOV2] * 255).toExponential(2)}/255 over ${count[K_BOXCOV2]})`,
  );
  ok(
    worst[K_BOXCOV3] <= 2e-6,
    `...and exactBoxCov3 (max ${(worst[K_BOXCOV3] * 255).toExponential(2)}/255 over ${count[K_BOXCOV3]})`,
  );
  // TEETH: the pair is not min(), or the three checks above prove only that two spellings of
  // exactBoxCov agree. A stem narrower than a pixel is the case the kernel changed for.
  let spread = 0;
  for (const s of [0.1, 0.2, 0.3, 0.45]) {
    // two opposed half-planes at +/-s: exact area 2s, min() 0.5 + s
    const e = exactBoxCov2(1, 0, s, -1, 0, s),
      m = Math.min(exactBoxCov(1, 0, s), exactBoxCov(-1, 0, s));
    spread = Math.max(spread, m - e);
  }
  ok(
    spread > 4 / 255,
    `exactBoxCov2 genuinely differs from min() (up to ${(spread * 255).toFixed(1)}/255 on a sub-pixel stem)`,
  );
}

// ── 1b. the areas the composition actually takes: the loop-free cpExactBoxCov23 ──
// The kernel does not clip a polygon for its two areas; it sums Green's theorem over the bounding
// lines, with a tie-break that moves the k-th plane inward by (k+1) 2e-6 px. So two things are held
// here: the twin's port against the SHIPPED text in float32, and both against the exact area -- over
// the same sweep, the ABSENT middle plane the seam piece passes, and the ties a pixel-aligned edge
// makes routine: offsets exactly at the box's support, and coincident and opposed planes.
//
// THE REFERENCE IS A CLIP WITH NO SLOT LIMIT, and not exactBoxCov2/3. At an exact tie a clip pass
// emits a vertex AND a zero-length intersection at it, and three passes of that overflow the eight
// slots exactBoxCov3 (and the twin's copy of it) keeps: two coincident planes and a third through the
// box read 0.7946 there against an exact 0.9156, 7 cases of this sweep. The loop-free form has no
// slots to overflow.
const exactArea = (planes) => {
  let poly = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];
  for (const [nx, ny, d] of planes) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i],
        b = poly[(i + 1) % poly.length];
      const fa = nx * a[0] + ny * a[1] - d,
        fb = nx * b[0] + ny * b[1] - d;
      if (fa <= 0) out.push(a);
      if (fa < 0 !== fb < 0) {
        const t = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    poly = out;
    if (!poly.length) return 0;
  }
  let ar = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    ar += a[0] * b[1] - a[1] * b[0];
  }
  return Math.abs(ar) / 2;
};
{
  const hasG = typeof cpExactBoxCov23 === 'function';
  ok(hasG, "the twin exports cpExactBoxCov23 (the composition's loop-free areas)");
  if (hasG && hasCxx()) {
    const emu = buildGlslEmu(ROOT, { cpatch: true });
    const EMPTY = new Float32Array(4);
    const qs = [],
      want = [],
      exact = [];
    const sup = (n) => 0.5 * (Math.abs(n[0]) + Math.abs(n[1]));
    const tieOffs = (n) => [...offs, sup(n), -sup(n)];
    for (let i = 0; i < dirs.length; i++) {
      const n1 = dirs[i];
      for (const d1 of tieOffs(n1))
        for (let j = 0; j < dirs.length; j += 5) {
          const pick = (j / 5) % 4;
          // ...a pair that is the same plane, the opposed plane (a zero-width sliver), NEARLY the same
          // plane -- 3e-7 rad and 2.1e-6 px apart, which the tie-break leaves crossing inside the pixel,
          // as two tightest constraints of a corpus shape do when each line locates that crossing for itself
          // (0.012 against an exact 0.041; 9.7/255 here) -- or another one
          const tw = i % 2 ? 3e-7 : -3e-7,
            near = [
              n1[0] * Math.cos(tw) - n1[1] * Math.sin(tw),
              n1[0] * Math.sin(tw) + n1[1] * Math.cos(tw),
            ];
          const n2 = pick === 0 ? n1 : pick === 1 ? [-n1[0], -n1[1]] : pick === 2 ? near : dirs[j];
          const d2 =
            pick === 0
              ? d1
              : pick === 1
                ? -d1
                : pick === 2
                  ? d1 + 2.1e-6
                  : offs[(i + j) % offs.length];
          const n3 = dirs[(i + j + 7) % dirs.length],
            d3 = j % 2 ? sup(n3) : offs[(i + 2 * j) % offs.length];
          for (const absent of [false, true]) {
            const m2 = absent ? [0, 0] : n2,
              e2 = absent ? 1 : d2;
            for (const third of [false, true]) {
              qs.push({
                k: K_CPATCH_BOX23,
                GD: [third ? 0 : 1, third ? 1 : 0, 0, 0],
                bb: [n1[0], n1[1], d1, 0],
                ex: [m2[0], m2[1], e2, n3[0], n3[1], d3],
              });
              const [a3, a2] = cpExactBoxCov23(
                n1[0],
                n1[1],
                d1,
                m2[0],
                m2[1],
                e2,
                n3[0],
                n3[1],
                d3,
                third,
              );
              want.push(third ? a3 : a2);
              const planes = [[n1[0], n1[1], d1]];
              if (!absent) planes.push([n2[0], n2[1], d2]);
              if (third) planes.push([n3[0], n3[1], d3]);
              exact.push(exactArea(planes));
            }
          }
        }
    }
    const got = emu.run(EMPTY, EMPTY, qs);
    let wT = 0,
      wS = 0,
      wE = 0;
    for (let i = 0; i < qs.length; i++) {
      wT = Math.max(wT, Math.abs(got[i] - want[i]));
      wS = Math.max(wS, Math.abs(got[i] - exact[i]));
      wE = Math.max(wE, Math.abs(want[i] - exact[i]));
    }
    // The tie-break moves each plane by at most 6e-6 px, which moves an area by at most that times
    // the box's widest chord: 2e-5 is 0.005/255.
    ok(
      wT <= 2e-5,
      `the twin's cpExactBoxCov23 matches the shipped one (max ${(wT * 255).toExponential(2)}/255 over ${qs.length} cases)`,
    );
    ok(
      wS <= 2e-5 && wE <= 2e-5,
      `...and both are the exact area, ties included (shipped max ${(wS * 255).toExponential(2)}/255, twin ${(wE * 255).toExponential(2)}/255)`,
    );
  }
}

// ── 1c. ...and on a GPU that FUSES its multiply-adds ───────────────────────────
// The twin above rounds every operation on its own, which is the one arithmetic no GPU uses. Two
// lines' crossing signs n2.t1 and n1.t2 are exact negatives, but fused they round differently, and
// for a pair within float32's floor of parallel they can come back with the same sign: both lines
// keep one side of the crossing, and the second line's share is counted or dropped whole (a pixel
// 9/255 off on the cpatchMorphGpuBlend case's ring, GPU blend against the CPU pack of the same pose). Nearly coincident pairs, and triples with such a pair in any slot, against the exact
// area, compiled with fused multiply-adds.
if (typeof cpExactBoxCov23 === 'function' && hasCxx()) {
  const emu = buildGlslEmu(ROOT, { cpatch: true, contract: true });
  const f = Math.fround;
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 4294967296;
  const sgn = () => (rnd() < 0.5 ? -1 : 1);
  const qs = [],
    exact = [],
    M = 20000;
  for (let i = 0; i < 2 * M; i++) {
    // unnormalised, as the kernel's gradients are; 1e-9..1e-5 rad and 1e-5..1e-3 px apart
    const L = 0.5 + 2 * rnd(),
      th = 2 * Math.PI * rnd(),
      dth = sgn() * Math.pow(10, -9 + 4 * rnd());
    const nA = [f(L * Math.cos(th)), f(L * Math.sin(th))],
      nB = [f(L * Math.cos(th + dth)), f(L * Math.sin(th + dth))];
    const dA = f(1.2 * L * (rnd() - 0.5)),
      dB = f(dA + sgn() * Math.pow(10, -5 + 2 * rnd()) * L);
    const thO = 2 * Math.PI * rnd(),
      nO = [f(L * Math.cos(thO)), f(L * Math.sin(thO))],
      dO = f(1.2 * L * (rnd() - 0.3));
    const third = i >= M,
      pk = i % 3;
    const P = !third
      ? [
          [...nA, dA],
          [...nB, dB],
        ]
      : pk === 0
        ? [
            [...nO, dO],
            [...nA, dA],
            [...nB, dB],
          ]
        : pk === 1
          ? [
              [...nA, dA],
              [...nO, dO],
              [...nB, dB],
            ]
          : [
              [...nA, dA],
              [...nB, dB],
              [...nO, dO],
            ];
    const P3 = P[2] || [0, 0, 1];
    qs.push({
      k: K_CPATCH_BOX23,
      GD: [third ? 0 : 1, third ? 1 : 0, 0, 0],
      bb: [P[0][0], P[0][1], P[0][2], 0],
      ex: [...P[1], ...P3],
    });
    exact.push(exactArea(P));
  }
  const got = emu.run(new Float32Array(4), new Float32Array(4), qs);
  for (const [what, a, b] of [
    ['pairs', 0, M],
    ['triples', M, 2 * M],
  ]) {
    let bad = 0,
      w = 0;
    for (let i = a; i < b; i++) {
      const e = Math.abs(got[i] - exact[i]);
      if (e > 1 / 255) bad++;
      w = Math.max(w, e);
    }
    ok(
      w <= 2e-5,
      `fused multiply-adds: nearly coincident ${what} keep the exact area (${bad} of ${b - a} off by over 1/255, max ${(w * 255).toFixed(3)}/255)`,
    );
  }
}

// ── 2. the COMPOSITION spends them, on a shape whose answer is known ─────────────────────────
// A bar half a pixel wide. Both long sides cut every interior pixel, so the two tightest outline
// constraints are a facing pair and the true coverage is their intersection: exactly 0.5. min()
// returns the larger single area, 0.75. This is the +38% the shader's own note records for 0.5px
// bars, and a min()-combined twin reports it.
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
function barPatches(wPx, px) {
  const w = wPx * px,
    x0 = 100,
    y0 = 100,
    h = 40 * px;
  const P = [
    [x0, y0],
    [x0 + w, y0],
    [x0 + w, y0 + h],
    [x0, y0 + h],
  ];
  const ring = [];
  for (let i = 0; i < 4; i++) ring.push({ t: 'line', P: [P[i], P[(i + 1) % 4]] });
  const patches = [];
  packCPatchShape([ring], 0, { onPatches: (a) => patches.push(...a) });
  return { patches, x0, y0, w, h };
}
{
  const px = 1 / 64; // an arbitrary em-per-pixel; coverage must not depend on it
  const { patches, x0, y0, w, h } = barPatches(0.5, px);
  ok(patches.length > 0, `the 0.5px bar decomposes (${patches.length} patches)`);
  let ink = 0,
    n = 0;
  for (let j = 2; j < 38; j++) {
    const cy = y0 + (j + 0.5) * px;
    // the pixel column whose center sits on the bar's own centerline
    const cx = x0 + w / 2;
    let open = 1.0;
    for (const p of patches) {
      const c = patchCoverage(p, cx, cy, px);
      if (c <= 0) continue;
      open *= 1.0 - c;
    }
    ink += 1.0 - open;
    n++;
  }
  const mean = n ? ink / n : 0;
  // The pixel is centered on the bar, so the exact coverage is the bar's width in pixels.
  ok(
    n > 0 && Math.abs(mean - 0.5) <= 0.02,
    `a 0.5px bar's center pixels model 0.5 coverage (mean ${mean.toFixed(4)}, exact 0.500)`,
  );
  ok(
    mean < 0.7,
    `...and not min()'s 0.75 (${mean.toFixed(4)}, which is +${((mean / 0.5 - 1) * 100).toFixed(1)}% ink)`,
  );
  void h;
}
// ...and it is the PAIR TERM doing the work, not something else in the composition. Stated
// directly (min() would read 0.75 against the pair's 0.50): the bar's
// two long edges sit 0.25px either side of the center pixel, so the twin's own single-edge areas
// are what min() would return, and its pair area is what the composition must return -- the model
// has to land on the second and clear the first.
{
  const px = 1 / 64;
  const { patches, x0, y0, w } = barPatches(0.5, px);
  const pair = exactBoxCov2(1, 0, 0.25, -1, 0, 0.25);
  const single = Math.min(exactBoxCov(1, 0, 0.25), exactBoxCov(-1, 0, 0.25));
  let a = 0,
    n = 0;
  for (let j = 2; j < 38; j++) {
    const cy = y0 + (j + 0.5) * px,
      cx = x0 + w / 2;
    let oa = 1.0;
    for (const p of patches) {
      const ca = patchCoverage(p, cx, cy, px);
      if (ca > 0) oa *= 1.0 - ca;
    }
    a += 1.0 - oa;
    n++;
  }
  const mean = n ? a / n : 0;
  ok(
    single - pair > 0.1,
    `min() of the bar's two edges is ${single.toFixed(4)}, the pair's area ${pair.toFixed(4)}`,
  );
  ok(
    n > 0 && Math.abs(mean - pair) <= 0.02 && single - mean > 0.1,
    `the model returns the pair's area (${mean.toFixed(4)}), not min()'s (${single.toFixed(4)})`,
  );
}

// ── 3. the structural guard: no coverage function the kernel calls is missing from the twin ──
{
  const glsl = readFileSync(path.join(ROOT, 'src/shaders/_cpatchCoverage.glsl'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
  const twin = readFileSync(path.join(ROOT, 'src/renderer/cpatchCov.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').replace(/^\s*\/\/\/.*$/, ''))
    .join('\n');
  // Every *Cov-shaped callee in the kernel's own dispatch. NAMES, not bodies: a body is what the
  // emulator comparison above checks, and a name is what silently goes missing. The kernel's three
  // own entry points are dropped -- the twin spells them curveCov / patchCoverage, and renaming a
  // function it already models is not the failure this guards against.
  const called = new Set();
  for (const m of glsl.matchAll(/\b(\w*[Cc]ov\w*)\s*\(/g)) called.add(m[1]);
  for (const own of ['cpatchCoverage', 'cpatchCurveCov', 'cpatchLineCov']) called.delete(own);
  const missing = [...called].filter((n) => !new RegExp(`\\b${n}\\s*\\(`).test(twin));
  ok(
    called.size >= 3,
    `_cpatchCoverage.glsl calls ${called.size} coverage kernels: ${[...called].sort().join(', ')}`,
  );
  ok(
    missing.length === 0,
    `the twin calls every one of them${missing.length ? ' — MISSING: ' + missing.join(', ') : ''}`,
  );
}

console.log(fail ? `CPATCH-KERNEL-TWIN-FIDELITY FAIL (${fail})` : 'CPATCH-KERNEL-TWIN-FIDELITY OK');
process.exit(fail ? 1 : 0);

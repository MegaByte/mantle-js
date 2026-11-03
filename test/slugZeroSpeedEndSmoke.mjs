// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugZeroSpeedEndSmoke — no stray pixels beside a cubic whose last handle sits on its end
// (P3 == P4), the fill's twin of the strokes' zero-speed ends.
//
// solveCubicBisect finds each ray crossing on a monotone piece by clamped Newton from a secant seed.
// A zero-speed end makes the piece FLAT there -- y(t) - y0 ~ (1 - t)^3 -- so the secant seed lands on
// the flat end, the first Newton step flies past the far end, a clamp to the piece parks it there,
// and five iterations do not come back: on openFillNoZ's cubic the H-ray crossing would come out
// 0.6 em (5 px at 256) right of the curve and paint pixels just outside it up to 0.99. The solve is
// SAFEGUARDED: every iterate narrows the bracket the sign test proved, and a
// Newton step that would leave it bisects instead (inclusively, so a converged root on the bracket's
// end stays). Where no step leaves the bracket it is the same iteration.
//
// A piece END exactly on the ray is taken as the root as it stands: evalC there is not exactly 0 in
// float32, and at a flat end that residue's Newton step leaves the bracket, so bisecting would walk
// away from a root no iteration can improve on (the shader's `onEnd`).
//
// PINS, against 16x16 exact coverage, at the geometric scales 2^-20, 1 and 2^20: no Slug pixel off by
// more than 0.25 on the P3 == P4 cubic, its reverse (P1 == P2, zero speed at the START), both open and
// closed. And the hit test's CPU twin of the walk (bandWinding.js) reads those pixels right.
//
// Slug's kernel is the exact box coverage (AAC's walk), which solves nothing with solveCubicBisect: the solve is
// band-hard's (hardCrossCubic). So band-hard is pinned too -- its 0/1 answer equals the exact point-in-fill at every
// pixel center, at every scale, fused and not -- and the unguarded loop is run through band-hard for the
// non-vacuity (pixel centers wrong on the P3 == P4 cubic).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_SLUG, K_HARD, AAC_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP slugZeroSpeedEndSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { pointInFill } = await import('../src/hitTest/fillCoverage.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
// The unguarded loop: clamp to the piece instead of keeping a bracket.
// (Indented for the per-piece block, where each piece's root goes to its own component.)
const OLD_LOOP = `      for (int k = 0; k < SLUG_NEWTON; k++) {
        float fy = evalC(cy, xr);
        float fdy = evalCD(cy, xr);
        if (fdy == 0.0) break;
        float xn = xr - fy / fdy;
        xr = clamp(xn, lo, hi);
      }`;
const a = GLSL.indexOf('      float bl = lo, bh = hi;'),
  z = GLSL.indexOf('      float rr = evalC(cx, xr), uu = sHi ? 1.0 : 0.0;', a);
ok(a > 0 && z > a, 'solveCubicBisect keeps a bracket in the shipped text');
const UNGUARDED = GLSL.slice(0, a) + OLD_LOOP + '\n' + GLSL.slice(z);
const emu = buildGlslEmu(ROOT, { contract: false });
// band-hard (MANTLE_HARD) is the walker that runs solveCubicBisect: shipped, fused, and with the unguarded loop
const emuH = buildGlslEmu(ROOT, { defines: AAC_HARD, contract: false }),
  emuHF = buildGlslEmu(ROOT, { defines: AAC_HARD, contract: true });
const emuHOld = buildGlslEmu(ROOT, { defines: AAC_HARD, glsl: UNGUARDED, contract: false });
// FUSED TOO: a GPU contracts a * b + c into an fma, and fused, y''s discriminant put the zero-speed end's root
// inside (0, 1) -- a sliver piece whose far end read noise on the ray, 0.39 off exact on the on-row case
const emuF = buildGlslEmu(ROOT, { contract: true });

const CASES = [
  ['P3 == P4, open', 'M 1762.4 783.1 C 1762.1 799.2 1745.3 799.2 1745.3 799.2'],
  ['P3 == P4, closed', 'M 1762.4 783.1 C 1762.1 799.2 1745.3 799.2 1745.3 799.2 Z'],
  [
    'P1 == P2 (zero speed at the start), open',
    'M 1745.3 799.2 C 1745.3 799.2 1762.1 799.2 1762.4 783.1',
  ],
  // ...and with that flat end exactly on a sample row and column (1740 + 48.5 px, 778 + 193.5 px at
  // 0.109375 em/px): the piece end is the root, and a bracket alone would have bisected away from it.
  [
    'P3 == P4 exactly on a sample row and column',
    'M 1762.4 783.1 C 1762.1 799.1640625 1745.3046875 799.1640625 1745.3046875 799.1640625',
  ],
];
const VB = [1740, 778, 28, 28],
  N = 256,
  SS = 16;
async function wrong(d, s, e, hard = false) {
  const sc = (v) => v * s;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB.map(sc).join(' ')}"><path d="${d.replace(/-?\d+(\.\d+)?/g, (n) => String(Number(n) * s))}"/></svg>`;
  const b = await importSvg(svg, { preserveViewport: true, occupancyGrid: false });
  const sh = fillShapes(b, parseMetaBin, M)[0],
    band = new Float32Array(b.bands),
    curve = new Float32Array(b.curves);
  const segs = decodeSegs(curve, sh.range.begin, sh.range.end),
    px = (VB[2] * s) / N,
    qs = [],
    ref = [];
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const c = [VB[0] * s + (i + 0.5) * px, VB[1] * s + (j + 0.5) * px];
      if (
        c[0] < sh.bb[0] - 2 * px ||
        c[0] > sh.bb[2] + 2 * px ||
        c[1] < sh.bb[1] - 2 * px ||
        c[1] > sh.bb[3] + 2 * px
      )
        continue;
      let n = 0;
      // band-hard answers the pixel center's winding: its reference is the exact point-in-fill there
      if (hard) n = pointInFill(segs, c[0], c[1], sh.eo) ? SS * SS : 0;
      else
        for (let v = 0; v < SS; v++)
          for (let u = 0; u < SS; u++)
            if (
              pointInFill(
                segs,
                VB[0] * s + (i + (u + 0.5) / SS) * px,
                VB[1] * s + (j + (v + 0.5) / SS) * px,
                sh.eo,
              )
            )
              n++;
      qs.push({ k: hard ? K_HARD : K_SLUG, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [px, px] });
      ref.push(n / SS / SS);
    }
  const out = e.run(band, curve, qs);
  let bad = 0,
    worst = 0;
  out.forEach((v, i) => {
    const d = Math.abs(v - ref[i]);
    if (d > 0.25) bad++;
    worst = Math.max(worst, d);
  });
  return { bad, worst };
}
for (const [name, d] of CASES) {
  for (const k of [-20, 0, 20]) {
    for (const [fused, e] of [
      [false, emu],
      [true, emuF],
    ]) {
      const r = await wrong(d, 2 ** k, e);
      ok(
        r.bad === 0,
        `${name}, 2^${k}${fused ? ', fused' : ''}: ${r.bad} Slug px off exact by > 0.25 (worst ${r.worst.toFixed(3)})`,
      );
    }
  }
}
for (const [name, d] of CASES) {
  for (const k of [-20, 0, 20]) {
    for (const [fused, e] of [
      [false, emuH],
      [true, emuHF],
    ]) {
      const r = await wrong(d, 2 ** k, e, true);
      ok(
        r.bad === 0,
        `band-hard, ${name}, 2^${k}${fused ? ', fused' : ''}: ${r.bad} pixel centers off the exact point-in-fill`,
      );
    }
  }
}
{
  const r = await wrong(CASES[0][1], 1, emuHOld, true);
  ok(
    r.bad > 0,
    `non-vacuity: the unguarded loop, through band-hard, is off on ${r.bad} pixel centers`,
  );
}

// ---- the hit test's twin (src/hitTest/bandWinding.js solveCubicBisect), same pixels ------------------
// It carried the same clamped Newton, so a hit test beside the zero-speed end answered what Slug drew.
{
  const { bandFillCoverage } = await import('../src/hitTest/bandWinding.js');
  const cpu = {
    run: (band, curve, qs) =>
      qs.map((q) =>
        bandFillCoverage(band, curve, q.GD, q.bb, q.c[0], q.c[1], 1 / q.ePx[0], 1 / q.ePx[1], q.eo),
      ),
  };
  for (const [name, d] of CASES) {
    const r = await wrong(d, 1, cpu);
    ok(
      r.bad === 0,
      `hit test, ${name}: ${r.bad} px of bandFillCoverage off exact by > 0.25 (worst ${r.worst.toFixed(3)})`,
    );
  }
}

console.log(fail ? `slugZeroSpeedEndSmoke FAIL (${fail})` : 'slugZeroSpeedEndSmoke PASS');
process.exit(fail ? 1 : 0);

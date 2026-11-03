// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeMiterReversalSmoke -- the miter ratio of a join within 0.1 degree of a reversal.
//
// SVG 2 (stroke-miterlimit): the miter length over the stroke width is 1 / sin(theta / 2), theta the interior angle at the join; a miter
// that exceeds the limit is a bevel (stroke-linejoin: miter) or is clipped (miter-clip). A turn of phi degrees from straight on has
// theta = 180 - phi, so the ratio is 1 / cos(phi / 2): 1146 at 179.9 degrees, 11459 at 179.99, 114592 at 179.999.
// Computing sin(theta/2) as sqrt(max((1 - c) / 2, 1e-9)) and dividing by max(sinHalf, 1e-6) puts two ABSOLUTE bounds on an angle.
// 1 - c is 0 or a multiple of 6e-8 in float32 for any turn within 0.02 degrees of a reversal, and the 1e-9 floor stops the ratio at
// 3.2e4, so a limit above that paints a spike the spec bevels (179.999 degrees, limit 1e5) and a ratio between 3.2e4 and the next float
// step reads as the wrong side of its limit (179.99 degrees, limit 1e5 bevels where the spec miters). The shaders take half the distance
// between the two unit vectors (|u - v| = 2 sin(theta / 2)), which has no floor.
//   (a) the SHIPPED fragment shader (float32 emulation, test/_glslEmu.mjs) at scales 2^-20, 1, 2^20: a probe ON the miter tip's axis, 3
//       half-widths past the vertex, is painted when the ratio is within the limit and not otherwise; lines, quads and cubics;
//       limits 1e2 ... 1e8; turns 179.9 / 179.99 / 179.999 degrees. A pair within 5% of its boundary is not asserted.
//   (b) the same for miter-clip: the clip distance min(ratio, limit) half-widths: painted at half of it, not past 1.1 times it.
//   (c) the CPU hit test (src/hitTest/curveGeom.js pointOnStroke), straight and quad chains, miter: the same decision. Past
//       MAX_MITER_RATIO (1e6, bundle/strokeReach.js) a join bevels in the renderer whatever the limit -- the reach bound, since the stored
//       limit is never above it -- and the hit test applies that bound by name, not an absolute 1e-6 on sin(theta/2).
//   node test/strokeMiterReversalSmoke.mjs [--glsl path.frag.glsl]   (another shader text against the same pins)
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu } from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, hasExact } from './_strokeMainCov.mjs';
import { pointOnStroke } from '../src/hitTest/curveGeom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP strokeMiterReversalSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const gi = process.argv.indexOf('--glsl');
const GLSL = readFileSync(
  gi > 0 ? process.argv[gi + 1] : path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'),
  'utf8',
);
const EXACT = hasExact(GLSL);
const emu = buildGlslEmu(ROOT, { stroke: true, glsl: GLSL });
console.log(
  `strokeMiterReversalSmoke: shader text ${gi > 0 ? process.argv[gi + 1] : 'src/shaders/generated/mantle.frag.glsl'}`,
);

let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};

const SCALES = [2 ** -20, 1, 2 ** 20],
  TURNS = [179.9, 179.99, 179.999],
  LIMITS = [1e2, 1e3, 1e4, 3e4, 1e5, 3e5, 1e6, 1e8];
const ratioOf = (deg) => 1 / Math.cos((deg * Math.PI) / 360); // 1 / sin(theta / 2), theta = 180 - deg
const clear = (ratio, ml) => Math.abs(ratio / ml - 1) > 0.05;
const f9 = (p) => p.map((v) => +v.toPrecision(9)).join(' ');
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** A -> V -> B, in a 100 S square: the first leg along +x into V = the center, the second leaves at `deg` from straight on. */
function chain(deg, S, kind) {
  const hw = 2 * S,
    leg = 20 * hw,
    c = 50 * S,
    phi = (deg * Math.PI) / 180,
    out = [Math.cos(phi), Math.sin(phi)];
  const A = [c - leg, c],
    V = [c, c],
    B = [c + leg * out[0], c + leg * out[1]];
  const tl = Math.hypot(1 - out[0], -out[1]),
    tip = [(1 - out[0]) / tl, -out[1] / tl]; // the miter tip's direction: din - dout
  const seg = (P, Q) =>
    kind === 'L'
      ? `L${f9(Q)}`
      : kind === 'Q'
        ? `Q${f9(lerp(P, Q, 0.5))} ${f9(Q)}`
        : `C${f9(lerp(P, Q, 1 / 3))} ${f9(lerp(P, Q, 2 / 3))} ${f9(Q)}`;
  return { hw, c, A, V, B, out, tip, d: `M${f9(A)}${seg(A, V)}${seg(V, B)}` };
}
async function coverage(deg, ml, S, kind, join, ks) {
  const g = chain(deg, S, kind),
    W = 100 * S;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 ${W} ${W}"><path d="${g.d}" fill="none" stroke="#000" stroke-width="${2 * g.hw}" stroke-linejoin="${join}" stroke-miterlimit="${ml}"/></svg>`;
  const b = await importSvg(svg, { preserveViewport: true });
  const B = strokeRowsOf(b);
  if (!B.rows.length) return ks.map(() => 0);
  const pix = ks.map((k) => [
    (g.c + k * g.hw * g.tip[0]) / S - 0.5,
    (g.c + k * g.hw * g.tip[1]) / S - 0.5,
  ]);
  return Array.from(mainCov(emu, B, B.rows[0], pix, S, EXACT));
}

// ---- (a) miter ---------------------------------------------------------------------------------------------------------
console.log('(a) miter: spike iff 1 / sin(theta / 2) <= limit');
{
  let n = 0;
  const bad = [];
  for (const S of SCALES)
    for (const deg of TURNS)
      for (const ml of LIMITS) {
        const ratio = ratioOf(deg);
        if (!clear(ratio, ml)) continue;
        for (const kind of ['L', 'Q', 'C']) {
          const [cov] = await coverage(deg, ml, S, kind, 'miter', [3]);
          n++;
          if (ratio <= ml ? !(cov > 0.9) : !(cov < 0.1))
            bad.push(
              `${kind} S=2^${Math.log2(S)} ${deg} deg limit ${ml}: ratio ${ratio.toFixed(0)} wants ${ratio <= ml ? 'miter' : 'bevel'}, coverage ${cov.toFixed(2)}`,
            );
        }
      }
  check(
    bad.length === 0,
    `${n} cases, ${bad.length} wrong${bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''}`,
  );
}

// ---- (b) miter-clip ----------------------------------------------------------------------------------------------------
console.log('(b) miter-clip: the spike reaches min(ratio, limit) half-widths');
{
  let n = 0;
  const bad = [];
  for (const S of SCALES)
    for (const deg of TURNS)
      for (const ml of [1e2, 1e4, 1e5]) {
        const T = Math.min(ratioOf(deg), ml);
        for (const kind of ['L', 'C']) {
          const [inside, past] = await coverage(deg, ml, S, kind, 'miter-clip', [0.5 * T, 1.1 * T]);
          n++;
          if (!(inside > 0.3 && past < 0.1))
            bad.push(
              `${kind} S=2^${Math.log2(S)} ${deg} deg limit ${ml}: coverage ${inside.toFixed(2)} at 0.5T, ${past.toFixed(2)} at 1.1T`,
            );
        }
      }
  check(
    bad.length === 0,
    `${n} cases, ${bad.length} wrong${bad.length ? ': ' + bad.slice(0, 3).join('; ') : ''}`,
  );
}

// ---- (c) the CPU hit test ----------------------------------------------------------------------------------------------
console.log('(c) hit test: the same decision');
{
  let n = 0;
  const bad = [];
  for (const S of SCALES)
    for (const deg of [...TURNS, 179.9998, 179.99999, 179.9999999])
      for (const ml of [...LIMITS, 1e7, 1e9, 1e10]) {
        const ratio = ratioOf(deg),
          cap = Math.min(ml, 1e6);
        if (!clear(ratio, cap)) continue;
        const g = chain(deg, S, 'L'),
          phi = (deg * Math.PI) / 180,
          o = g.out;
        const tIn = [1, 0],
          tOut = o;
        for (const kind of ['L', 'Q']) {
          const mk = (P, Q, itx, ity, otx, oty, freeS, freeE) =>
            kind === 'L'
              ? {
                  t: 0,
                  x0: P[0],
                  y0: P[1],
                  x1: Q[0],
                  y1: Q[1],
                  f: false,
                  sd: 0,
                  freeS,
                  freeE,
                  itx,
                  ity,
                  otx,
                  oty,
                  kSS: 0,
                  kSE: 0,
                  kPE: 0,
                  kNS: 0,
                }
              : {
                  t: 1,
                  x0: P[0],
                  y0: P[1],
                  cx: (P[0] + Q[0]) / 2,
                  cy: (P[1] + Q[1]) / 2,
                  x1: Q[0],
                  y1: Q[1],
                  f: false,
                  sd: 0,
                  freeS,
                  freeE,
                  itx,
                  ity,
                  otx,
                  oty,
                  kSS: 0,
                  kSE: 0,
                  kPE: 0,
                  kNS: 0,
                };
          const segs = [
            mk(g.A, g.V, 0, 0, tOut[0], tOut[1], true, false),
            mk(g.V, g.B, tIn[0], tIn[1], 0, 0, false, true),
          ];
          const p = [g.c + 3 * g.hw * g.tip[0], g.c + 3 * g.hw * g.tip[1]];
          const hit = pointOnStroke(segs, p[0], p[1], g.hw, 0, 0, ml, null, 0);
          n++;
          if (hit !== ratio <= cap)
            bad.push(
              `${kind} S=2^${Math.log2(S)} ${deg} deg limit ${ml}: ratio ${ratio.toFixed(0)} wants ${ratio <= cap ? 'hit' : 'miss'}, got ${hit ? 'hit' : 'miss'}`,
            );
        }
      }
  check(
    bad.length === 0,
    `${n} cases, ${bad.length} wrong${bad.length ? ': ' + bad.slice(0, 3).join('; ') : ''}`,
  );
}

if (failures) {
  console.log(`STROKE-MITER-REVERSAL FAIL (${failures})`);
  process.exit(1);
}
console.log('STROKE-MITER-REVERSAL PASS');

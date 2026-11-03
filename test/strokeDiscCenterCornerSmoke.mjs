// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDiscCenterCornerSmoke — a round cap's or join's disc about a vertex on a PIXEL CORNER is its exact area.
//
// THE HAZARD. strokeExactCov takes a round cap's or join's share of the pixel box (op 4), and an arc's (op 5-8), as
// the disc's area over the box's edges: seCircleTri clips each edge to the circle, the part inside a triangle from the
// center and the parts outside the sectors they subtend. A crossing past an edge's end clamped to it and rebuilt as
// A + (B - A) * 1 rounds off B. Where B is the box corner on the disc's center -- a vertex on a pixel corner, as
// every integer vertex drawn at scale 1 is -- the rebuilt point and B are a rounding apart about the center, and the
// "outside" sector between them subtends any angle: up to half the disc. `M 25 25 L 19 38` with round caps 2 px wide
// would read 0.39 at the pixel off its start for SVG 2's 0.00 (100.5/255).
//
// A crossing past an end IS that end (_coverage.glsl seCircleTri).
//
// (a) THE KERNEL, against float64: op 4 records built as the walk builds them (seDisc, in float32) for the four pixels
//     about a corner holding the disc's center -- the body's direction at 32 angles (the axes and diagonals among
//     them), and a dot; half-widths 0.6 to 3 px -- and op 5 annuli centered there, at 2^-20, 1 and 2^20, each within
//     1.5/255 of the region box-sampled 512 x 512;
// (b) END TO END, the main pass (test/_strokeMainCov.mjs) against SVG 2's shape box-sampled: 2-point lines with round
//     caps, both ends on pixel corners, 8 directions, half-widths 1 to 2.25 px, at 2^-20, 1 and 2^20 -- every pixel
//     whose center lies past an end's plane (the cap's own) within 3/255;
// (c) the clamped rebuild restored, (a) and (b) fail.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, refCov, hasExact } from './_strokeMainCov.mjs';
import { svgInside } from './_strokeShapeRef.mjs';

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
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const importSvg = (await import('../src/svg/importer.js')).default;
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const FIX =
  '  vec2 P = t0 <= 0.0 ? A : (t0 >= 1.0 ? B : A + D * t0), Q = t1 >= 1.0 ? B : (t1 <= 0.0 ? A : A + D * t1);';
ok(GLSL.split(FIX).length === 2, 'a crossing past an end is that end, in the shipped shader text');
const OLD = GLSL.replace(
  '  float s = sqrt(disc), t0 = (-b - s) / a, t1 = (-b + s) / a;\n' + FIX,
  '  float s = sqrt(disc);\n  vec2 P = A + D * clamp((-b - s) / a, 0.0, 1.0), Q = A + D * clamp((-b + s) / a, 0.0, 1.0);',
);
const F = Math.fround,
  SCALES = [2 ** -20, 1, 2 ** 20];

// ---- (a) the kernel ---------------------------------------------------------------------------------------------------
// The box about the fragment, 512 x 512 in float64: the share inside `inside` (a test in pixels relative to the disc's
// center). The region is the same in pixels at every scale, so each is sampled once.
const cache = new Map();
function sampled(key, inside, fx, fy) {
  if (cache.has(key)) return cache.get(key);
  let c = 0;
  for (let j = 0; j < 512; j++)
    for (let i = 0; i < 512; i++)
      if (inside(fx + (i + 0.5) / 512 - 0.5, fy + (j + 0.5) / 512 - 0.5)) c++;
  cache.set(key, c / 262144);
  return c / 262144;
}
function kernel(glsl) {
  const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl });
  const q = [],
    ref = [];
  for (const S of SCALES)
    for (const hw of [0.6, 1, 1.5, 3])
      for (const [fx, fy] of [
        [0.5, 0.5],
        [-0.5, 0.5],
        [-0.5, -0.5],
        [0.5, -0.5],
      ]) {
        // the fragment at (fx, fy) px from the center, the record in em as seDisc writes it in float32
        const qx = F(fx * S),
          qy = F(fy * S),
          r = F(Math.hypot(qx, qy)),
          P = [F(qx / r), F(qy / r), F(r - F(hw * S)), 4];
        for (let k = 0; k <= 32; k++) {
          const u =
            k === 32 ? [0, 0] : [F(Math.cos((k * Math.PI) / 16)), F(Math.sin((k * Math.PI) / 16))];
          q.push({
            k: EMU.K_STROKE_EXACT,
            bb: P,
            ePx: [S, S],
            ex: [u[0], u[1], F(qx * u[0] + qy * u[1]), 0, 1, 0, 0, 1, F(hw * S)],
            GD: [1, 0, 0, 0],
          });
          // the disc, with the body's slab behind the plane through the center normal to u (a dot: the disc alone)
          ref.push(
            sampled(
              `d${hw},${fx},${fy},${k}`,
              (x, y) =>
                x * x + y * y <= hw * hw ||
                (k < 32 && x * u[0] + y * u[1] <= 0 && Math.abs(y * u[0] - x * u[1]) <= hw),
              fx,
              fy,
            ),
          );
        }
        // an arc's annulus (op 5, no sector) centered on the corner: R under and over halfW
        for (const R of [0.3, 1.2]) {
          const D = F(Math.hypot(qx, qy)),
            H = hw * S,
            RS = R * S;
          q.push({
            k: EMU.K_STROKE_EXACT,
            bb: [F(qx / D), F(qy / D), F(D - RS - H), 5],
            ePx: [S, S],
            ex: [F(RS), D, 0, 0, 1, 0, 0, 1, F(H)],
            GD: [1, 0, 0, 0],
          });
          ref.push(
            sampled(
              `a${hw},${fx},${fy},${R}`,
              (x, y) => {
                const rho = Math.hypot(x, y);
                return rho <= R + hw && rho >= R - hw;
              },
              fx,
              fy,
            ),
          );
        }
      }
  const out = emu.run(new Float32Array(4), new Float32Array(4), q);
  let worst = 0,
    bad = 0;
  ref.forEach((v, i) => {
    const e = Math.abs(out[i] - v);
    worst = Math.max(worst, e);
    if (e > 1.5 / 255) bad++;
  });
  return { n: ref.length, bad, worst };
}

// ---- (b) end to end ---------------------------------------------------------------------------------------------------
async function capPixels(glsl, S) {
  const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl }),
    exact = hasExact(glsl);
  let n = 0,
    bad = 0,
    worst = 0,
    at = '';
  for (const hw of [1, 1.5, 2.25])
    for (const d of [
      [14, 0],
      [14, 5],
      [11, 9],
      [7, 13],
      [0, 14],
      [-6, 13],
      [-10, 10],
      [-13, 4],
    ]) {
      const P = [
          [25, 25],
          [25 + d[0], 25 + d[1]],
        ],
        L = Math.hypot(d[0], d[1]),
        t = [d[0] / L, d[1] / L];
      const B = strokeRowsOf(
        await importSvg(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${50 * S}" height="${50 * S}" viewBox="0 0 ${50 * S} ${50 * S}"><g transform="scale(${S})"><path d="M ${P[0].join(' ')} L ${P[1].join(' ')}" fill="none" stroke="#000" stroke-width="${2 * hw}" stroke-linecap="round"/></g></svg>`,
          { preserveViewport: true },
        ),
      );
      const pix = [];
      for (const V of P)
        for (let y = V[1] - 4; y <= V[1] + 4; y++)
          for (let x = V[0] - 4; x <= V[0] + 4; x++) {
            const along = (x + 0.5 - 25) * t[0] + (y + 0.5 - 25) * t[1];
            if (along < 0 || along > L) pix.push([x, y]);
          }
      const cov = mainCov(emu, B, B.rows[0], pix, S, exact);
      pix.forEach(([x, y], i) => {
        const e = Math.abs(
          cov[i] -
            refCov(
              (p) => svgInside(p, P, false, hw, 1, 1, 4),
              (a, b) => [a, b],
              x,
              y,
            ),
        );
        n++;
        if (e > 3 / 255) bad++;
        if (e > worst) {
          worst = e;
          at = `M ${P[0].join(' ')} L ${P[1].join(' ')} hw ${hw} px ${x},${y}: ${cov[i].toFixed(3)}`;
        }
      });
    }
  return { n, bad, worst, at };
}

const k = kernel(GLSL);
ok(
  k.bad === 0,
  `(a) ${k.n} op 4 and op 5 records centered on a pixel corner, at 2^-20, 1 and 2^20: worst ${(k.worst * 255).toFixed(2)}/255 off the region box-sampled`,
);
for (const S of SCALES) {
  const c = await capPixels(GLSL, S);
  ok(
    c.bad === 0,
    `(b) at 2^${Math.log2(S)}: ${c.n} pixels past a round cap's plane, ends on pixel corners: worst ${(c.worst * 255).toFixed(2)}/255 off SVG 2 (${c.at})`,
  );
}
{
  ok(OLD !== GLSL, '(c) the clamped rebuild restored in a copy of the shader text');
  const ko = kernel(OLD),
    co = await capPixels(OLD, 1);
  ok(
    ko.bad > 0 && co.bad > 0,
    `(c) with it the kernel misses on ${ko.bad} of ${ko.n} records (worst ${(ko.worst * 255).toFixed(1)}/255) and the main pass on ${co.bad} cap pixels (worst ${(co.worst * 255).toFixed(1)}/255: ${co.at})`,
  );
}
console.log(
  fail ? `strokeDiscCenterCornerSmoke: ${fail} FAILED` : 'strokeDiscCenterCornerSmoke: all passed',
);
process.exit(fail ? 1 : 0);

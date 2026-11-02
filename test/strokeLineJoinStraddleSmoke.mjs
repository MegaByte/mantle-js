// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeLineJoinStraddleSmoke — a line's body pixel next to a join takes the join's boundary, not its side run on
//.
//
// THE HAZARD. The band walk decides a pixel's coverage from the winning segment's edge record. A pixel whose closest
// feature is a LINE's body must not take that body's side as its only boundary where the pixel box reaches past the
// line's end plane at a join: the boundary there is the JOIN's -- the round join's arc, the bevel's chord, the miter's
// other side, the clip line -- and the side run on past the plane reads as if the join were a miter. On
// `M 6 40 L 12 22 Q 24 22 36 22 L 44 6` that is a round join 5.5/255 over SVG 2's and a bevel 28.6/255 (a pixel center
// exactly on the line's end plane, where the line's body wins the tie), and a line-to-line bevel 12.2/255; over two-line
// joins at 25..155 degrees, bevels up to 57.5/255.
//
// The same at a free ROUND end: a body pixel straddling the cap's plane must not take its side run on past it, as if the
// cap were square (a 2 px stroke at 45 degrees with its end on a pixel corner: 0.83 for SVG 2's 0.81, 5.3/255). And where
// a join's planes all lie wholly beyond the box but one -- a bevel's chord at a pixel corner on the vertex -- the guard
// that keeps a single plane only where it is the distance's must not fall to the ramp (1 for 0.90).
//
// A line's body pixel whose box reaches past an interior end's plane, on the outer side of the turn, takes the
// join's own record (_coverage.glsl seJoinRecord): the disc about the vertex with the body's slab for a round join, and
// otherwise the two OUTER sides (by the turn) with the bevel's chord or the clip line. Each of those planes lies outside
// both segments' rectangles on that side, so the record holds the bodies too; and the guard lets it stand. Past a free
// round end's plane, the cap's disc with the body's slab.
//
// Against SVG 2's stroke shape (test/_strokeShapeRef.mjs svgInside) box-sampled, the main pass's coverage from the
// shipped text (test/_strokeMainCov.mjs), at 2^-20, 1 and 2^20:
// (a) the three named pixels, each within 3/255;
// (b) two-line joins -- round, bevel, miter, miter-clip; turns 25..155 degrees both ways; half-widths 1.5 and 3.2 px;
//     three sub-pixel placements (at 2^-20 and 2^20 three of the turns, one placement) -- every pixel of 13 x 13 about
//     the vertex within 3/255 of SVG 2 wherever the turn is
//     under 130 degrees; at 130 and 155 only the pixels the whole join fits inside (the outer sides, the chord or tip and
//     the inside of the turn in one box, which a two-plane record cannot hold) may be off;
// (d) every vertex on a pixel corner: round caps, round and bevel joins, 8 directions, half-widths 1 to 2.25 px -- every
//     pixel of 13 x 13 about each vertex within 3/255 of SVG 2;
// (c) the join's record removed (the side-only rule), (a) and (b) fail; the cap's disc removed, or the guard's
//     exemption, (d) fails.
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
const HINGE =
  '  if (cr == 0.0 || dot(q, uOut) <= -reach || length(cpV) > 2.0 * reach + max(-dot(q, uOut), 0.0)) return false;';
const CAPD = '          && dot(qC, uC) > -aaEm)\n        seDisc(sP, sQ, qC, uC, halfW);',
  GUARD = 'if (sP.w == 1.0 && !joinRec && abs(';
ok(
  GLSL.split(HINGE).length === 2 && GLSL.split(CAPD).length === 2 && GLSL.split(GUARD).length === 2,
  "the join's record, the round cap's and the guard's exemption for a line body pixel are in the shipped shader text",
);
const JC = { miter: 0, round: 1, bevel: 2, 'miter-clip': 3 };

async function score(glsl, S, full = true) {
  const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl }),
    exact = hasExact(glsl);
  const draw = async (d, join, hw, W) =>
    strokeRowsOf(
      await importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W * S}" height="${W * S}" viewBox="0 0 ${W * S} ${W * S}"><g transform="scale(${S})"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * hw}" stroke-linejoin="${join}" stroke-miterlimit="4"/></g></svg>`,
        { preserveViewport: true },
      ),
    );
  // (a) the three named pixels
  const named = [];
  for (const [d, P, join, px] of [
    [
      'M 6 40 L 12 22 Q 24 22 36 22 L 44 6',
      [
        [6, 40],
        [12, 22],
        [36, 22],
        [44, 6],
      ],
      'round',
      [10, 21],
    ],
    [
      'M 6 40 L 12 22 Q 24 22 36 22 L 44 6',
      [
        [6, 40],
        [12, 22],
        [36, 22],
        [44, 6],
      ],
      'bevel',
      [10, 21],
    ],
    [
      'M 6 40 L 12 22 L 36 22 L 44 6',
      [
        [6, 40],
        [12, 22],
        [36, 22],
        [44, 6],
      ],
      'bevel',
      [37, 22],
    ],
  ]) {
    const B = await draw(d, join, 1.5, 50);
    const c = mainCov(emu, B, B.rows[0], [px], S, exact)[0];
    named.push(
      Math.abs(
        c -
          refCov(
            (p) => svgInside(p, P, false, 1.5, 0, JC[join], 4),
            (a, b) => [a, b],
            px[0],
            px[1],
          ),
      ),
    );
  }
  // (b) two-line joins
  const res = {};
  for (const join of Object.keys(JC)) {
    const r = (res[join] = { n: 0, badMild: 0, badSharp: 0, worst: 0 });
    for (const turn of full ? [25, 50, 80, 100, 130, 155, -40, -120] : [50, 155, -120])
      for (const hw of [1.5, 3.2])
        for (const off of full
          ? [
              [0.13, 0.41],
              [0.52, 0.07],
              [0.77, 0.66],
            ]
          : [[0.77, 0.66]]) {
          const V = [25 + off[0], 25 + off[1]],
            th0 = 0.3,
            th1 = th0 + (turn * Math.PI) / 180,
            f = (p) => p.map((v) => +v.toFixed(6));
          const A = f([V[0] - 14 * Math.cos(th0), V[1] - 14 * Math.sin(th0)]),
            Vf = f(V),
            Bp = f([V[0] + 14 * Math.cos(th1), V[1] + 14 * Math.sin(th1)]);
          const Bw = await draw(
            `M ${A[0]} ${A[1]} L ${Vf[0]} ${Vf[1]} L ${Bp[0]} ${Bp[1]}`,
            join,
            hw,
            50,
          );
          const pix = [];
          for (let y = Math.floor(V[1]) - 6; y <= Math.floor(V[1]) + 6; y++)
            for (let x = Math.floor(V[0]) - 6; x <= Math.floor(V[0]) + 6; x++) pix.push([x, y]);
          const cov = mainCov(emu, Bw, Bw.rows[0], pix, S, exact);
          pix.forEach(([x, y], i) => {
            const e = Math.abs(
              cov[i] -
                refCov(
                  (p) => svgInside(p, [A, Vf, Bp], false, hw, 0, JC[join], 4),
                  (a, b) => [a, b],
                  x,
                  y,
                ),
            );
            r.n++;
            r.worst = Math.max(r.worst, e);
            if (e > 3 / 255) {
              if (Math.abs(turn) < 130) r.badMild++;
              else r.badSharp++;
            }
          });
        }
  }
  return { named, res };
}

// (d) every vertex on a pixel corner (an integer, at scale 1)
async function corners(glsl, S, hws = [1, 1.5, 2.25]) {
  const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl }),
    exact = hasExact(glsl),
    CAPC = { butt: 0, round: 1 };
  const shapes = [],
    dirs = [
      [14, 0],
      [14, 5],
      [11, 9],
      [7, 13],
      [0, 14],
      [-6, 13],
      [-10, 10],
      [-13, 4],
    ];
  for (const hw of hws)
    for (const d of dirs) {
      shapes.push({
        P: [
          [25, 25],
          [25 + d[0], 25 + d[1]],
        ],
        cap: 'round',
        join: 'round',
        hw,
      });
      shapes.push({
        P: [
          [13, 22],
          [25, 25],
          [25 + d[0], 25 + d[1]],
        ],
        cap: 'butt',
        join: 'round',
        hw,
      });
      shapes.push({
        P: [
          [13, 22],
          [25, 25],
          [25 + d[0], 25 + d[1]],
        ],
        cap: 'round',
        join: 'bevel',
        hw,
      });
    }
  let n = 0,
    bad = 0,
    worst = 0,
    at = '';
  for (const sh of shapes) {
    const d = 'M ' + sh.P.map((p) => p.join(' ')).join(' L ');
    const B = strokeRowsOf(
      await importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${50 * S}" height="${50 * S}" viewBox="0 0 ${50 * S} ${50 * S}"><g transform="scale(${S})"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * sh.hw}" stroke-linecap="${sh.cap}" stroke-linejoin="${sh.join}" stroke-miterlimit="4"/></g></svg>`,
        { preserveViewport: true },
      ),
    );
    const seen = new Set(),
      pix = [];
    for (const V of sh.P)
      for (let y = V[1] - 6; y <= V[1] + 6; y++)
        for (let x = V[0] - 6; x <= V[0] + 6; x++)
          if (!seen.has(x + ',' + y)) {
            seen.add(x + ',' + y);
            pix.push([x, y]);
          }
    const cov = mainCov(emu, B, B.rows[0], pix, S, exact);
    pix.forEach(([x, y], i) => {
      const e = Math.abs(
        cov[i] -
          refCov(
            (p) => svgInside(p, sh.P, false, sh.hw, CAPC[sh.cap], JC[sh.join], 4),
            (a, b) => [a, b],
            x,
            y,
          ),
      );
      n++;
      if (e > 3 / 255) bad++;
      if (e > worst) {
        worst = e;
        at = `${d} ${sh.cap}/${sh.join} hw ${sh.hw} px ${x},${y}: ${cov[i].toFixed(3)}`;
      }
    });
  }
  return { n, bad, worst, at };
}

const shipped = {};
for (const S of [2 ** -20, 1, 2 ** 20]) {
  const { named, res } = (shipped[S] = await score(GLSL, S, S === 1));
  ok(
    named.every((e) => e <= 3 / 255),
    `(a) at 2^${Math.log2(S)}: the named pixels, round and bevel at the line-to-quad join and bevel at the line-to-line one: ${named.map((e) => (e * 255).toFixed(2)).join(', ')} /255 off SVG 2 (were 5.5, 28.6, 12.2)`,
  );
  for (const [join, r] of Object.entries(res))
    ok(
      r.badMild === 0 && r.badSharp <= 4,
      `(b) at 2^${Math.log2(S)}, ${join}: ${r.n} pixels about two-line joins; over 3/255 off SVG 2 at turns under 130 degrees ${r.badMild}, at 130 and 155 ${r.badSharp} (the whole join in one box); worst ${(r.worst * 255).toFixed(1)}/255`,
    );
}
for (const S of [2 ** -20, 1, 2 ** 20]) {
  const c = await corners(GLSL, S, S === 1 ? [1, 1.5, 2.25] : [1, 2.25]);
  ok(
    c.bad === 0,
    `(d) at 2^${Math.log2(S)}: ${c.n} pixels about round caps, round and bevel joins on pixel corners: worst ${(c.worst * 255).toFixed(2)}/255 off SVG 2`,
  );
}
{
  const old = GLSL.replace(HINGE, '  return false;');
  const { named, res } = await score(old, 1);
  const bad = Object.values(res).reduce((a, r) => a + r.badMild + r.badSharp, 0),
    now = Object.values(shipped[1].res).reduce((a, r) => a + r.badMild + r.badSharp, 0);
  ok(
    named.filter((e) => e > 3 / 255).length >= 2 && bad > 3 * now,
    `(c) with the record removed: the named pixels ${named.map((e) => (e * 255).toFixed(1)).join(', ')} /255, and ${bad} pixels over 3/255 about the joins (${now} shipped)`,
  );
}
for (const [what, from, to] of [
  [
    "the round cap's disc removed",
    CAPD,
    '          && false)\n        seDisc(sP, sQ, qC, uC, halfW);',
  ],
  ["the guard's exemption removed", GUARD, 'if (sP.w == 1.0 && abs('],
]) {
  const c = await corners(GLSL.replace(from, to), 1, [1, 1.5]);
  ok(
    c.bad > 0,
    `(c) ${what}: ${c.bad} pixels about the corner vertices over 3/255 (worst ${(c.worst * 255).toFixed(1)}/255: ${c.at})`,
  );
}
console.log(fail ? `STROKE-LINE-JOIN-STRADDLE FAIL (${fail})` : 'STROKE-LINE-JOIN-STRADDLE PASS');
process.exit(fail ? 1 : 0);

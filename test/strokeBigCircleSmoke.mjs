// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeBigCircleSmoke — a circle hundreds of pixels across is covered as exactly as a small one (the stroke's exact edge
// records: op 4's round cap, op 5-8's arc band and sectors).
//
// THE HAZARD. strokeExactCov takes a circle's share of the pixel box in closed form (seDiscQuadCut: sectors and
// triangles about the center). The closed form sums terms the size of the circle to get one the size of the box, and
// float32 rounds that sum at the circle's size squared: switching to the tangent plane only past 4096 box reaches
// (2896 px) leaves an arc's band of radius 1000 px 8/255 off, 2000 px 32/255, 2800 px 64/255, and a round cap as wide.
//
// The plane takes over from 256 box reaches when the pixel's normal width bounds the sagitta
// coverage error. Thin/sheared boxes keep the 4096 switch; physical-GPU stress controls check
// that decline separately. This scalar lane uses square boxes.
//
// (a) the band (op 5, no sector) and the sector (op 5, a quarter turn, the box across a ray) about radii 20 to 2800 px,
//     and a round cap's disc (op 4) of those radii, against the region sampled 400 x 400 in float64, at
//     2^-20, 1 and 2^20: within 1/255;
// (b) the 4096 switch restored for square boxes, (a) fails.
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
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler');
  process.exit(0);
}
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
ok(
  (GLSL.match(/if \(seCirclePlaneSafe\(/g) || []).length === 4 &&
    GLSL.includes('reach <= 2.0 * max(abs(dot(u, hx)), abs(dot(u, hy)))'),
  'all four circle-to-plane sites use the normal-width bound',
);
const OLD = GLSL.replace(/256\.0 \* reach/g, '4096.0 * reach');
const F = Math.fround,
  HW = 6,
  RADII = [20, 100, 250, 500, 1000, 2000, 2800];

// The cases, in pixels (scaled by S into em): each a record and its region, sampled once (the region is scale-free).
function cases() {
  const out = [];
  for (const R of RADII)
    for (const e of [-0.4, 0.0, 0.27])
      for (const ang of [0.3, 1.1, 2.2]) {
        const u = [Math.cos(ang), Math.sin(ang)];
        const D = R + HW + e;
        out.push({
          kind: 'band',
          R,
          u,
          D,
          e,
          inside: (x, y) => {
            const r = Math.hypot(x + u[0] * D, y + u[1] * D);
            return r <= R + HW && r >= R - HW;
          },
        });
        // a quarter-turn sector whose start ray passes through the box: the fragment 0.2 px off the ray, inside the band
        const a0 = ang - Math.atan2(0.2, D);
        out.push({
          kind: 'sector',
          R,
          u,
          D,
          e,
          a0,
          sw: Math.PI / 2,
          inside: (x, y) => {
            const px = x + u[0] * D,
              py = y + u[1] * D,
              r = Math.hypot(px, py);
            const th = (((Math.atan2(py, px) - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            return r <= R + HW && r >= R - HW && th <= Math.PI / 2;
          },
        });
        // op 4: a round cap's disc of radius R about V, the body behind the plane through V normal to n2
        const q = [u[0] * (R + e), u[1] * (R + e)],
          n2 = [-u[1], u[0]];
        out.push({
          kind: 'cap',
          R,
          u,
          q,
          n2,
          e,
          inside: (x, y) => {
            const px = x + q[0],
              py = y + q[1];
            return (
              Math.hypot(px, py) <= R ||
              (px * n2[0] + py * n2[1] <= 0 && Math.abs(-px * n2[1] + py * n2[0]) <= R)
            );
          },
        });
      }
  return out;
}
const CASES = cases();
const REF = CASES.map((c) => {
  let n = 0;
  for (let j = 0; j < 400; j++)
    for (let i = 0; i < 400; i++) if (c.inside(-0.5 + (i + 0.5) / 400, -0.5 + (j + 0.5) / 400)) n++;
  return n / 160000;
});

function worst(glsl, S) {
  const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl });
  const q = CASES.map((c) => {
    if (c.kind === 'cap')
      return {
        k: EMU.K_STROKE_EXACT,
        bb: [F(c.u[0]), F(c.u[1]), F(c.e * S), 4],
        ePx: [S, S],
        ex: [
          F(c.n2[0]),
          F(c.n2[1]),
          F((c.q[0] * c.n2[0] + c.q[1] * c.n2[1]) * S),
          0,
          1,
          0,
          0,
          1,
          F(c.R * S),
        ],
        GD: [1, 0, 0, 0],
      };
    return {
      k: EMU.K_STROKE_EXACT,
      bb: [F(c.u[0]), F(c.u[1]), F(c.e * S), c.kind === 'band' ? 5 : 5],
      ePx: [S, S],
      ex: [
        F(c.R * S),
        F(c.D * S),
        c.kind === 'band' ? 0 : F(c.a0),
        c.kind === 'band' ? 0 : F(c.sw),
        1,
        0,
        0,
        1,
        F(HW * S),
      ],
      GD: [1, 0, 0, 0],
    };
  });
  const out = emu.run(new Float32Array(4), new Float32Array(4), q);
  const by = {};
  CASES.forEach((c, i) => {
    const k = `${c.kind} ${c.R}`,
      e = Math.abs(out[i] - REF[i]);
    by[k] = Math.max(by[k] || 0, e);
  });
  const w = Math.max(...Object.values(by)),
    at = Object.entries(by).find(([, v]) => v === w)[0];
  return { w, at };
}
for (const S of [2 ** -20, 1, 2 ** 20]) {
  const r = worst(GLSL, S);
  ok(
    r.w <= 1 / 255,
    `(a) at 2^${Math.log2(S)}: bands, sectors and caps of radius 20 to 2800 px, worst ${(r.w * 255).toFixed(2)}/255 off the region sampled (${r.at})`,
  );
}
{
  const r = worst(OLD, 1);
  ok(
    r.w > 8 / 255,
    `(b) with the switch at 4096 box reaches: worst ${(r.w * 255).toFixed(1)}/255 (${r.at})`,
  );
}
console.log(fail ? `STROKE-BIG-CIRCLE FAIL (${fail})` : 'STROKE-BIG-CIRCLE PASS');
process.exit(fail ? 1 : 0);

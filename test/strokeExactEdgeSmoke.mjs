// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeExactEdgeSmoke — a stroke's cap, join and dash-end edges are exact-area anti-aliased, as its body's are.
//
// THE HAZARD. Where a segment's BODY wins, the coverage takes the exact area of the pixel box cut by that straight edge
// (exactBoxCov). Without a record where a cap, a join or a dash end wins, the coverage would be a RAMP across the
// distance: exact only for an edge on a pixel axis, 30/255 off on a plane at 45 degrees, and on a round cap -- a 2 px
// disc -- 60/255 off.
//
// The walk hands back the winner's EDGE RECORD (_strokeMath.glsl seSide): a butt or square end, a bevel chord, a
// miter-clip line, a dash end is its plane, with its normal; a round cap or join is its disc, with the stroke's slab
// behind the plane through its center. mantle.frag.glsl takes their exact area (_coverage.glsl strokeExactCov): a plane
// by exactBoxCov, a disc by circular-segment areas -- disc n box in closed form, the box clipped to the half-plane and
// each edge's part inside the circle a triangle, outside it a sector -- plus the slab's area behind it, so the tangent
// sides are exact too. A stroke-space row's planes map through its frame, and its disc (an ellipse on screen) is taken
// against the pixel box mapped into stroke space.
//
// (a) THE KERNEL, against float64: strokeExactCov on round-cap records -- discs 0.4 to 400 px across, at every place
//     about the box, conformal and under three frames -- against the same region box-sampled 512 x 512 in float64;
// (b) END TO END, the main pass's coverage (test/_strokeMainCov.mjs: the shipped walk and main()'s choice, in float32)
//     against SVG 2's shape box-sampled, on thick strokes: butt, square and round caps at four angles, bevel, miter-clip
//     and round joins, and butt, square and round dash ends, drawn plain and under scale(2 1.5), at 2^-20, 1 and 2^20 --
//     every pixel partly covered, except those near a CORNER of the outline, where two of its edges cross the box
//     (a butt end meeting its side, a chord's ends, the inside of a turn: the change's part (2) is theirs).
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import * as EMU from './_glslEmu.mjs';
import { hasExact, exactCasePixels } from './_strokeMainCov.mjs';

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation');
  process.exit(0);
}
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const EXACT = hasExact(GLSL);
const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl: GLSL });

// ---- (a) the kernel ---------------------------------------------------------------------------------------------------
{
  if (!EXACT) ok(false, '(a) the text has no strokeExactCov: a round cap takes the ramp');
  else {
    // record: disc of radius r about V (stroke space, relative to the fragment), the slab behind the plane through V with
    // unit normal u; frame N (column-major); em per pixel e. The region, in stroke space: disc n {u.(p - V) >= 0} u
    // {|lateral| <= r, u.(p - V) <= 0}. The pixel box is document space [-e/2, e/2]^2 about the fragment.
    const inRegion = (p, V, u, r) => {
      const d = [p[0] - V[0], p[1] - V[1]],
        al = d[0] * u[0] + d[1] * u[1];
      return al >= 0
        ? d[0] * d[0] + d[1] * d[1] <= r * r
        : Math.abs(-d[0] * u[1] + d[1] * u[0]) <= r;
    };
    const FRAMES = [
      [1, 0, 0, 1],
      [2, 0, 0, 1],
      [1, 0, -0.577350269, 1],
      [1.5, 0.866, -0.5, 2.598],
    ];
    let seed = 0x5eed;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const qs = [],
      want = [];
    for (let k = 0; k < 360; k++) {
      const N = FRAMES[k % FRAMES.length],
        e = [2 ** -20, 1, 2 ** 20][k % 3];
      const r = e * (0.2 * 2 ** (rnd() * 11)); // 0.2 to 400 px
      const a = rnd() * 2 * Math.PI,
        u = [Math.cos(a), Math.sin(a)];
      // the fragment's place: anywhere within 2 px of the circle, either side of the plane
      const b = rnd() * 2 * Math.PI,
        rho = Math.max(0, r + e * (rnd() * 4 - 2));
      const V = [-rho * Math.cos(b), -rho * Math.sin(b)];
      const P = [Math.cos(b), Math.sin(b), rho - r, 4],
        Q = [u[0], u[1], -(V[0] * u[0] + V[1] * u[1]), 0];
      if (rho === 0) continue;
      qs.push({ k: EMU.K_STROKE_EXACT, bb: P, ePx: [e, e], ex: [...Q, ...N, r], GD: [1, 0, 0, 0] });
      const n = 512;
      let c = 0;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const qx = e * ((i + 0.5) / n - 0.5),
            qy = e * ((j + 0.5) / n - 0.5);
          if (inRegion([N[0] * qx + N[2] * qy, N[1] * qx + N[3] * qy], V, u, r)) c++;
        }
      want.push(c / (n * n));
    }
    const got = emu.run(new Float32Array(4), new Float32Array(4), qs);
    let worst = 0,
      at = '';
    got.forEach((g, i) => {
      const d = Math.abs(g - want[i]);
      if (d > worst) {
        worst = d;
        at = `record ${i}: ${g.toFixed(5)} for ${want[i].toFixed(5)}`;
      }
    });
    // 512 x 512 box sampling is itself good to ~1/512 of a pixel per unit of edge crossing it
    ok(
      worst <= 1.5 / 255,
      `(a) the round-cap kernel against float64 over ${got.length} records (discs 0.4 to 400 px across, four frames, three scales): worst ${(worst * 255).toFixed(3)}/255${at ? ' at ' + at : ''}`,
    );
  }
}

// ---- (b) end to end ---------------------------------------------------------------------------------------------------
{
  let worst = 0,
    worstAt = '',
    n = 0,
    over8 = 0;
  for (const S of [2 ** -20, 1, 2 ** 20])
    for (const p of await exactCasePixels(importSvg, emu, EXACT, S)) {
      if (p.corner) continue; // two edges cross the box there: part (2)'s
      n++;
      if (p.e > 8 / 255) over8++;
      if (p.e > worst) {
        worst = p.e;
        worstAt = p.what;
      }
    }
  // the reference is box-sampled 64 x 64: ~1/64 of a pixel per unit of edge crossing the box at worst, far less typically
  ok(
    worst <= 3 / 255,
    `(b) caps, joins and dash ends, plain and framed, at 2^-20, 1 and 2^20: ${n} partly covered pixels clear of the outline's corners, worst ${(worst * 255).toFixed(2)}/255 (bar 3), ${over8} over 8/255 -- ${worstAt}`,
  );
}
console.log(fail ? `STROKE-EXACT-EDGE FAIL (${fail})` : 'STROKE-EXACT-EDGE PASS');
process.exit(fail ? 1 : 0);

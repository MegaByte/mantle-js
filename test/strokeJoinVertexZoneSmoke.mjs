// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeJoinVertexZoneSmoke -- a pixel at the join vertex of a LONG quad or cubic is covered, not half covered.
//
// The curve stroke walk treats a fragment whose closest parameter is within 1e-4 of a segment end as at the end (strokeCapsJoinsDash,
// _strokeMath.glsl), so the zone is 1e-4 of the segment long: 3 px of a 30000 px arm, 0.0004 of a 4 px one. In that zone a join end that ran
// the butt-end rule on the plane BEHIND the fragment as well as ahead of it would misread a pixel a hair behind the vertex, deep inside this
// segment's body and the neighbor's, with the plane as the edge: 0.60-0.66 coverage at the vertex of a long curve at 90 and 120 degrees, every
// join style, the exact and the default program alike (about 128 of 255 on a GPU; lines have their own territory rule). The plane applies only
// ahead of the fragment.
//
// Shader emulation (float32 C++ of the shipped text) against the independent SVG 2 oracle (test/_strokeDashOracle.mjs), a 4 x 4 pixel window
// around the vertex of arms 30000 long, half width 5, so the 3 px zone covers the window's center. Turns of 150 degrees are not asserted: a
// separate difference of the same size at the outer chord (reported).
//   node test/strokeJoinVertexZoneSmoke.mjs [--glsl path.frag.glsl]   (another shader text against the same pins)
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu } from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, hasExact } from './_strokeMainCov.mjs';
import * as O from './_strokeDashOracle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP strokeJoinVertexZoneSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
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
let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const LEN = 30000,
  HW = 5,
  ML = 4,
  R = 2;

for (const mode of ['exact', 'default']) {
  console.log(`${mode} stroke program`);
  const emu = buildGlslEmu(ROOT, { stroke: true, glsl: GLSL, strokeExact: mode === 'exact' });
  const exact = hasExact(GLSL) && mode === 'exact';
  for (const voff of [0.5, 0.6]) {
    // the fragment ON the vertex, and 0.1 px behind it along the first arm
    const V = LEN + voff,
      W = 2 * LEN + 2;
    let cases = 0,
      off = 0,
      worst = '',
      lineOff = 0;
    for (const kind of ['L', 'Q', 'C'])
      for (const join of ['miter', 'bevel', 'round'])
        for (const ang of [60, 90, 120])
          for (const sgn of [1, -1]) {
            const a = (sgn * ang * Math.PI) / 180,
              A = [V - LEN, V],
              Vx = [V, V],
              B = [V + LEN * Math.cos(a), V + LEN * Math.sin(a)];
            const lin = (p, q, k) => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
            let segs, d;
            if (kind === 'L') {
              segs = [
                { t: 'L', p: [A, Vx] },
                { t: 'L', p: [Vx, B] },
              ];
              d = `M${A} L${Vx} L${B}`;
            } else if (kind === 'Q') {
              const m1 = lin(A, Vx, 0.5),
                m2 = lin(Vx, B, 0.5);
              segs = [
                { t: 'Q', p: [A, m1, Vx] },
                { t: 'Q', p: [Vx, m2, B] },
              ];
              d = `M${A} Q${m1} ${Vx} Q${m2} ${B}`;
            } else {
              const a1 = lin(A, Vx, 1 / 3),
                a2 = lin(A, Vx, 2 / 3),
                b1 = lin(Vx, B, 1 / 3),
                b2 = lin(Vx, B, 2 / 3);
              segs = [
                { t: 'C', p: [A, a1, a2, Vx] },
                { t: 'C', p: [Vx, b1, b2, B] },
              ];
              d = `M${A} C${a1} ${a2} ${Vx} C${b1} ${b2} ${B}`;
            }
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * HW}" stroke-linecap="butt" stroke-linejoin="${join}" stroke-miterlimit="${ML}"/></svg>`;
            const b = await importSvg(svg, { preserveViewport: true }),
              Bd = strokeRowsOf(b);
            const pix = [];
            for (let y = Math.floor(V) - R; y < Math.floor(V) + R; y++)
              for (let x = Math.floor(V) - R; x < Math.floor(V) + R; x++) pix.push([x, y]);
            const cov = Array.from(mainCov(emu, Bd, Bd.rows[0], pix, 1, exact));
            const sp = O.wholeSubpaths([{ segs, closed: false }]),
              inside = (p) => O.inside(p, sp, HW, 'butt', join, ML);
            if (kind !== 'L') cases++;
            pix.forEach(([px, py], k) => {
              const o = O.cov(inside, (q) => q, px, py, 4);
              if (Math.abs(o - cov[k]) > 0.3) {
                if (kind === 'L') lineOff++;
                else {
                  off++;
                  if (!worst)
                    worst = `${kind} ${join} turn ${sgn * ang}: emu ${cov[k].toFixed(2)} oracle ${o.toFixed(2)}`;
                }
              }
            });
          }
    check(
      off === 0,
      `vertex at +${voff} px: ${cases} quad/cubic cases, ${off} pixels off the oracle ${worst}`,
    );
    if (lineOff)
      console.log(
        `  info (not asserted) the line control has ${lineOff} pixels off the oracle in the ${mode} program (the miter tip's chord AA; lines take their own territory rule)`,
      );
  }
}
console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);

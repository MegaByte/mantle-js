// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Long arms: fragments within 1e-4 of the segment parameter of a join vertex (the end gate t < 1e-4) are 1e-4 * length from it.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildGlslEmu } from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, hasExact } from './_strokeMainCov.mjs';
import * as O from './_strokeDashOracle.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const x = await import('@xmldom/xmldom');
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;
const { default: importSvg } = await import('../src/svg/importer.js');
const gi = process.argv.indexOf('--glsl');
const GLSL = readFileSync(
  gi > 0 ? process.argv[gi + 1] : path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'),
  'utf8',
);
const DEFAULT = process.env.MODE === 'default';
const emu = buildGlslEmu(ROOT, { stroke: true, glsl: GLSL, strokeExact: !DEFAULT });
const EXACT = hasExact(GLSL) && !DEFAULT;
const LEN = +(process.env.LEN || 3000),
  V = LEN + (+process.env.VOFF || 0.5),
  W = 2 * LEN + 2;
const kinds = (process.env.KINDS || 'L,Q,C').split(','),
  joins = (process.env.JOINS || 'miter,bevel,round,miter-clip').split(','),
  angs = (process.env.ANGS || '30,60,90,120,150').split(',').map(Number);
const R = 6; // window radius in pixels around the vertex
let tot = 0,
  fails = 0,
  worstAll = 0;
for (const kind of kinds)
  for (const join of joins)
    for (const ang of angs)
      for (const sgn of [1, -1]) {
        const a = (sgn * ang * Math.PI) / 180,
          hw = 5,
          ml = 4;
        const A = [V - LEN, V],
          Vx = [V, V],
          Bp = [
            V +
              LEN * Math.cos(Math.PI - ((ang * Math.PI) / 180) * 0 + 0) * 0 +
              LEN * Math.cos(a + Math.PI) * -1,
            V + LEN * Math.sin(a + Math.PI) * -1,
          ];
        // direction out of the vertex rotated by `a` from straight ahead (+x): B = V + LEN*(cos a, sin a) (turn angle a)
        const B = [V + LEN * Math.cos(a), V + LEN * Math.sin(a)];
        let segs, d;
        const L = (p, q) => ({ t: 'L', p: [p, q] });
        if (kind === 'L') {
          segs = [L(A, Vx), L(Vx, B)];
          d = `M${A} L${Vx} L${B}`;
        } else if (kind === 'Q') {
          const m1 = [V - LEN / 2, V],
            m2 = [(V + B[0]) / 2, (V + B[1]) / 2];
          segs = [
            { t: 'Q', p: [A, m1, Vx] },
            { t: 'Q', p: [Vx, m2, B] },
          ];
          d = `M${A} Q${m1} ${Vx} Q${m2} ${B}`;
        } else {
          const c = (u, v, k) => [u[0] + (v[0] - u[0]) * k, u[1] + (v[1] - u[1]) * k];
          const a1 = c(A, Vx, 1 / 3),
            a2 = c(A, Vx, 2 / 3),
            b1 = c(Vx, B, 1 / 3),
            b2 = c(Vx, B, 2 / 3);
          segs = [
            { t: 'C', p: [A, a1, a2, Vx] },
            { t: 'C', p: [Vx, b1, b2, B] },
          ];
          d = `M${A} C${a1} ${a2} ${Vx} C${b1} ${b2} ${B}`;
        }
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * hw}" stroke-linecap="butt" stroke-linejoin="${join}" stroke-miterlimit="${ml}"/></svg>`;
        const b = await importSvg(svg, { preserveViewport: true });
        const Bd = strokeRowsOf(b);
        const pix = [];
        for (let y = Math.floor(V) - R; y < Math.floor(V) + R; y++)
          for (let xx = Math.floor(V) - R; xx < Math.floor(V) + R; xx++) pix.push([xx, y]);
        const cov = Array.from(mainCov(emu, Bd, Bd.rows[0], pix, 1, EXACT));
        const sp = O.wholeSubpaths([{ segs, closed: false }]),
          f = (p) => O.inside(p, sp, hw, 'butt', join, ml);
        let bad = 0,
          worst = 0,
          ex = null;
        pix.forEach(([px, py], k) => {
          const o = O.cov(f, (q) => q, px, py, 4),
            dd = Math.abs(o - cov[k]);
          if (dd > 0.3) {
            bad++;
            if (dd > worst) {
              worst = dd;
              ex = `(${px - V},${py - V}) emu ${cov[k].toFixed(2)} ora ${o.toFixed(2)}`;
            }
          }
        });
        if (process.env.DUMP)
          console.log(
            kind,
            join,
            sgn * ang,
            [
              [-1, 0],
              [-2, 0],
              [0, 0],
              [-1, -1],
            ]
              .map(([dx, dy]) => {
                const k = pix.findIndex(
                  ([px, py]) => px === Math.floor(V) + dx && py === Math.floor(V) + dy,
                );
                return `${dx},${dy}: ${cov[k].toFixed(2)}`;
              })
              .join(' '),
          );
        tot++;
        worstAll = Math.max(worstAll, worst);
        if (bad) {
          fails++;
          console.log(`FAIL ${kind} ${join} turn ${sgn * ang}: ${bad} px, worst ${ex}`);
        }
      }
console.log('LEN', LEN, 'cases', tot, 'fails', fails);

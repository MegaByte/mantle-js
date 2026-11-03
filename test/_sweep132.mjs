// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const DEFAULT = process.env.MODE === 'default';
const emu = buildGlslEmu(ROOT, { stroke: true, glsl: GLSL, strokeExact: !DEFAULT });
const EXACT = hasExact(GLSL) && !DEFAULT;
async function cov(svg, pix) {
  const b = await importSvg(svg, { preserveViewport: true });
  const B = strokeRowsOf(b);
  return B.rows.length ? Array.from(mainCov(emu, B, B.rows[0], pix, 1, EXACT)) : pix.map(() => 0);
}
const L = (a, b) => ({ t: 'L', p: [a, b] });
const fmt = (n) => +n.toPrecision(9);
const args = process.argv.slice(2);
const kinds = args[0] ? args[0].split(',') : ['L'];
let tot = 0,
  fails = 0;
for (const kind of kinds)
  for (const join of ['miter', 'miter-clip', 'bevel', 'round'])
    for (const ang of [0, 30, 60, 90, 120, 150, 170, 179, 179.9, 179.999, 179.99999, 180])
      for (const mlk of ['t-', 't+', '1', '1e16']) {
        if (mlk === '1e16' && join !== 'miter-clip' && join !== 'miter') continue;
        const a = (ang * Math.PI) / 180,
          hw = 5;
        const A = [20, 50],
          V = [50, 50],
          B = [50 + 30 * Math.cos(Math.PI - a), 50 - 30 * Math.sin(Math.PI - a)]; // turn angle a: a=0 straight, 180 reversal
        const B2 = [50 + 30 * Math.cos(a), 50 + 30 * Math.sin(a)];
        const ratio = 1 / Math.cos(a / 2);
        const ml =
          mlk === '1'
            ? 1
            : mlk === '1e16'
              ? 1e16
              : Math.max(1, Math.min(1e6, ratio * (mlk === 't-' ? 0.97 : 1.03)));
        let segs, d;
        if (kind === 'L') {
          segs = [L(A, V), L(V, B2)];
          d = `M${A} L${V} L${B2}`;
        } else if (kind === 'Q') {
          // degree-elevated-ish genuine quads with end tangents along the lines
          const m1 = [35, 50],
            m2 = [50 + 15 * Math.cos(a), 50 + 15 * Math.sin(a)];
          segs = [
            { t: 'Q', p: [A, m1, V] },
            { t: 'Q', p: [V, m2, B2] },
          ];
          d = `M${A} Q${m1} ${V} Q${m2} ${B2}`;
        } else {
          const m1 = [30, 50],
            m1b = [40, 50],
            m2 = [50 + 10 * Math.cos(a), 50 + 10 * Math.sin(a)],
            m2b = [50 + 20 * Math.cos(a), 50 + 20 * Math.sin(a)];
          segs = [
            { t: 'C', p: [A, m1, m1b, V] },
            { t: 'C', p: [V, m2, m2b, B2] },
          ];
          d = `M${A} C${m1} ${m1b} ${V} C${m2} ${m2b} ${B2}`;
        }
        for (const cap of ['butt']) {
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * hw}" stroke-linecap="${cap}" stroke-linejoin="${join}" stroke-miterlimit="${ml}"/></svg>`;
          const pix = [];
          for (let y = 0; y < 100; y++) for (let xx = 0; xx < 100; xx++) pix.push([xx, y]);
          const c = await cov(svg, pix);
          const sp = O.wholeSubpaths([{ segs, closed: false }]);
          const f = (p) => O.inside(p, sp, hw, cap, join, ml);
          const bad = [];
          pix.forEach(([px, py], k) => {
            const o = O.cov(f, (q) => q, px, py, 4);
            if (Math.abs(o - c[k]) > 0.3)
              bad.push(`(${px},${py}) emu ${c[k].toFixed(2)} ora ${o.toFixed(2)}`);
          });
          tot++;
          if (bad.length) {
            fails++;
            console.log(
              `FAIL ${kind} ${join} ang ${ang} ml ${mlk}=${fmt(ml)}: ${bad.length} px  ${bad.slice(0, 2).join('; ')}`,
            );
          }
        }
      }
console.log('cases', tot, 'fails', fails);

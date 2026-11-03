// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildGlslEmu } from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, hasExact } from './_strokeMainCov.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const x = await import('@xmldom/xmldom');
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;
const { default: importSvg } = await import('../src/svg/importer.js');
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const DEFAULT = process.env.MODE === 'default';
const emu = buildGlslEmu(ROOT, {
  stroke: true,
  glsl: GLSL,
  strokeExact: !DEFAULT,
  contract: process.env.MANTLE_EMU_FMA === '1',
});
const EXACT = hasExact(GLSL) && !DEFAULT;
for (const deg of [-120, -90, -60, 120, 60, -150, 150])
  for (const form of ['line', 'quad', 'cubic'])
    for (const join of ['miter', 'bevel'])
      for (const [ml] of [[1], [4]]) {
        const a = (deg * Math.PI) / 180,
          ex = 4 * Math.cos(a),
          ey = 4 * Math.sin(a);
        const d =
          form === 'line'
            ? `M-4 0L0 0L${ex} ${ey}`
            : form === 'quad'
              ? `M-4 0Q-2 0 0 0Q${ex / 2} ${ey / 2} ${ex} ${ey}`
              : `M-4 0C${-8 / 3} 0 ${-4 / 3} 0 0 0C${ex / 3} ${ey / 3} ${(2 * ex) / 3} ${(2 * ey) / 3} ${ex} ${ey}`;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.25 -0.25 0.5 0.5"><path d="${d}" fill="none" stroke="white" stroke-width="2" stroke-linejoin="${join}" stroke-miterlimit="${ml}"/></svg>`;
        const b = await importSvg(svg, { preserveViewport: true });
        const B = strokeRowsOf(b);
        const out = [];
        for (const [ox, oy] of [[-0.5, -0.5]])
          out.push(Array.from(mainCov(emu, B, B.rows[0], [[ox, oy]], 0.5, EXACT))[0]);
        console.log(deg, form, join, ml, out.map((v) => v.toFixed(3)).join(' '));
      }

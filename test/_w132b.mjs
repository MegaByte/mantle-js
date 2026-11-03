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
const emu = buildGlslEmu(ROOT, { stroke: true, glsl: GLSL, strokeExact: !DEFAULT });
const EXACT = hasExact(GLSL) && !DEFAULT;
const deg = +process.argv[2] || -120,
  form = process.argv[3] || 'quad';
const L = +process.argv[4] || 4;
const a = (deg * Math.PI) / 180,
  ex = L * Math.cos(a),
  ey = L * Math.sin(a);
const d =
  form === 'line'
    ? `M${-L} 0L0 0L${ex} ${ey}`
    : form === 'quad'
      ? `M${-L} 0Q${-L / 2} 0 0 0Q${ex / 2} ${ey / 2} ${ex} ${ey}`
      : `M${-L} 0C${(-2 * L) / 3} 0 ${-L / 3} 0 0 0C${ex / 3} ${ey / 3} ${(2 * ex) / 3} ${(2 * ey) / 3} ${ex} ${ey}`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-0.25 -0.25 0.5 0.5"><path d="${d}" fill="none" stroke="white" stroke-width="2" stroke-linejoin="miter" stroke-miterlimit="1"/></svg>`;
const b = await importSvg(svg, { preserveViewport: true });
const B = strokeRowsOf(b);
const out = [];
for (const eps of [0, 1e-5, 1e-3, 1e-2, 0.05, 0.1, 0.2, 0.5, 1])
  for (const [sx, sy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ]) {
    // pixel center at (eps*sx, eps*sy): corner = center/ePx - 0.5
    const cx = (eps * sx) / 0.5 - 0.5,
      cy = (eps * sy) / 0.5 - 0.5;
    const v = mainCov(emu, B, B.rows[0], [[cx, cy]], 0.5, EXACT)[0];
    out.push(`${eps}(${sx},${sy})=${v.toFixed(3)}`);
  }
console.log(deg, form, out.filter((s) => !/=1\.000/.test(s)).join(' ') || 'all 1.000');

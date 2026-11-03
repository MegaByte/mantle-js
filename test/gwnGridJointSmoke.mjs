// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnGridJointSmoke — the GWN occupancy grid's certified polyline is closed at every joint.
//
// Two pieces that meet (pointsMeet) can store their shared vertex a rounding apart: the half-ellipse arcs of
// M10 30 A20 12 30 0 1 50 30 A20 12 30 0 1 10 30 Z, rebuilt from their center form inside scale(2^20), end at
// (50, 29.999999999999996) and start at (50, 30.000000000000007). The grid's exact ray crossing can slip through that
// gap, and every cell centered on y = 30 -- the middle row of a symmetric shape -- then certifies the winding outside
// the fill (pixel centers inside the ellipse read 0 under GWN at 2^20 and 2^-20). So the encoder starts the next
// piece's first sub-chord where the last one ended (its pad grown by the move).
//
// Three two-arc shapes (that ellipse, a circle, a rotated ellipse the other way), imported at 1, 2^-20 and 2^20:
//   (a) every certified grid cell's winding matches the ANALYTIC ellipse at its center;
//   (b) GWN winding-only (float32 emulation of the shader, early exits on) equals the f64 point-in-fill test at every
//       pixel center;
//   (c) the snap has nothing to close: an arc keeps its path's endpoints (segment.js mkArc) and the
//       tree's arc pieces take their outer ends from them, so two arcs meeting at a vertex share its value exactly --
//       (50, 30) is (50, 30) on both sides at every scale -- and the importer without the snap reads (a) and (b) the
//       same. The snap stays, as the guard for a joint some future path might still build a rounding apart.
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, cpSync, rmSync, mkdtempSync } from 'fs';
import { hasCxx, buildGlslEmu, fillShapes, K_GWN, GWN_WIND } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { pointInFill } = await import('../src/hitTest/fillCoverage.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// [start, end, rx, ry, phi]: two arcs from start to end and back, radii exactly half the chord along the axis
const CASES = [
  [[10, 30], [50, 30], 20, 12, 30],
  [[80, 30], [120, 30], 20, 20, 0],
  [[150, 40], [190, 20], 22.360679774997898, 9, -26.56505117707799],
];
const BODY = CASES.map(
  ([a, b, rx, ry, phi]) =>
    `<path d="M${a[0]} ${a[1]} A${rx} ${ry} ${phi} 0 1 ${b[0]} ${b[1]} A${rx} ${ry} ${phi} 0 1 ${a[0]} ${a[1]} Z"/>`,
).join('');
const svgAt = (S) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${200 * S} ${64 * S}"><g transform="scale(${S})">${BODY}</g></svg>`;
// the analytic ellipse each shape is: every case has lambda >= 1 (SVG's out-of-range radii rule), so the center is the
// chord's midpoint and the radii scale by sqrt(lambda)
function inside(ci, x, y) {
  const [a, b, rx, ry, phi] = CASES[ci],
    c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
    t = (phi * Math.PI) / 180;
  const rot = (dx, dy) => [
    Math.cos(t) * dx + Math.sin(t) * dy,
    -Math.sin(t) * dx + Math.cos(t) * dy,
  ];
  const [u0, v0] = rot((a[0] - b[0]) / 2, (a[1] - b[1]) / 2);
  const s = Math.sqrt(Math.max(1, (u0 / rx) ** 2 + (v0 / ry) ** 2));
  const [u, v] = rot(x - c[0], y - c[1]);
  return (u / (rx * s)) ** 2 + (v / (ry * s)) ** 2 < 1;
}
async function check(importSvg) {
  const res = { cellsBad: 0, cells: 0, px: [] };
  for (const lg of [0, -20, 20]) {
    const S = Math.pow(2, lg),
      b = await importSvg(svgAt(S), { preserveViewport: true, gwnTree: true });
    const shapes = fillShapes(b, parseMetaBin, M),
      band = new Float32Array(b.bands),
      curve = new Float32Array(b.curves);
    shapes.forEach((sh, ci) => {
      const g = sh.GD[1] * 4096 + sh.GD[0],
        h = (g + (sh.GD[2] + sh.GD[3] + 2) * 2) * 4;
      const ext = (g + (band[h + 2] | 0) + (band[h + 3] | 0)) * 4,
        gridBase = band[ext + 2] | 0,
        gwh = band[ext + 3] | 0,
        GW = gwh >> 8,
        GH = gwh & 255;
      const bw = sh.bb[2] - sh.bb[0],
        bh = sh.bb[3] - sh.bb[1];
      for (let gy = 0; gy < GH; gy++)
        for (let gx = 0; gx < GW; gx++) {
          const cix = gy * GW + gx,
            cell = (g + gridBase + (cix >> 1)) * 4;
          if (!(band[cell + (cix & 1) * 2 + 1] > 0)) continue;
          res.cells++;
          const cx = (sh.bb[0] + ((gx + 0.5) * bw) / GW) / S,
            cy = (sh.bb[1] + ((gy + 0.5) * bh) / GH) / S;
          if ((band[cell + (cix & 1) * 2] !== 0) !== inside(ci, cx, cy)) res.cellsBad++;
        }
    });
    if (hasCxx()) {
      const emu = buildGlslEmu(ROOT, { defines: GWN_WIND });
      const q = [],
        want = [];
      for (const sh of shapes) {
        const segs = decodeSegs(curve, sh.range.begin, sh.range.end);
        for (let y = Math.floor(sh.bb[1] / S) - 1; y <= Math.ceil(sh.bb[3] / S) + 1; y++)
          for (let x = Math.floor(sh.bb[0] / S) - 1; x <= Math.ceil(sh.bb[2] / S) + 1; x++) {
            q.push({
              k: K_GWN,
              GD: sh.GD,
              bb: sh.bb,
              eo: sh.eo,
              c: [Math.fround((x + 0.5) * S), Math.fround((y + 0.5) * S)],
              ePx: [S, S],
            });
            want.push(pointInFill(segs, (x + 0.5) * S, (y + 0.5) * S, sh.eo) ? 1 : 0);
          }
      }
      const r = emu.run(band, curve, q);
      res.px.push(r.reduce((n, v, i) => n + (v !== want[i] ? 1 : 0), 0));
    }
  }
  return res;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const r = await check(importSvg);
ok(
  r.cells > 300 && r.cellsBad === 0,
  `(a) ${r.cells} certified cells at 1, 2^-20 and 2^20: ${r.cellsBad} with the wrong winding`,
);
if (hasCxx())
  ok(
    r.px.every((n) => n === 0),
    `(b) GWN winding-only matches the point-in-fill test at every pixel center (wrong at 1 / 2^-20 / 2^20: ${r.px.join(' / ')})`,
  );
else console.log('  SKIP (b): no C++ compiler');
{
  const text = readFileSync(path.join(ROOT, 'src/svg/textures.js'), 'utf8');
  const from = 'polySegs[i] = P.e[0]; polySegs[i + 1] = P.e[1]; polySegs[i + 4] += d;';
  if (!text.includes(from)) ok(false, '(c) mutation hinge present: the joint snap');
  else {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'gwnGridJoint-'));
    try {
      cpSync(path.join(ROOT, 'src'), path.join(tmp, 'src'), { recursive: true });
      writeFileSync(path.join(tmp, 'src/svg/textures.js'), text.split(from).join('void d;'));
      const m = await check((await import(path.join(tmp, 'src/svg/importer.js'))).default);
      ok(
        m.cells === r.cells && m.cellsBad === 0 && m.px.every((n, k) => n === r.px[k]),
        `(c) without the snap the grid is the same (${m.cells} cells, ${m.cellsBad} wrong; pixels ${m.px.join(' / ')}): the arcs' shared vertices agree exactly`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

if (fail) {
  console.error(`GWN-GRID-JOINT FAIL (${fail})`);
  process.exit(1);
}
console.log('GWN-GRID-JOINT PASS');

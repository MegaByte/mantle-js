// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrV1GradSmoke.mjs — exercises COLR v1 gradient Paint formats:
// PaintLinearGradient (4), PaintRadialGradient (6), PaintSweepGradient (8)
// plus shared ColorLine + extend modes (PAD / REPEAT / REFLECT).
//
// Fixture (buildColrV1Grad):
//   gid 1 → Linear  p0=(0,0)   p1=(100,0)  p2=(0,100) extend=PAD     (0)
//   gid 2 → Radial  c0=(50,50) r0=0       c1=(50,50) r1=50 extend=REPEAT  (1)
//   gid 3 → Sweep   center=(50,50) start=0° end=180° extend=REFLECT (2)
// All three ColorLines: red(0.0) → green(1.0), α=1.0 each.

import { buildColrTestFont } from './_colrFontFixture.mjs';
import { parseTtfTables } from '../../src/font/ttfTables.js';
import { ColrReader } from '../../src/font/color/colrReader.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}
function approx(a, b, eps = 1e-3) {
  return Math.abs(a - b) < eps;
}

const font = buildColrTestFont({ colrV1Grad: true });
const tables = parseTtfTables(font);
const colr = new ColrReader(tables);

assert(colr.hasColrV1, 'hasColrV1 true');
assert(colr.numBaseGlyphsV1 === 3, `numBaseGlyphsV1 = 3, got ${colr.numBaseGlyphsV1}`);

function checkStops(stops, label) {
  assert(stops.length === 2, `${label}: 2 stops, got ${stops.length}`);
  const s0 = stops[0],
    s1 = stops[1];
  assert(approx(s0.offset, 0.0), `${label} stop[0].offset = 0, got ${s0.offset}`);
  assert(s0.paletteIndex === 0, `${label} stop[0].paletteIndex = 0, got ${s0.paletteIndex}`);
  assert(
    s0.rgba && approx(s0.rgba[0], 1) && approx(s0.rgba[1], 0) && approx(s0.rgba[2], 0),
    `${label} stop[0].rgba ≈ red`,
  );
  assert(approx(s1.offset, 1.0), `${label} stop[1].offset = 1, got ${s1.offset}`);
  assert(s1.paletteIndex === 1, `${label} stop[1].paletteIndex = 1, got ${s1.paletteIndex}`);
  assert(
    s1.rgba && approx(s1.rgba[0], 0) && approx(s1.rgba[1], 1) && approx(s1.rgba[2], 0),
    `${label} stop[1].rgba ≈ green`,
  );
}

// --- gid 1: Linear gradient
{
  const root = colr.getPaint(1);
  assert(root.format === 4, `gid 1 format = 4 (Linear), got ${root.format}`);
  assert(root.p0[0] === 0 && root.p0[1] === 0, `Linear p0 = (0,0), got (${root.p0})`);
  assert(root.p1[0] === 100 && root.p1[1] === 0, `Linear p1 = (100,0), got (${root.p1})`);
  assert(root.p2[0] === 0 && root.p2[1] === 100, `Linear p2 = (0,100), got (${root.p2})`);
  assert(root.extend === 0, `Linear extend = 0 (PAD), got ${root.extend}`);
  checkStops(root.stops, 'Linear');
}

// --- gid 2: Radial gradient
{
  const root = colr.getPaint(2);
  assert(root.format === 6, `gid 2 format = 6 (Radial), got ${root.format}`);
  assert(root.c0[0] === 50 && root.c0[1] === 50, `Radial c0 = (50,50)`);
  assert(root.r0 === 0, `Radial r0 = 0, got ${root.r0}`);
  assert(root.c1[0] === 50 && root.c1[1] === 50, `Radial c1 = (50,50)`);
  assert(root.r1 === 50, `Radial r1 = 50, got ${root.r1}`);
  assert(root.extend === 1, `Radial extend = 1 (REPEAT), got ${root.extend}`);
  checkStops(root.stops, 'Radial');
}

// --- gid 3: Sweep gradient
{
  const root = colr.getPaint(3);
  assert(root.format === 8, `gid 3 format = 8 (Sweep), got ${root.format}`);
  assert(root.center[0] === 50 && root.center[1] === 50, `Sweep center = (50,50)`);
  assert(approx(root.startAngle, 0), `Sweep startAngle ≈ 0°, got ${root.startAngle}`);
  assert(approx(root.endAngle, 180), `Sweep endAngle ≈ 180°, got ${root.endAngle}`);
  assert(root.extend === 2, `Sweep extend = 2 (REFLECT), got ${root.extend}`);
  checkStops(root.stops, 'Sweep');
}

console.log('---');
if (failures) console.error(`COLR-V1-GRAD FAIL (${failures})`);
else console.log('COLR-V1-GRAD PASS');
process.exit(failures ? 1 : 0);

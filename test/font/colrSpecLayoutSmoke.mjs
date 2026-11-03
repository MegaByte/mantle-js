// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrSpecLayoutSmoke.mjs -- the COLRv1 reader against fonts written by an INDEPENDENT writer
// (fontTools.colorLib, committed under test/fixtures/fonts, regenerate with genColrSpecFonts.py), not against the
// hand-rolled test/font/_colrFontFixture.mjs, which can share a wrong layout with the reader.
//   - PaintTransform / PaintVarTransform: Offset24 to an Affine2x3 / VarAffine2x3 (not 24 inline bytes)
//   - PaintVarSolid, PaintVarTranslate, PaintVarScale, PaintVarRotate, PaintVarLinearGradient, PaintVarSkew:
//     field order, varIndexBase and the deltas an ItemVariationStore returns at wght = 1
//   - PaintSkew / PaintSkewAroundCenter graph affine: fontTools' Paint.getTransform(), x' = x - tan(xSkew) y, y' = y + tan(ySkew) x
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { parseTtfTables } from '../../src/font/ttfTables.js';
import { ColrReader } from '../../src/font/color/colrReader.js';
import { colrPaintToGraph } from '../../src/font/color/colrPaintToGraph.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = (n) => {
  const b = new Uint8Array(readFileSync(path.join(HERE, '../fixtures/fonts', n)));
  return new ColrReader(parseTtfTables(b));
};
let bad = 0;
const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e;
const check = (c, m) => {
  if (!c) {
    bad++;
    console.error('FAIL:', m);
  } else console.log('ok:', m);
};
const arrNear = (a, b, e = 1e-4) =>
  Array.isArray(a) && a.length === b.length && a.every((v, i) => near(v, b[i], e));
const fmt = (a) => JSON.stringify(a && a.map ? a.map((v) => +v.toFixed(5)) : a);

// ---- static font: gids start at 2 (A=2 ...), glyph order A B C D E F G H I J K M N O P
const xf = load('colrSpecXf.ttf');
check(xf.hasColrV1, 'static font has COLRv1');
const gid = (ch) => 2 + 'ABCDEFGHIJKMNOP'.indexOf(ch);
const xfPaint = (ch) => xf.getPaint(gid(ch)).child; // PaintTransform & co sit directly under the base glyph (no PaintGlyph for A..P except O)
const t = Math.tan((20 * Math.PI) / 180);
const cases = [
  ['A identity', 'A', [1, 0, 0, 1, 0, 0]],
  ['B translate', 'B', [1, 0, 0, 1, 100, 50]],
  ['C scale', 'C', [0.5, 0, 0, 0.5, 0, 0]],
  ['D rotate 30', 'D', [0.866, 0.5, -0.5, 0.866, 0, 0]],
  ['E shear x', 'E', [1, 0, 0.5, 1, 0, 0]],
  ['F flip', 'F', [-1, 0, 0, 1, 700, 0]],
  ['G general', 'G', [0.8, 0.4, -0.3, 0.9, 100, 50]],
];
for (const [name, ch, exp] of cases) {
  const p = xf.getPaint(gid(ch));
  check(p && p.format === 12, `${name}: root is PaintTransform (format ${p && p.format})`);
  check(p && arrNear(p.affine, exp, 2e-4), `${name}: affine ${fmt(p && p.affine)} == ${fmt(exp)}`);
  check(
    p && p.child && p.child.format === 10 && p.child.child.format === 2,
    `${name}: child is PaintGlyph(PaintSolid)`,
  );
}
const nested = xf.getPaint(gid('P'));
check(
  nested.format === 12 &&
    arrNear(nested.affine, [1, 0, 0, 1, 200, 100]) &&
    nested.child.format === 12 &&
    arrNear(nested.child.affine, [0.5, 0, 0, 0.5, 0, 0]),
  'nested PaintTransform reads both affines',
);

// Skew: the converter's affine follows fontTools Paint.getTransform (COLRv1 angles are counter-clockwise, y up).
const affOf = (ch) =>
  colrPaintToGraph(xf.getPaint(gid(ch)), xf).nodes.find((n) => n.type === 'PaintTransform').params
    .affine;
check(
  arrNear(affOf('J'), [1, 0, -t, 1, 0, 0]),
  `PaintSkew xSkew=+20: ${fmt(affOf('J'))} == xy = -tan(20)`,
);
check(
  arrNear(affOf('K'), [1, t, 0, 1, 0, 0]),
  `PaintSkew ySkew=+20: ${fmt(affOf('K'))} == yx = +tan(20)`,
);
{
  const tx = -Math.tan((20 * Math.PI) / 180),
    ty = Math.tan((-10 * Math.PI) / 180);
  const exp = [1, ty, tx, 1, -tx * 350, -ty * 350];
  check(
    arrNear(affOf('M'), exp, 0.05),
    `PaintSkewAroundCenter(20,-10 @350,350): ${fmt(affOf('M'))} == ${fmt(exp)}`,
  );
}

// ---- variable font
const vf = load('colrSpecVar.ttf');
check(vf.hasColrV1, 'variable font has COLRv1');
const vg = (ch) => 2 + 'ABCDEFG'.indexOf(ch);
const V0 = (ch) => vf.getPaint(vg(ch), null);
const V1 = (ch) => vf.getPaint(vg(ch), [1]);
{
  const d0 = V0('A'),
    d1 = V1('A');
  check(
    arrNear(d0.affine, [1, 0, 0, 1, 100, 0], 2e-4),
    `PaintVarTransform default ${fmt(d0.affine)}`,
  );
  check(
    arrNear(d1.affine, [0.5, 0, 0.25, 1, 150, 25], 2e-4),
    `PaintVarTransform wght=1 ${fmt(d1.affine)} == [0.5,0,0.25,1,150,25]`,
  );
}
{
  const s0 = V0('B').child,
    s1 = V1('B').child;
  check(
    near(s0.alpha, 1) && near(s1.alpha, 0.5),
    `PaintVarSolid alpha ${s0.alpha} -> ${s1.alpha} (0.5)`,
  );
}
{
  const a = V0('C'),
    b = V1('C');
  check(
    a.dx === 100 && a.dy === 50 && b.dx === 140 && b.dy === 20,
    `PaintVarTranslate (${a.dx},${a.dy}) -> (${b.dx},${b.dy}) == (140,20)`,
  );
}
{
  const a = V0('D'),
    b = V1('D');
  check(
    near(a.sx, 1) && near(b.sx, 0.5) && near(b.sy, 0.75),
    `PaintVarScale (${a.sx},${a.sy}) -> (${b.sx},${b.sy}) == (0.5,0.75)`,
  );
}
{
  const a = V0('E'),
    b = V1('E');
  check(
    near(a.angleDeg, 10, 5e-3) && near(b.angleDeg, 55, 5e-3),
    `PaintVarRotate ${a.angleDeg} -> ${b.angleDeg} == 55`,
  );
}
{
  const a = V0('F').child,
    b = V1('F').child;
  check(
    arrNear(a.p0, [0, 0]) && arrNear(a.p1, [500, 0]) && arrNear(a.p2, [0, 500]),
    'PaintVarLinearGradient default points',
  );
  check(
    arrNear(b.p0, [10, 20]) && arrNear(b.p1, [530, 40]) && arrNear(b.p2, [50, 560]),
    `PaintVarLinearGradient wght=1 ${fmt(b.p0)} ${fmt(b.p1)} ${fmt(b.p2)}`,
  );
}
{
  const a = V0('G'),
    b = V1('G');
  check(
    near(a.skewXDeg, 10, 5e-3) && near(a.skewYDeg, 5, 5e-3),
    `PaintVarSkew default (${a.skewXDeg},${a.skewYDeg})`,
  );
  check(
    near(b.skewXDeg, 32.5, 5e-3) && near(b.skewYDeg, 16.25, 5e-3),
    `PaintVarSkew wght=1 (${b.skewXDeg},${b.skewYDeg}) == (32.5,16.25)`,
  );
}
process.exit(bad ? 1 : 0);

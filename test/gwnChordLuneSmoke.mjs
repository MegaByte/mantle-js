// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnChordLuneSmoke — the GWN tree kernel winds a pixel that lies exactly ON a piece's chord correctly.
//
// A quad, cubic or arc piece winds as its chord's crossing (gwnCross) plus a lune term (+-1 between the chord and the
// curve). gwnCross counts a crossing only strictly right of the pixel, so a chord THROUGH the pixel counts nothing, and
// the lune test must side such a pixel by the same on-chord rule. A strict test (`devS * luneAdd > 0`) takes it on neither
// side and an inclusive one (`m >= 0`) on the curve's side regardless; either leaves one of the two terms missing or extra
// there, and the pixel reads outside where it is inside (or the reverse). Integer circles put pixel centers exactly on
// their quarter-chords, along the diagonals, so ordinary art lands on this case often.
//
// Shapes: integer circles (native arcs) with and without an even-odd hole, a quad whose chord is the diagonal x = y, a
// cubic whose chord is too, each as authored and exactly scaled to 2^-20 and 2^20 (test/_glslEmu.mjs scaleFillData):
//   (a) the sweep is not vacuous: pixel centers lying exactly on a piece's chord, by the kernel's own float32 test;
//   (b) GWN winding-only equals the f64 point-in-fill test at every pixel center at least 1.5 px from the outline, and
//       GWN + SDF reads exactly 0 or 1 there, on the same side;
//   (c) mutations: the strict/inclusive lune side tests swapped in, and the on-chord rule reversed, are each caught by (b);
//   (d) band-hard (no tree) agrees with the reference at the same pixels, as a control.
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import {
  hasCxx,
  buildGlslEmu,
  fillShapes,
  scaleFillData,
  K_GWN,
  K_HARD,
  GWN_SDF,
  GWN_WIND,
  AAC_HARD,
} from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP gwnChordLuneSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs, closest } = await import('../src/hitTest/curveGeom.js');
const { pointInFill } = await import('../src/hitTest/fillCoverage.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
  <path d="M100 100 m -60 0 a 60 60 0 1 0 120 0 a 60 60 0 1 0 -120 0 Z"/>
  <path fill-rule="evenodd" d="M260 100 m -70 0 a 70 70 0 1 0 140 0 a 70 70 0 1 0 -140 0 Z M260 100 m -30 0 a 30 30 0 1 0 60 0 a 30 30 0 1 0 -60 0 Z"/>
  <path d="M10 170 Q 60 170 60 120 L 60 195 L 10 195 Z"/>
  <path d="M340 150 C 370 150 390 170 390 200 L 340 200 Z"/>
</svg>`;
const b = await importSvg(SVG, { preserveViewport: true, gwnTree: true });
const shapes = fillShapes(b, parseMetaBin, M);
const band = new Float32Array(b.bands),
  curve = new Float32Array(b.curves);
ok(
  shapes.length === 4 && shapes.every((s) => s.tree),
  `four fill shapes, each with a run tree (${shapes.length})`,
);

// settled pixels: at least 1.5 px from every segment
const far = [],
  all = [];
for (const sh of shapes) {
  const segs = decodeSegs(curve, sh.range.begin, sh.range.end);
  for (let y = Math.floor(sh.bb[1]) - 1; y <= Math.ceil(sh.bb[3]) + 1; y++)
    for (let x = Math.floor(sh.bb[0]) - 1; x <= Math.ceil(sh.bb[2]) + 1; x++) {
      const cx = x + 0.5,
        cy = y + 0.5;
      let d = Infinity;
      for (const s of segs) d = Math.min(d, Math.sqrt(closest(s, cx, cy).d2));
      const q = {
        GD: sh.GD,
        bb: sh.bb,
        eo: sh.eo,
        c: [cx, cy],
        ePx: [1, 1],
        want: pointInFill(segs, cx, cy, sh.eo) ? 1 : 0,
        sh,
      };
      all.push(q);
      if (d >= 1.5) far.push(q);
    }
}
ok(
  far.length > 20000,
  `(b) not vacuous: ${far.length} pixel centers at least 1.5 px from the outline`,
);

// (a) pixel centers exactly on a piece's chord, by gwnChordT's float32 expression
{
  const f = Math.fround;
  let on = 0;
  for (const sh of shapes) {
    const g = sh.GD[1] * 4096 + sh.GD[0],
      bandsX = sh.GD[2] + 1,
      bandsY = sh.GD[3] + 1,
      h = (g + (bandsX + bandsY) * 2) * 4;
    const refBase = band[h + 2] | 0,
      refCount = band[h + 3] | 0;
    for (let i = 0; i < refCount; i++) {
      const R = (g + refBase + i) * 4,
        loc = (band[R + 1] | 0) * 4096 + (band[R] | 0),
        ty = ((band[R + 2] + 0.5) | 0) % 16;
      let A, B;
      if (ty === 4 || ty === 5) {
        A = [curve[loc * 4], curve[loc * 4 + 1]];
        B = [curve[loc * 4 + 2], curve[loc * 4 + 3]];
      } else if (ty === 1) {
        A = [curve[(loc + 1) * 4], curve[(loc + 1) * 4 + 1]];
        B = [curve[(loc + 2) * 4], curve[(loc + 2) * 4 + 1]];
      } else continue;
      for (const q of all) {
        if (q.sh !== sh) continue;
        const ax = f(A[0] - q.c[0]),
          ay = f(A[1] - q.c[1]),
          bx = f(B[0] - q.c[0]),
          by = f(B[1] - q.c[1]);
        if (f(ax * f(by - ay)) - f(ay * f(bx - ax)) !== 0) continue;
        const tp =
          ((q.c[0] - A[0]) * (B[0] - A[0]) + (q.c[1] - A[1]) * (B[1] - A[1])) /
          ((B[0] - A[0]) ** 2 + (B[1] - A[1]) ** 2);
        if (tp > 0 && tp < 1) on++;
      }
    }
  }
  ok(
    on > 200,
    `(a) not vacuous: ${on} pixel centers lie exactly on a quad, cubic or arc piece's chord`,
  );
}

const scaled = (S) => {
  if (S === 1) return { band, curve, qs: far };
  const sc = scaleFillData(band, curve, shapes, S);
  return {
    band: sc.band,
    curve: sc.curve,
    qs: far.map((q) => ({
      ...q,
      bb: q.bb.map((v) => Math.fround(v * S)),
      c: [Math.fround(q.c[0] * S), Math.fround(q.c[1] * S)],
      ePx: [S, S],
    })),
  };
};
const SCALES = [Math.pow(2, -20), 1, Math.pow(2, 20)];
function wrongWith(glsl, defines, k, solid) {
  const emu = buildGlslEmu(ROOT, { defines, glsl });
  let wrong = 0;
  for (const S of SCALES) {
    const d = scaled(S);
    const r = emu.run(
      d.band,
      d.curve,
      d.qs.map((q) => ({ ...q, k })),
    );
    d.qs.forEach((q, i) => {
      if (solid ? r[i] !== q.want : Math.round(r[i]) !== q.want) wrong++;
    });
  }
  return wrong;
}
// ---- (b) ------------------------------------------------------------------------------------------------------------
{
  const w = wrongWith(GLSL, GWN_WIND, K_GWN, true),
    s = wrongWith(GLSL, GWN_SDF, K_GWN, true);
  ok(
    w === 0,
    `(b) GWN winding-only matches the point-in-fill test at every far pixel center at 2^-20, 1 and 2^20 (${w} wrong)`,
  );
  ok(s === 0, `(b) GWN + SDF reads exactly the winding's 0 or 1 there (${s} wrong)`);
}
// ---- (c) ------------------------------------------------------------------------------------------------------------
{
  const swap = (src, from, to) => {
    if (!src.includes(from)) return null;
    return src.split(from).join(to);
  };
  const muts = [
    [
      'the strict/inclusive lune side tests (strict devS for arcs and cubics, inclusive m >= 0 for quads)',
      (src) => {
        let t = swap(src, 'gwnChordSide(E0 - c, E1 - c) * luneAdd > 0.0', 'devS * luneAdd > 0.0');
        return (
          t &&
          swap(
            t,
            'l >= 0.0 && gwnChordSide(P0 - c, P2 - c) * sideP > 0.0 && n_ >= 0.0',
            'l >= 0.0 && m >= 0.0 && n_ >= 0.0',
          )
        );
      },
    ],
    [
      'the on-chord rule reversed',
      (src) =>
        swap(
          src,
          '(dy != 0.0 ? dy : b.x - a.x) > 0.0 ? 1.0 : -1.0',
          '(dy != 0.0 ? dy : b.x - a.x) > 0.0 ? -1.0 : 1.0',
        ),
    ],
  ];
  for (const [name, mutate] of muts) {
    const m = mutate(GLSL);
    if (!m) {
      ok(false, `(c) mutation hinge present: ${name}`);
      continue;
    }
    const w = wrongWith(m, GWN_WIND, K_GWN, true);
    ok(w > 0, `(c) mutation "${name}" is caught: ${w} far pixel centers wrong`);
  }
}
// ---- (d) ------------------------------------------------------------------------------------------------------------
{
  const w = wrongWith(GLSL, AAC_HARD, K_HARD, true);
  ok(w === 0, `(d) control: band-hard matches the reference at the same pixels (${w} wrong)`);
}

if (fail) {
  console.error(`GWN-CHORD-LUNE FAIL (${fail})`);
  process.exit(1);
}
console.log('GWN-CHORD-LUNE PASS');

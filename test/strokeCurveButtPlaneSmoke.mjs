// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCurveButtPlaneSmoke — a curve's free butt end cuts the pixels inside it with the end's own plane, and only where
// that plane is the stroke's boundary.
//
// THE RULES. A curve's body pixel near a free butt end takes the end's plane too: its AA ramp inside the plane (the
// distance) and its record (the exact area). Three things have to hold:
//   * dStart must be Q'(0) as the encoder writes it. dStart = B is Q'(0) only when the closest point is solved from
//     p1; solving the reversed quad (the pixel nearer p3), B is 2 (p2 - p3), the END's handle reversed, and the start's
//     plane would face where the end does;
//   * the plane must not be taken for every body pixel within halfW of the end laterally: a body that folds back passes
//     the end with its returning arm, whose tube covers what the plane would cut (0.62 for 1 at a pixel 0.05 from a
//     returning arm's centerline);
//   * and a body turning with a radius under halfW sweeps its normals beyond the center of curvature BACK across its own
//     end plane: the plane is the boundary only out to that center on the turn's inner side.
//
// So dStart is Q'(0) as the encoder writes it, 2 (p2 - p1); the plane is taken only where the body that won is the end's
// own stretch (its closest point within two box reaches of the end beyond the fragment's depth, in space and along the
// path) and kappa * lateral <= 1 (kappa the path's curvature at the end, seKappa).
//
// Against SVG 2's shape (test/_strokeCurveRef.mjs svgInsideCurve) box-sampled, the main pass (test/_strokeMainCov.mjs),
// on seeded quad chains (makeCurveCases) with free butt ends:
// (a) the pixels each rule decides, at 2^-20, 1 and 2^20: within 3/255;
// (c) each rule removed -- dStart back to B, the own-stretch test, the curvature test -- its pixels fail.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, refCov, hasExact } from './_strokeMainCov.mjs';
import { makeCurveCases, svgInsideCurve } from './_strokeCurveRef.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const importSvg = (await import('../src/svg/importer.js')).default;
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const JN = ['miter', 'round', 'bevel', 'miter-clip', 'arcs'];
const CASES = makeCurveCases().slice(0, 300);

// the rules, and each pixel of the seeded chains it decides: [case, x, y]
const RULES = [
  ["dStart = Q'(0)", [['  vec2 dStart = 2.0 * (p2 - p1);', '  vec2 dStart = B;']], [[142, 8, 11]]],
  [
    "the end's own stretch",
    [
      [
        ' && length(cpF - pStart) <= 2.0 * seR - aOut && length(dStart) * t <= 2.0 * seR - aOut',
        '',
      ],
      [
        ' && length(cpF - pEnd) <= 2.0 * seR - aOut && length(dEnd) * (1.0 - t) <= 2.0 * seR - aOut',
        '',
      ],
    ],
    [
      [8, 9, 8],
      [108, 16, 21],
      [200, 36, 40],
      [228, 10, 24],
    ],
  ],
  [
    'kappa * lateral <= 1',
    [
      [' && kL <= 1.0) endD', ') endD'],
      [' && kL <= 1.0) seAnd', ') seAnd'],
    ],
    [
      [6, 11, 12],
      [68, 23, 16],
      [138, 16, 19],
      [142, 10, 8],
    ],
  ],
];
ok(
  RULES.every(([, subs]) => subs.every(([t]) => GLSL.includes(t))),
  'the three rules are in the shipped shader text',
);

async function score(glsl, S, pixels) {
  const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl }),
    exact = hasExact(glsl),
    out = [];
  for (const [ci, px, py] of pixels) {
    const cs = CASES[ci];
    const ml = Math.max(cs.miterLimit, 1),
      R = cs.halfW * Math.sqrt(ml * ml + 1) + 2;
    let rx0 = Infinity,
      ry0 = Infinity;
    for (const q of cs.Q)
      for (const p of q) {
        rx0 = Math.min(rx0, p[0]);
        ry0 = Math.min(ry0, p[1]);
      }
    const off = [Math.ceil(R + 2 - rx0) + 0.37, Math.ceil(R + 2 - ry0) + 0.61],
      mv = (p) => [p[0] + off[0], p[1] + off[1]];
    let d = '';
    cs.Q.forEach(([p0, p1, p2], k) => {
      const a = mv(p0),
        b = mv(p1),
        c = mv(p2);
      d += (k === 0 ? `M ${a[0]} ${a[1]} ` : '') + `Q ${b[0]} ${b[1]} ${c[0]} ${c[1]} `;
    });
    if (cs.closed) d += 'Z';
    const B = strokeRowsOf(
      await importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${120 * S}" height="${120 * S}" viewBox="0 0 ${120 * S} ${120 * S}"><g transform="scale(${S})"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * cs.halfW}" stroke-linejoin="${JN[cs.joinStyle]}" stroke-linecap="butt" stroke-miterlimit="${cs.miterLimit}"/></g></svg>`,
        { preserveViewport: true },
      ),
    );
    const cov = mainCov(emu, B, B.rows[0], [[px, py]], S, exact)[0];
    const r = refCov(
      (p) =>
        svgInsideCurve(
          [p[0] - off[0], p[1] - off[1]],
          cs.segs,
          cs.closed,
          cs.halfW,
          0,
          cs.joinStyle,
          cs.miterLimit,
        ),
      (a, b) => [a, b],
      px,
      py,
    );
    out.push({ ci, px, py, cov, r, e: Math.abs(cov - r) });
  }
  return out;
}

const all = RULES.flatMap(([, , p]) => p);
ok(
  all.every(([ci]) => CASES[ci].cap === 0),
  'every named pixel is at a free BUTT end of its chain',
);
for (const S of [2 ** -20, 1, 2 ** 20]) {
  const r = await score(GLSL, S, all),
    worst = Math.max(...r.map((x) => x.e));
  ok(
    r.every((x) => x.e <= 3 / 255),
    `(a) at 2^${Math.log2(S)}: ${r.length} pixels the rules decide, worst ${(worst * 255).toFixed(2)}/255 off SVG 2`,
  );
}
for (const [name, subs, pixels] of RULES) {
  const g = subs.reduce((t, [a, b]) => t.split(a).join(b), GLSL);
  const r = await score(g, 1, pixels),
    bad = r.filter((x) => x.e > 3 / 255);
  ok(
    g !== GLSL && bad.length === pixels.length,
    `(c) without ${name}: ${bad.length} of ${pixels.length} pixels over 3/255 (${bad.map((x) => `case ${x.ci} px ${x.px},${x.py} ${x.cov.toFixed(3)} for ${x.r.toFixed(3)}`).join('; ')})`,
  );
}
console.log(fail ? `STROKE-CURVE-BUTT-PLANE FAIL (${fail})` : 'STROKE-CURVE-BUTT-PLANE PASS');
process.exit(fail ? 1 : 0);

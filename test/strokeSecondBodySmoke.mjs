// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeSecondBodySmoke — where a second, NON-ADJACENT body reaches the pixel box, its side joins the winner's.
//
// THE HAZARD. The band walk takes a pixel's coverage from the winning segment's edge record. Keeping only the nearest
// body's drops a second body of the same stroke (a hairpin's far leg, a thin gap between two runs) that also cuts the
// box, and the pixel reads the one body's coverage for SVG 2's union (up to about 105/255 off).
//
// The walk (_coverage.glsl strokeBandAccum: secN / secE) the second-nearest body's plane, where its record is a plain side,
// rides to the walk's epilogue and joins the winner's plain side as the union record (op 3), the exact area of the
// box in either half-plane.
//
// Against SVG 2's shape (test/_strokeShapeRef.mjs svgInside) box-sampled, the main pass (test/_strokeMainCov.mjs):
// (a) hairpins -- a leg out and back, 0.3 to 0.8 px apart (edge to edge), half-widths 0.6 and 1.0, at 2^-20, 1 and 2^20: the pixels
//     between the legs read within the shipped bound of SVG 2;
// (c) with the union removed (the winner alone), the same pixels read worse.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, refCov, hasExact } from './_strokeMainCov.mjs';
import { svgInside } from './_strokeShapeRef.mjs';

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
const UNION =
  '  if (!framed && edgeP.w == 1.0 && secE < aaEm) { edgeQ = vec4(secN, secE, 0.0); edgeP = vec4(edgeP.xyz, 3.0); }\n';
ok(GLSL.split(UNION).length === 2, "the second body's union is in the shipped shader text");

async function score(glsl, S) {
  const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl }),
    exact = hasExact(glsl);
  let n = 0,
    bad = 0,
    worst = 0,
    sum = 0;
  for (const gap of [0.3, 0.5, 0.8])
    for (const hw of [0.6, 1.0])
      for (const off of [
        [0, 0],
        [0.37, 0.19],
      ]) {
        const x0 = 12 + off[0],
          x1 = 36 + off[0],
          y0 = 20 + off[1],
          y1 = y0 + gap + 2 * hw;
        const P = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ];
        const B = strokeRowsOf(
          await importSvg(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${50 * S}" height="${50 * S}" viewBox="0 0 ${50 * S} ${50 * S}"><g transform="scale(${S})"><path d="M ${P.map((p) => p.join(' ')).join(' L ')}" fill="none" stroke="#000" stroke-width="${2 * hw}" stroke-linecap="butt" stroke-linejoin="miter"/></g></svg>`,
            { preserveViewport: true },
          ),
        );
        const pix = [];
        for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y++)
          for (let x = Math.floor(x0) + 4; x <= Math.ceil(x1) - 4; x++) pix.push([x, y]);
        const cov = mainCov(emu, B, B.rows[0], pix, S, exact);
        pix.forEach(([x, y], i) => {
          const e = Math.abs(
            cov[i] -
              refCov(
                (p) => svgInside(p, P, false, hw, 0, 0, 4),
                (a, b) => [a, b],
                x,
                y,
              ),
          );
          n++;
          sum += e;
          if (e > 3 / 255) bad++;
          if (e > worst) worst = e;
        });
      }
  return { n, bad, worst, sum };
}

const R = {};
for (const S of [2 ** -20, 1, 2 ** 20]) {
  R[S] = await score(GLSL, S);
  ok(
    R[S].bad <= 25 && R[S].worst <= 4 / 255,
    `(a) at 2^${Math.log2(S)}: ${R[S].n} px between hairpin legs, ${R[S].bad} over 3/255 (bound 25), worst ${(R[S].worst * 255).toFixed(1)}/255 (bound 4), summed ${(R[S].sum * 255).toFixed(1)}`,
  );
}
const old = GLSL.replace(UNION, '');
const r0 = await score(old, 1);
ok(
  old !== GLSL && r0.bad >= 3 * R[1].bad && r0.worst > 20 / 255,
  `(c) with the winner alone: ${r0.bad} over 3/255 (shipped ${R[1].bad}), worst ${(r0.worst * 255).toFixed(1)}/255`,
);
console.log(fail ? `STROKE-SECOND-BODY FAIL (${fail})` : 'STROKE-SECOND-BODY PASS');
process.exit(fail ? 1 : 0);

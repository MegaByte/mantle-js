// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbZeroRadiusArcSmoke — a zero-radius arc fills on the Loop-Blinn route exactly as its chord.
//
// SVG draws an arc with rx or ry 0 as the straight line between its ends. The importer keeps it as an arc record (a
// half-turn of a degenerate ellipse, for morph topology), and the LB decoder must not turn that into two collinear
// rational quads meeting at the chord's midpoint -- a vertex the line does not have, so the mesh would differ from
// `L`'s and the fill would draw pixels differently at 64 px (up to 0.47 under a rotation). It decodes to the line
// itself:
//   (a) the decoded contours of `A` with a zero radius are the contours of `L`, at 2^-20, 1 and 2^20 and rotated (the
//       coordinates are scaled and turned in the path data, so no transform is involved);
//   (b) the LB draw of each (the whole-LB-pipeline emulator, 64 px) is the draw of `L`, pixel for pixel;
//   (c) a MORPH keeps one topology: toward a real arc, both poses keep the half-turn and the pair builds; between two
//       zero-radius arcs, both poses decode to the line.
// (b) SKIPs without a C++ compiler and clang; (a) and (c) always run.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasLbPipeEmu } from './_lbPipeEmu.mjs';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildMorphBundle } = await import('../src/renderer/lbMorphCore.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

const ARCS = ['A 0 0 0 0 1', 'A 5 0 20 0 0', 'A 0 5 0 0 1'];
const fmt = (v) => +v.toPrecision(12);
/// The test path at scale S, turned by `deg` about (25, 25) S: the transform is applied to the NUMBERS, so the importer
/// sees plain coordinates (radii scale with S; the arc's rotation angle turns with the drawing).
function svgOf(edge, S, deg) {
  const c = Math.cos((deg * Math.PI) / 180),
    s = Math.sin((deg * Math.PI) / 180);
  const P = (x, y) => {
    const u = x - 25,
      v = y - 25;
    return `${fmt(S * (25 + c * u - s * v))} ${fmt(S * (25 + s * u + c * v))}`;
  };
  const e =
    edge === 'L'
      ? `L ${P(10, 10)}`
      : (() => {
          const [, rx, ry, rot, la, sw] = edge.split(' ');
          return `A ${fmt(S * rx)} ${fmt(S * ry)} ${fmt(+rot + deg)} ${la} ${sw} ${P(10, 10)}`;
        })();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(50 * S)} ${fmt(50 * S)}"><path d="M ${P(10, 10)} L ${P(40, 12)} L ${P(38, 40)} ${e} Z" fill="#000"/></svg>`;
}
const contoursOf = async (svg) => {
  const sec = await importSvg(svg, { preserveViewport: true }),
    r = sec.curveRangesByShape[0];
  return { sec, cs: curveRangeToContours(new Float32Array(sec.curves), r.begin, r.end) };
};
const key = (cs) => JSON.stringify(cs.map((c) => c.map((s) => [s.type, s.p1, s.p2, s.p3, s.p4])));

console.log('-- (a) the decoded contours');
{
  let n = 0,
    same = 0;
  for (const S of [2 ** -20, 1, 2 ** 20])
    for (const deg of [0, 30])
      for (const arc of ARCS) {
        const A = await contoursOf(svgOf(arc, S, deg)),
          L = await contoursOf(svgOf('L', S, deg));
        n++;
        if (key(A.cs) === key(L.cs)) same++;
      }
  ok(
    same === n,
    `a zero-radius arc decodes to its chord's contours: ${same} of ${n} (3 arcs x 3 scales x 2 rotations)`,
  );
}

console.log('-- (b) the LB draw');
if (!hasLbPipeEmu()) console.log('  -- skipped: needs a C++17 compiler and clang');
else {
  const { lbScene, renderScene, compositeAlpha } = await import('./_lbPipeScene.mjs');
  const VT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
  const FT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const N = 64;
  const draw = async (svg) => {
    const sc = await lbScene(svg, { N, importOpts: { preserveViewport: true } });
    return compositeAlpha(renderScene(sc, VT, FT).recs, N);
  };
  let cells = 0,
    diff = 0,
    ink = 0;
  for (const deg of [0, 30]) {
    const L = await draw(svgOf('L', 1, deg));
    for (const arc of ARCS) {
      const A = await draw(svgOf(arc, 1, deg));
      cells++;
      for (let k = 0; k < N * N; k++) {
        if (A[k] !== L[k]) diff++;
        ink += A[k];
      }
    }
  }
  ok(
    diff === 0 && ink > 1000,
    `the arc draws as its chord: ${diff} of ${cells * N * N} pixels differ (${cells} draws, ${ink.toFixed(0)} px of ink)`,
  );
}

console.log('-- (c) a morph keeps one topology');
{
  const morph = async (a, b) => {
    const A = await contoursOf(svgOf(a, 1, 0)),
      B = await contoursOf(svgOf(b, 1, 0));
    const pa = parseMetaBin(A.sec.meta, A.sec.metaFloatsPerShape),
      pb = parseMetaBin(B.sec.meta, B.sec.metaFloatsPerShape);
    const res = buildMorphBundle({
      srcCurve: new Float32Array(A.sec.curves),
      dstCurve: new Float32Array(B.sec.curves),
      srcMeta: pa.metaFloats,
      dstMeta: pb.metaFloats,
      metaStride: pa.floatsPerShape,
      ranges: A.sec.curveRangesByShape,
      numShapes: A.sec.numShapes,
    });
    const r = A.sec.curveRangesByShape[0];
    const types = (sec, other) =>
      curveRangeToContours(
        new Float32Array(sec.curves),
        r.begin,
        r.end,
        new Float32Array(other.curves),
      )
        .flat()
        .map((s) => s.type)
        .join('');
    return {
      built: !!(res && res.meshes && res.meshes[0] && !res.hasSlug),
      ta: types(A.sec, B.sec),
      tb: types(B.sec, A.sec),
    };
  };
  const toReal = await morph('A 0 0 0 0 1', 'A 20 20 0 0 1');
  ok(
    toReal.built && toReal.ta === toReal.tb && /4/.test(toReal.ta),
    `zero radius -> a real arc: the pair builds, both poses decode alike (${toReal.ta} / ${toReal.tb})`,
  );
  const both = await morph('A 0 0 0 0 1', 'A 5 0 20 0 0');
  ok(
    both.built && both.ta === both.tb && !/4/.test(both.ta),
    `zero radius -> zero radius: the pair builds on lines (${both.ta} / ${both.tb})`,
  );
}
console.warn = warn;
console.log(fail ? `lbZeroRadiusArcSmoke: ${fail} FAILED` : 'lbZeroRadiusArcSmoke: all passed');
process.exit(fail ? 1 : 0);

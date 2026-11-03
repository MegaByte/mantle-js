// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _morphPairDiag.mjs — which stage of the morph pair build declines, and on which line. No GPU.
//
// The GPU probe (_morphRouteDiag) showed: a circle->ellipse morph routes only with SDF primitives off,
// and a ring->ring or circle->irregular-cubic morph does not route either way. This runs each stage of
// lbMorphCore.buildMorphShape on the same cases, with primitives on and off, and names the `return null`
// in buildLoopBlinnPartitionPair that fired (a line-tagged copy of lbPartitionPair.js, deleted on exit).
//
//   node probes/_morphPairDiag.mjs
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => pathToFileURL(path.join(ROOT, p)).href;

// Line-tagged copy of the pair builder: every `return null` records its source line first.
const PAIR_SRC = path.join(ROOT, 'src/renderer/lbPartitionPair.js');
const TAGGED = path.join(ROOT, 'src/renderer/_diagTaggedPartitionPair.mjs');
const lines = readFileSync(PAIR_SRC, 'utf8').split('\n');
writeFileSync(
  TAGGED,
  lines
    .map((l, i) => l.replace(/return null;/g, `return (globalThis.__pairWhy = ${i + 1}, null);`))
    .join('\n'),
);
process.on('exit', () => {
  try {
    unlinkSync(TAGGED);
  } catch {}
});

const { setSdfPrimitivesEnabled } = await import(R('src/geom/shapeRecognize.js'));
const { default: importSvg } = await import(R('src/svg/importer.js'));
const { parseMetaBin } = await import(R('src/renderer/bundle.js'));
const { curveRangeToContours } = await import(R('src/renderer/loopBlinn.js'));
const { buildEarcutPair, segmentPartitionPairMorph } = await import(
  R('src/renderer/loopBlinnMorph.js')
);
const { buildMorphShape } = await import(R('src/renderer/lbMorphCore.js'));
const { buildLoopBlinnPartitionPair } = await import(pathToFileURL(TAGGED).href);
const { buildLbBundle } = await import(R('src/renderer/lbBuildCore.js'));

const K = 0.5522847498;
const ellipsePath = (cx, cy, rx, ry) =>
  `M ${cx + rx} ${cy} ` +
  `C ${cx + rx} ${cy - K * ry} ${cx + K * rx} ${cy - ry} ${cx} ${cy - ry} ` +
  `C ${cx - K * rx} ${cy - ry} ${cx - rx} ${cy - K * ry} ${cx - rx} ${cy} ` +
  `C ${cx - rx} ${cy + K * ry} ${cx - K * rx} ${cy + ry} ${cx} ${cy + ry} ` +
  `C ${cx + K * rx} ${cy + ry} ${cx + rx} ${cy + K * ry} ${cx + rx} ${cy} Z`;
const svg = (d, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${d}" fill="#3366cc" ${extra}/></svg>`;
const ring = (a, b, c, d) =>
  svg(`${ellipsePath(100, 100, a, b)} ${ellipsePath(100, 100, c, d)}`, 'fill-rule="evenodd"');
const WOBBLE =
  'M100 40 C140 10 170 50 165 100 C160 150 140 170 100 165 C55 160 30 140 35 100 C40 50 60 10 100 40 Z';
const CASES = {
  fast: [svg(ellipsePath(100, 100, 60, 60)), svg(ellipsePath(100, 100, 80, 40))],
  holed: [ring(70, 70, 35, 35), ring(80, 50, 40, 25)],
  flip: [
    svg('M 40 160 L 160 160 L 160 90 C 130 50 70 50 40 90 Z'),
    svg('M 40 160 L 160 160 L 160 90 C 130 120 70 120 40 90 Z'),
  ],
  wobble: [svg(ellipsePath(100, 100, 60, 60)), svg(WOBBLE)],
};

const pose = async (s) => {
  const b = await importSvg(s, { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const cf = new Float32Array(b.curves),
    r = b.curveRangesByShape[0];
  return { b, pm, cf, contours: curveRangeToContours(cf, r.begin, r.end) };
};
const stage = (name, fn) => {
  globalThis.__pairWhy = undefined;
  let v, err;
  try {
    v = fn();
  } catch (e) {
    err = String((e && e.message) || e);
  }
  const why = globalThis.__pairWhy;
  return `${name}=${err ? 'THREW ' + err : v ? 'ok' : 'null'}${!v && why ? ` (lbPartitionPair.js:${why})` : ''}`;
};
const meshInfo = (m) => {
  if (!m) return 'none';
  const cubics = m.cubics || [];
  return (
    `quads ${(m.quads || []).length} (circle ${(m.quads || []).filter((q) => q.circle).length}) cubics ${cubics.length} ` +
    `(no klmn ${cubics.filter((c) => !c.klmn).length}) prim ${m.prim ? JSON.stringify(m.prim).slice(0, 60) : '-'}`
  );
};

for (const sdf of [true, false]) {
  setSdfPrimitivesEnabled(sdf);
  for (const [name, [s, d]] of Object.entries(CASES)) {
    const S = await pose(s),
      D = await pose(d);
    const rule = S.pm.metaFloats[13] > 0.5 ? 'evenodd' : 'nonzero';
    const segTypes = (ct) => ct.map((c) => c.map((g) => g.type).join('')).join('|');
    const st = buildLbBundle({
      curveFloats: S.cf,
      metaFloats: S.pm.metaFloats,
      metaFloatsPerShape: S.pm.floatsPerShape,
      ranges: S.b.curveRangesByShape,
      numShapes: S.b.numShapes,
    });
    const raw = st.raw ? st.raw[0] : null;
    console.log(
      `== ${name}${sdf ? '' : ' (SDF off)'} rule=${rule} src segs ${segTypes(S.contours)} dst segs ${segTypes(D.contours)}`,
    );
    console.log(
      `   static src mesh: ${st.packed && st.packed[0] ? (st.packed[0].slug ? 'SLUG' : st.packed[0].vertexCount + ' verts') : 'none'}; ${meshInfo(raw)}`,
    );
    console.log(
      '   ' +
        [
          stage('earcutPair', () => buildEarcutPair(S.contours, D.contours, rule)),
          stage('partitionPair', () => buildLoopBlinnPartitionPair(S.contours, D.contours, rule)),
          stage('plainRows', () =>
            buildLoopBlinnPartitionPair(S.contours, D.contours, rule, { plainDstRows: true }),
          ),
          stage('segmented', () => segmentPartitionPairMorph(S.contours, D.contours, rule)),
          stage(
            'buildMorphShape',
            () =>
              buildMorphShape(
                S.contours,
                D.contours,
                S.pm.metaFloats,
                D.pm.metaFloats,
                0,
                S.pm.floatsPerShape,
              ).mesh,
          ),
        ].join('  '),
    );
  }
}

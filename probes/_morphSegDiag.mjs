// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _morphSegDiag.mjs — why segmentPartitionPairMorph finds no t-segmentation. No GPU.
//
// Replicates the segmented morph's 24-cell scan (each cell a plain-row partition pair between lerped poses) against a
// line-tagged copy of lbPartitionPair.js, and prints each cell's verdict: `.` for a pair, else the source line of the
// `return null` that declined it. The real function gives up past MORPH_SEG_MAX failing cells.
//
//   node probes/_morphSegDiag.mjs
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
const PAIR_SRC = path.join(ROOT, 'src/renderer/lbPartitionPair.js');
const TAGGED = path.join(ROOT, 'src/renderer/_diagTaggedPartitionPairSeg.mjs');
writeFileSync(
  TAGGED,
  readFileSync(PAIR_SRC, 'utf8')
    .split('\n')
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
const { buildLoopBlinnPartitionPair } = await import(pathToFileURL(TAGGED).href);

const lerpContours = (sc, dc, t) => {
  if (t <= 0) return sc;
  if (t >= 1) return dc;
  const u = 1 - t,
    lp = (a, b) => [a[0] * u + b[0] * t, a[1] * u + b[1] * t];
  return sc.map((cs, ci) =>
    cs.map((ss, si) => {
      const ds = dc[ci][si],
        o = { type: ss.type, p1: lp(ss.p1, ds.p1) };
      if (ss.w != null) o.w = ss.w;
      if (ss.p2) o.p2 = lp(ss.p2, ds.p2);
      if (ss.p3) o.p3 = lp(ss.p3, ds.p3);
      if (ss.p4) o.p4 = lp(ss.p4, ds.p4);
      return o;
    }),
  );
};

const svg = (vb, d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><path d="${d}" fill="#3366cc"/></svg>`;
const A = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const B = 'M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z';
const K = 0.5522847498;
const circle =
  `M 160 100 C 160 ${100 - K * 60} ${100 + K * 60} 40 100 40 C ${100 - K * 60} 40 40 ${100 - K * 60} 40 100 ` +
  `C 40 ${100 + K * 60} ${100 - K * 60} 160 100 160 C ${100 + K * 60} 160 160 ${100 + K * 60} 160 100 Z`;
const WOBBLE =
  'M100 40 C140 10 170 50 165 100 C160 150 140 170 100 165 C55 160 30 140 35 100 C40 50 60 10 100 40 Z';
const CASES = {
  solid: [svg('0 0 40 40', A), svg('0 0 40 40', B)],
  wobble: [svg('0 0 200 200', circle), svg('0 0 200 200', WOBBLE)],
  flip: [
    svg('0 0 200 200', 'M 40 160 L 160 160 L 160 90 C 130 50 70 50 40 90 Z'),
    svg('0 0 200 200', 'M 40 160 L 160 160 L 160 90 C 130 120 70 120 40 90 Z'),
  ],
};
const pose = async (s) => {
  const b = await importSvg(s, { preserveViewport: true });
  const cf = new Float32Array(b.curves),
    r = b.curveRangesByShape[0];
  return curveRangeToContours(cf, r.begin, r.end);
};

const N = 24;
for (const sdf of [true, false]) {
  setSdfPrimitivesEnabled(sdf);
  for (const [name, [s, d]] of Object.entries(CASES)) {
    const sc = await pose(s),
      dc = await pose(d);
    const cells = [];
    let fails = 0;
    for (let i = 0; i < N; i++) {
      globalThis.__pairWhy = undefined;
      let p = null,
        err = null;
      try {
        p = buildLoopBlinnPartitionPair(
          lerpContours(sc, dc, i / N),
          lerpContours(sc, dc, (i + 1) / N),
          'nonzero',
          { plainDstRows: true },
        );
      } catch (e) {
        err = String((e && e.message) || e).slice(0, 60);
      }
      if (p) cells.push('.');
      else {
        fails++;
        cells.push(err ? 'T' : String(globalThis.__pairWhy || '?'));
      }
    }
    console.log(
      `${name}${sdf ? '' : ' (SDF off)'}: ${fails}/${N} cells decline (segmented gives up past 6)  ${cells.join(' ')}`,
    );
  }
}

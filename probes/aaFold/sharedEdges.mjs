// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sharedEdges.mjs -- paint conflation (c): how many boundary segments of one fill paint are exactly a segment of another paint (reversed or
// not, same control points to 1e-6 of the drawing's size)? Those are the shared seams an ownership rule could fix exactly.
//   node probes/aaFold/sharedEdges.mjs --assets a.svg,b.svg
import { readFileSync } from 'fs';
import path from 'path';
const argv = process.argv.slice(2);
const flag = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const TREE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const x = await import(path.join(TREE, '../node_modules/@xmldom/xmldom/lib/index.js'));
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;
console.warn = () => {};
const { default: importSvg } = await import(path.join(TREE, 'src/svg/importer.js'));
const CB = await import(path.join(TREE, 'src/renderer/cpatchBuild.js'));
const { curveRangeToContours } = await import(path.join(TREE, 'src/geom/lbContour.js'));
for (const file of flag('assets').split(',')) {
  const sc = await importSvg(readFileSync(file, 'utf8'), { preserveViewport: true });
  const b = CB.headlessCPatchBundle(sc),
    cf = CB.cpatchCurvePlane(b);
  const gb = sc.globalBBox,
    ext = Math.max(gb[2] - gb[0], gb[3] - gb[1]),
    q = 1e-6 * ext;
  const key = (P) => {
    const f = P.map((p) => Math.round(p[0] / q) + ',' + Math.round(p[1] / q));
    const r = [...f].reverse();
    const a = f.join(';'),
      c = r.join(';');
    return a < c ? a : c;
  };
  const owners = new Map();
  let total = 0,
    totalLen = 0;
  const segs = [];
  for (let s = 0; s < b.curveRangesByShape.length; s++) {
    if (/_stroke$/.test(sc.shapeIds[s] || '')) continue;
    const r = b.curveRangesByShape[s];
    const cs = CB.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
    for (const c of cs)
      for (const g of c) {
        const k = key(g.P);
        const len = Math.hypot(
          g.P[g.P.length - 1][0] - g.P[0][0],
          g.P[g.P.length - 1][1] - g.P[0][1],
        );
        if (!owners.has(k)) owners.set(k, new Set());
        owners.get(k).add(s);
        segs.push({ k, s, len });
        total++;
        totalLen += len;
      }
  }
  let shared = 0,
    sharedLen = 0,
    sameShape = 0;
  for (const g of segs) {
    const o = owners.get(g.k);
    if (o.size > 1) {
      shared++;
      sharedLen += g.len;
    }
  }
  console.log(
    `${path.basename(file)}: segments ${total}, shared with another paint ${shared} (${((100 * shared) / total).toFixed(1)}%), by chord length ${((100 * sharedLen) / totalLen).toFixed(1)}%`,
  );
}

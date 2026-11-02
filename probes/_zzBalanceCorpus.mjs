// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// How many contours across the corpus hand extractCycles a graph that is not a boundary?
import { readFileSync, readdirSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { flattenGraph, scoreFill, extractCycles } from '../src/geom/cpatchGraph.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const files = process.argv.slice(2);
for (const f of files) {
  let shapes = 0,
    badShapes = 0,
    badNodes = 0,
    openCyc = 0,
    cyc = 0;
  const sections = await importSvg(readFileSync(f, 'utf8'));
  const cf = new Float32Array(sections.curves);
  for (const r of sections.curveRangesByShape || []) {
    const cs = curveRangeToContours(
      cf,
      r.begin | 0,
      (r.end != null ? r.end : r.begin + r.count) | 0,
    );
    const list = contoursToConverter(cs || [], null);
    if (!list || !list.length) continue;
    shapes++;
    // Close the contours exactly as pathToCycles does. Reaching flattenGraph directly skips that,
    // and then this reports the arrangement of an OPEN path -- which is the very defect it is
    // supposed to be watching for, so it read 19 open cycles where the pipeline has 12.
    const closed = list.map((c) => {
      const a = segPt(c[0], 0),
        b = segPt(c[c.length - 1], 1);
      return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6
        ? c
        : c.concat([{ t: 'line', P: [b, a] }]);
    });
    const sc = scoreFill(flattenGraph(closed), closed, false);
    const ind = new Map(),
      outd = new Map();
    for (const e of sc.edges) {
      const from = e.leftFilled ? e.a : e.b,
        to = e.leftFilled ? e.b : e.a;
      outd.set(from, (outd.get(from) || 0) + 1);
      ind.set(to, (ind.get(to) || 0) + 1);
    }
    let bad = 0;
    for (const n of new Set([...ind.keys(), ...outd.keys()]))
      if ((ind.get(n) || 0) !== (outd.get(n) || 0)) bad++;
    if (bad) {
      badShapes++;
      badNodes += bad;
    }
    const cc = extractCycles(sc);
    cyc += cc.length;
    for (const c of cc) {
      const a = segPt(c[0], 0),
        b = segPt(c[c.length - 1], 1);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) openCyc++;
    }
  }
  console.log(
    `${f.split('/').pop().padEnd(26)} shapes ${String(shapes).padStart(4)}  ` +
      `unbalanced shapes ${String(badShapes).padStart(3)}  nodes ${String(badNodes).padStart(4)}  ` +
      `cycles ${String(cyc).padStart(4)}  OPEN ${openCyc}`,
  );
}

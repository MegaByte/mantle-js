// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Is the graph extractCycles walks actually a boundary?
//
// scoreFill keeps an edge only when the fill differs across it, and orients it so the filled side
// is on the LEFT. One half-edge per kept edge. If that classification is right, every node has as
// many boundary edges arriving as leaving -- and then ANY greedy walk that always leaves on an
// unused out-edge must return to where it started (the Euler argument). An open cycle therefore
// says either the walk is wrong or the graph is not a boundary; this says which.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { flattenGraph, scoreFill, extractCycles } from '../src/geom/cpatchGraph.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const file = process.argv[2];
const only = process.argv[3] != null ? +process.argv[3] : -1;
const sections = await importSvg(readFileSync(file, 'utf8'));
const cf = new Float32Array(sections.curves);
const ranges = sections.curveRangesByShape || [];
for (let s = 0; s < ranges.length; s++) {
  if (only >= 0 && s !== only) continue;
  const r = ranges[s];
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = contoursToConverter(cs || [], null);
  if (!list || !list.length) continue;
  const g = flattenGraph(list);
  const sc = scoreFill(g, list, false);
  const indeg = new Map(),
    outdeg = new Map();
  for (const e of sc.edges) {
    const from = e.leftFilled ? e.a : e.b;
    const to = e.leftFilled ? e.b : e.a;
    outdeg.set(from, (outdeg.get(from) || 0) + 1);
    indeg.set(to, (indeg.get(to) || 0) + 1);
  }
  const nodes = new Set([...indeg.keys(), ...outdeg.keys()]);
  let bad = 0;
  const detail = [];
  for (const n of nodes) {
    const i = indeg.get(n) || 0,
      o = outdeg.get(n) || 0;
    if (i !== o) {
      bad++;
      const p = sc.nodes[n];
      if (detail.length < 6)
        detail.push(`${n}@(${p[0].toFixed(6)},${p[1].toFixed(6)}) in ${i} out ${o}`);
    }
  }
  const cyc = extractCycles(sc);
  const open = cyc.filter((c) => {
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    return Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6;
  }).length;
  console.log(
    `shape ${s}: ${list.flat().length} curves -> flatten ${g.edges.length} edges, ` +
      `scoreFill ${sc.edges.length}, ${nodes.size} nodes, ${bad} UNBALANCED`,
  );
  if (bad) {
    console.log(`   ${detail.join('\n   ')}`);
    // how far apart are the unbalanced nodes? a sink and a source at the same point is ONE node
    // that failed to merge.
    const un = [...nodes].filter((n) => (indeg.get(n) || 0) !== (outdeg.get(n) || 0));
    for (let i = 0; i < un.length; i++)
      for (let j = i + 1; j < un.length; j++) {
        const a = sc.nodes[un[i]],
          b = sc.nodes[un[j]];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (d < 1e-3) console.log(`   nodes ${un[i]} and ${un[j]} are ${d.toExponential(3)} apart`);
      }
  }
  console.log(
    `   extractCycles -> ${cyc.length} cycles [${cyc.map((c) => c.length).join(',')}], ${open} OPEN`,
  );
}

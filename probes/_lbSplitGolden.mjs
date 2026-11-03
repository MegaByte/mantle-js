// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbSplitGolden.mjs — splitInteriorByCurve parity goldens.
import { writeFileSync } from 'fs';
import { splitInteriorByCurve, _healCand } from '../src/renderer/lbInteriorSplit.js';
import { interiorEdgesFromTriPoints } from '../src/renderer/lbFastMesh.js';
import { _setKeyOrigin, _kox, _koy, _koScale } from '../src/geom/lbContour.js';
import { mkLine, mkQuad } from '../src/primitives/seg.js';

// pin the key origin from a representative contour so JS + C# key identically
_setKeyOrigin([
  [
    mkLine([0, 0], [20, 0]),
    mkLine([20, 0], [20, 20]),
    mkLine([20, 20], [0, 20]),
    mkLine([0, 20], [0, 0]),
  ],
]);
const kox = _kox,
  koy = _koy,
  koScale = _koScale;

const edgeObj = (e) => ({ p1: e.p1, p2: e.p2, nx: e.nx, ny: e.ny });
const arcObj = (a) => ({ a: a.a, ctrl: a.ctrl, b: a.b, sign: a.sign, w: a.w });

function runCase(name, interior, edges, arcs) {
  _healCand.length = 0;
  const chordArcs = new Map(),
    vertexArcs = new Map();
  const key = (p) =>
    Math.round((p[0] - kox) * koScale) * 2097152 + Math.round((p[1] - koy) * koScale);
  for (const arc of arcs || []) {
    const ka = key(arc.a),
      kb = key(arc.b);
    chordArcs.set(ka < kb ? ka + '|' + kb : kb + '|' + ka, arc);
    let la = vertexArcs.get(ka);
    if (!la) vertexArcs.set(ka, (la = []));
    la.push(arc);
    let lb = vertexArcs.get(kb);
    if (!lb) vertexArcs.set(kb, (lb = []));
    lb.push(arc);
  }
  const iEdges = interiorEdgesFromTriPoints(new Float32Array(interior), edges);
  const r = splitInteriorByCurve(
    new Float32Array(interior),
    iEdges,
    chordArcs,
    vertexArcs,
    true,
    edges,
  );
  return {
    name,
    interior,
    edges: edges.map(edgeObj),
    arcs: (arcs || []).map(arcObj),
    solid: Array.from(r.solid),
    solidEdges: r.solidEdges ? Array.from(r.solidEdges) : null,
    solidEdges2: r.solidEdges2 ? Array.from(r.solidEdges2) : null,
    solidEdges3: r.solidEdges3 ? Array.from(r.solidEdges3) : null,
    curveTris: r.curveTris.map((ct) => ({
      tri: Array.from(ct.tri),
      sign: ct.sign,
      w: ct.w,
      tc: Array.from(ct.tc),
    })),
    healCand: _healCand.map((p) => [p[0], p[1]]),
  };
}

// Case A: a square as 2 triangles with 4 straight boundary edges (edge path + crack patch)
const sqInterior = [0, 0, 20, 0, 0, 20, 20, 0, 20, 20, 0, 20];
const mkEdge = (p1, p2, nx, ny) => ({ p1, p2, nx, ny });
const sqEdges = [
  mkEdge([0, 0], [20, 0], 0, -1),
  mkEdge([20, 0], [20, 20], 1, 0),
  mkEdge([20, 20], [0, 20], 0, 1),
  mkEdge([0, 20], [0, 0], -1, 0),
];

// Case B: a triangle whose edge [0,0]-[10,0] is a quad-arc chord (arc ramp path)
const arcInterior = [0, 0, 10, 0, 5, 8];
const theArc = { a: [0, 0], ctrl: [5, -3], b: [10, 0], sign: 1, w: 1 };

const cases = [
  runCase('square-edges', sqInterior, sqEdges, []),
  runCase('arc-chord', arcInterior, [], [theArc]),
];

writeFileSync(
  new URL('../../csharp_tests/lb-parity/goldens/split.json', import.meta.url),
  JSON.stringify({ version: 1, kox, koy, koScale, cases }),
);
console.log(
  'emitted split goldens:',
  cases.map((c) => `${c.name}=${c.solid.length / 6}solid+${c.curveTris.length}curve`).join(' '),
);

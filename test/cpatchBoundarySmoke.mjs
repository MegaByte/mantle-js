// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchBoundarySmoke — the graph extractCycles walks must be a BOUNDARY, and an open subpath must
// be filled as if closed.
//
// scoreFill keeps an edge only where the fill differs across it and orients it filled-side-left, so
// every node has as many boundary edges arriving as leaving. Any walk that always leaves on an
// unused out-edge must then return to where it began. That invariant is what lets extractCycles be
// a greedy tightest-left-turn walk, and three separate things can break it:
//
//   * a crossing entering the graph as TWO nodes, because it is LOCATED to 1e-9 of the pair's
//     extent while nodeOf merges within 1e-11 of the drawing's diagonal -- a sink and a source a
//     micron apart, so the walk dies at one and starts orphaned at the other;
//   * an edge oriented backwards, because scoreFill probes 1e-4 x the midpoint's distance from the
//     ORIGIN off an edge to ask which side is filled, which for a short edge is a point outside its
//     own neighbourhood;
//   * an open subpath never being closed, so the arrangement carries a PATH and not a cycle.
//
// On tiger the three together leave 60 of 316 cycles open and FIFTEEN shapes producing no patches at
// all -- 10.1% of the drawing's ink missing, with nothing reported wrong. The last property below
// catches that, so it is checked against the real asset.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { flattenGraph, scoreFill, extractCycles, pathToCycles } from '../src/geom/cpatchGraph.js';
import { segPt } from '../src/geom/cpatchImplicit.js';
import { example, optionalAsset } from './_assets.mjs';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

const line = (a, b) => ({ t: 'line', P: [a, b] });
const closedCycle = (c) => {
  const a = segPt(c[0], 0),
    b = segPt(c[c.length - 1], 1);
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6;
};
// extractCycles repairs the graph in place, so the degrees are read back AFTER the walk.
const unbalanced = (edges) => {
  const ind = new Map(),
    outd = new Map();
  for (const e of edges) {
    const from = e.leftFilled ? e.a : e.b,
      to = e.leftFilled ? e.b : e.a;
    outd.set(from, (outd.get(from) || 0) + 1);
    ind.set(to, (ind.get(to) || 0) + 1);
  }
  let n = 0;
  for (const k of new Set([...ind.keys(), ...outd.keys()]))
    if ((ind.get(k) || 0) !== (outd.get(k) || 0)) n++;
  return n;
};

// A BOWTIE CROSSES ITSELF, which is the case that made two nodes out of one crossing.
{
  const c = [
    line([0, 0], [100, 100]),
    line([100, 100], [100, 0]),
    line([100, 0], [0, 100]),
    line([0, 100], [0, 0]),
  ];
  const g = flattenGraph([c]);
  const sc = scoreFill(g, [c], false);
  const cyc = extractCycles(sc);
  if (cyc.length >= 1) ok(`self-crossing contour yields cycles (${cyc.length})`);
  else fail('self-crossing contour yielded NO cycles');
  if (unbalanced(sc.edges) === 0) ok('self-crossing contour: every node balances after repair');
  else fail(`self-crossing contour: ${unbalanced(sc.edges)} unbalanced node(s) survived`);
  if (cyc.every(closedCycle)) ok('self-crossing contour: every cycle is closed');
  else fail('self-crossing contour: an OPEN chain came back');
}

// AN OPEN SUBPATH IS FILLED AS IF CLOSED. Three sides of a square, left open by a full 100 units.
{
  const c = [line([0, 0], [100, 0]), line([100, 0], [100, 100])];
  const cyc = pathToCycles([c], false);
  if (cyc.length === 1 && cyc[0].length === 3)
    ok('an open subpath is closed with one straight edge');
  else
    fail(`an open subpath gave ${cyc.length} cycle(s) ${JSON.stringify(cyc.map((x) => x.length))}`);
  if (cyc.length && cyc.every(closedCycle)) ok('the closed subpath comes back as a closed cycle');
  else fail('the closed subpath did not come back closed');
}

// ...BUT A GAP BELOW THE THRESHOLD MUST NOT BECOME A HAIR. A segment shorter than scoreFill's own
// probe distance is classified from outside its neighbourhood and comes back reversed, which is
// exactly how a contour ends up with no cycles.
{
  const c = [line([0, 0], [100, 0]), line([100, 0], [100, 100]), line([100, 100], [1e-9, 1e-9])];
  const cyc = pathToCycles([c], false);
  if (cyc.length === 1 && cyc[0].length === 3)
    ok('a sub-threshold gap is left alone, not hair-closed');
  else fail(`a sub-threshold gap gave ${JSON.stringify(cyc.map((x) => x.length))}, expected [3]`);
}

// THE REAL ASSET. Every shape of tiger must produce at least one cycle: fifteen produced none.
// The synthetic cases above stand on their own, so a checkout without the tiger still runs them --
// but it must not report PASS for this one, hence noteSkip rather than a silent exit 0.
const TIGER = optionalAsset(example('tiger.svg'));
if (TIGER) {
  const sections = await importSvg(readFileSync(TIGER, 'utf8'));
  const cf = new Float32Array(sections.curves);
  let shapes = 0,
    empty = 0,
    open = 0,
    cycles = 0;
  for (const r of sections.curveRangesByShape || []) {
    const cs = curveRangeToContours(
      cf,
      r.begin | 0,
      (r.end != null ? r.end : r.begin + r.count) | 0,
    );
    const list = contoursToConverter(cs || [], null);
    if (!list || !list.length) continue;
    shapes++;
    let cyc = [];
    try {
      cyc = pathToCycles(list, false) || [];
    } catch {
      cyc = [];
    }
    if (!cyc.length) empty++;
    cycles += cyc.length;
    for (const c of cyc) if (!closedCycle(c)) open++;
  }
  if (shapes > 250) ok(`tiger loaded (${shapes} shapes, ${cycles} cycles)`);
  else fail(`tiger loaded only ${shapes} shapes`);
  if (empty === 0) ok('every tiger shape produces at least one cycle');
  else fail(`${empty} tiger shape(s) produced NO cycles`);
  // 12 of 316 fail a GEOMETRIC start-equals-end test, and none of them is an open subpath -- every
  // input contour here has a gap of exactly zero. Ten are seams where the repair merged two nodes
  // that were one crossing: that closes the cycle topologically, since the walk returns to the node
  // it left, but it rewrites node ids rather than moving control points, so the two coordinates at
  // the seam still differ by 1.2e-6 to 3.9e-6. The other two differ by 2e-2, 0.04% of their shape.
  // All of it is far below a pixel; the count is pinned so a real defect cannot hide among it.
  if (open <= 12) ok(`open cycles held at ${open}`);
  else fail(`${open} open cycles, expected at most 12`);
}

console.log('\ncpatchBoundarySmoke: the arrangement hands extractCycles a boundary');
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}

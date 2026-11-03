// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrPaintToGraphSmoke.mjs — verify the COLR paint tree → filter-graph
// DAG converter against the three fixtures from _colrFontFixture.
//
// The simple fixture (gid 1: PaintColrLayers → 2× PaintSolid) maps to:
//   nodes: [
//     { type: 'PaintSolid', rgba: [1,0,0,1] },                 // gid 1's layer 0
//     { type: 'PaintSolid', rgba: [0,1,0,0.5] },               // layer 1
//     { type: 'PaintMerge', inputs: [0, 1] },                  // PaintColrLayers
//   ]
//   rootOut: 2
//
// The rich fixture (gid 1: PaintGlyph → Transform → Layers → 2 solids)
// validates transform normalization and PaintGlyph wrapping.
//
// The gradient fixture validates Linear/Radial/Sweep gradient pass-
// through with stops + extend mode preserved.

import { buildColrTestFont } from './_colrFontFixture.mjs';
import { parseTtfTables } from '../../src/font/ttfTables.js';
import { ColrReader } from '../../src/font/color/colrReader.js';
import { colrPaintToGraph } from '../../src/font/color/colrPaintToGraph.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}
function approx(a, b, eps = 1e-4) {
  return Math.abs(a - b) < eps;
}
function makeReader(opts) {
  const tables = parseTtfTables(buildColrTestFont(opts));
  return new ColrReader(tables);
}

// === Simple fixture: PaintColrLayers → 2× PaintSolid ====================
{
  console.log('--- simple fixture (gid 1) ---');
  const r = makeReader({ colrV1: true });
  const tree = r.getPaint(1);
  const graph = colrPaintToGraph(tree, r);
  assert(graph !== null, 'graph non-null');
  assert(graph.nodes.length === 3, `3 nodes, got ${graph.nodes.length}`);
  assert(graph.rootOut === 2, `rootOut = 2, got ${graph.rootOut}`);
  // Children emit first, parent last (post-order). The two solids come
  // out as nodes 0 and 1; the merge is node 2.
  const [s0, s1, mg] = graph.nodes;
  assert(
    s0.type === 'PaintSolid' && approx(s0.params.rgba[0], 1) && approx(s0.params.rgba[3], 1),
    'node 0 = PaintSolid red α=1',
  );
  assert(
    s1.type === 'PaintSolid' && approx(s1.params.rgba[1], 1) && approx(s1.params.rgba[3], 0.5),
    'node 1 = PaintSolid green α=0.5',
  );
  assert(
    mg.type === 'PaintMerge' && mg.inputs.length === 2 && mg.inputs[0] === 0 && mg.inputs[1] === 1,
    'node 2 = PaintMerge[0, 1]',
  );
}

// === Rich fixture: PaintGlyph → Transform → Layers → 2 solids ===========
{
  console.log('--- rich fixture (gid 1) ---');
  const r = makeReader({ colrV1Rich: true });
  const tree = r.getPaint(1);
  const graph = colrPaintToGraph(tree, r);
  // Post-order: solid red, solid green, merge, transform, glyph.
  assert(graph.nodes.length === 5, `5 nodes, got ${graph.nodes.length}`);
  const types = graph.nodes.map((n) => n.type);
  assert(
    types.join(',') === 'PaintSolid,PaintSolid,PaintMerge,PaintTransform,PaintGlyph',
    `types = PaintSolid,PaintSolid,PaintMerge,PaintTransform,PaintGlyph; got ${types.join(',')}`,
  );
  // Transform affine = [0.5, 0, 0, 0.5, 100, 50] from the fixture
  const xf = graph.nodes[3];
  assert(approx(xf.params.affine[0], 0.5), `transform xx = 0.5, got ${xf.params.affine[0]}`);
  assert(approx(xf.params.affine[3], 0.5), `transform yy = 0.5`);
  assert(approx(xf.params.affine[4], 100), `transform dx = 100`);
  assert(approx(xf.params.affine[5], 50), `transform dy = 50`);
  // PaintGlyph wraps the transform with glyphId=2
  const pg = graph.nodes[4];
  assert(pg.params.glyphId === 2, `PaintGlyph.glyphId = 2, got ${pg.params.glyphId}`);
  assert(pg.inputs[0] === 3, `PaintGlyph input = transform node 3`);
  assert(graph.rootOut === 4, `rootOut = PaintGlyph node 4`);
}

// === Rich fixture (gid 2): PaintColrGlyph(1) inlines glyph 1's tree ====
{
  console.log('--- rich fixture (gid 2: PaintColrGlyph) ---');
  const r = makeReader({ colrV1Rich: true });
  const tree = r.getPaint(2);
  const graph = colrPaintToGraph(tree, r);
  // PaintColrGlyph(1) → recurse into glyph 1's tree → 5-node expansion.
  assert(graph.nodes.length === 5, `PaintColrGlyph inlined to 5 nodes, got ${graph.nodes.length}`);
  const types = graph.nodes.map((n) => n.type);
  assert(types[4] === 'PaintGlyph', 'top-level still PaintGlyph after inlining');
}

// === Rich fixture (gid 3): PaintComposite + PaintRotate ================
{
  console.log('--- rich fixture (gid 3: Composite + Rotate) ---');
  const r = makeReader({ colrV1Rich: true });
  const tree = r.getPaint(3);
  const graph = colrPaintToGraph(tree, r);
  // Post-order: src solid, src rotate (transform), dst solid, composite.
  assert(
    graph.nodes.length === 4,
    `4 nodes (red, rotate, green, composite), got ${graph.nodes.length}`,
  );
  assert(graph.nodes[1].type === 'PaintTransform', 'rotate → PaintTransform');
  // Rotation 45° → cos≈0.7071, sin≈0.7071. Affine = [c, s, -s, c, 0, 0]
  const aff = graph.nodes[1].params.affine;
  assert(approx(aff[0], Math.cos(Math.PI / 4)), `rotate xx ≈ cos(45°), got ${aff[0]}`);
  assert(approx(aff[1], Math.sin(Math.PI / 4)), `rotate yx ≈ sin(45°)`);
  assert(approx(aff[2], -Math.sin(Math.PI / 4)), `rotate xy ≈ -sin(45°)`);
  const comp = graph.nodes[3];
  assert(
    comp.type === 'PaintComposite' && comp.params.mode === 7,
    `composite mode = 7, got ${comp.params.mode}`,
  );
  assert(comp.inputs.length === 2, 'composite has 2 inputs');
}

// === Gradient fixture ===================================================
{
  console.log('--- gradient fixture ---');
  const r = makeReader({ colrV1Grad: true });
  // gid 1: linear
  {
    const g = colrPaintToGraph(r.getPaint(1), r);
    assert(
      g.nodes.length === 1 && g.nodes[0].type === 'PaintLinearGradient',
      'Linear → 1 node, PaintLinearGradient',
    );
    const p = g.nodes[0].params;
    assert(p.extend === 0, 'Linear extend = PAD');
    assert(p.stops.length === 2, 'Linear 2 stops');
  }
  // gid 2: radial
  {
    const g = colrPaintToGraph(r.getPaint(2), r);
    assert(g.nodes[0].type === 'PaintRadialGradient', 'gid 2 → PaintRadialGradient');
    assert(g.nodes[0].params.r1 === 50, 'Radial r1 = 50');
    assert(g.nodes[0].params.extend === 1, 'Radial extend = REPEAT');
  }
  // gid 3: sweep
  {
    const g = colrPaintToGraph(r.getPaint(3), r);
    assert(g.nodes[0].type === 'PaintSweepGradient', 'gid 3 → PaintSweepGradient');
    assert(approx(g.nodes[0].params.endAngle, 180), 'Sweep endAngle ≈ 180');
    assert(g.nodes[0].params.extend === 2, 'Sweep extend = REFLECT');
  }
}

// === Cycle prevention =================================================
{
  console.log('--- cycle prevention ---');
  // Synthesize a fake reader whose getPaint returns a self-referential
  // PaintColrGlyph (gid 1 → PaintColrGlyph(1)). The converter should
  // bail on the second recursion via the cycleStack guard, emitting
  // a transparent placeholder rather than recursing forever.
  const fakeReader = {
    getPaint(gid) {
      if (gid === 1) return { format: 11, glyphId: 1 };
      return null;
    },
  };
  const start = { format: 11, glyphId: 1 };
  const g = colrPaintToGraph(start, fakeReader);
  assert(g !== null, "cycle: graph produced (didn't hang)");
  // Convert outer ColrGlyph(1) → enter cycleStack → recurse into getPaint(1)
  // → see PaintColrGlyph(1) inside → cycleStack already contains 1 →
  // emit transparent placeholder.
  assert(
    g.nodes.length === 1 && g.nodes[0].type === 'PaintSolid' && g.nodes[0].params.rgba[3] === 0,
    'cycle: single transparent placeholder emitted',
  );
}

console.log('---');
if (failures) console.error(`COLR-PAINT-TO-GRAPH FAIL (${failures})`);
else console.log('COLR-PAINT-TO-GRAPH PASS');
process.exit(failures ? 1 : 0);
